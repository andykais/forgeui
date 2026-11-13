import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { exists } from "@std/fs";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import type { ReindexResult } from "../../src/outputs/reindex.ts";

/**
 * `outputs.dir` (§3): the outputs can live outside the data dir, and the
 * database never records where. A stored path says `outputs/…`; the folder
 * that stands for is read at launch. So moving the data dir, or moving the
 * outputs and pointing `outputs.dir` at them, needs no reindex.
 */

const TERMINAL = ["done", "failed", "cancelled"];

async function generate(app: TestApp, seed: number): Promise<string> {
  const job = await app.json<{ id: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: "krea2",
      params: { prompt: "a granite bowl of figs", seed },
    }),
  });
  const deadline = Date.now() + 5000;
  let status = "queued";
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<{ status: string }>(`/api/jobs/${job.id}`)).status;
  }
  assertEquals(status, "done");
  await app.jobs.idle();
  return job.id;
}

interface Listed {
  id: string;
  path: string;
  sidecar_path: string;
  media_url: string;
}

async function listed(app: TestApp): Promise<Listed[]> {
  const page = await app.json<{ outputs: Listed[] }>("/api/outputs?limit=50");
  return page.outputs.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every listed output's media comes back, and its sidecar is readable. */
async function assertServed(app: TestApp, outputs: Listed[]): Promise<void> {
  for (const output of outputs) {
    const media = await app.fetch(output.media_url);
    assertEquals(media.status, 200, output.media_url);
    await media.body?.cancel();
    const detail = await app.json<{ sidecar: unknown; sidecar_error?: string }>(
      `/api/outputs/${output.id}`,
    );
    assert(detail.sidecar, `sidecar of ${output.id}: ${detail.sidecar_error}`);
  }
}

async function reindexOver(app: TestApp): Promise<ReindexResult> {
  return await app.json<ReindexResult>("/api/maintenance/reindex", {
    method: "POST",
  });
}

async function stop(app: TestApp): Promise<void> {
  await app.jobs.idle();
  await app.shutdown();
  await app.fake?.close();
}

Deno.test("outputs.dir puts new outputs outside the data dir, and serves them from there", async () => {
  const outputsDir = await Deno.makeTempDir({ prefix: "forgeui-outputs-" });
  const app = await startTestApp({
    comfy: true,
    files: { "config.yaml": `outputs:\n  dir: ${outputsDir}\n` },
  });
  try {
    assertEquals(app.paths.outputs, outputsDir);
    await generate(app, 1);

    const [output] = await listed(app);
    assert(output);
    // The row is the same shape it always was: `outputs/…`.
    assert(output.path.startsWith("outputs/"), output.path);
    const relative = output.path.slice("outputs/".length);
    assert(await exists(join(outputsDir, relative)));
    assert(await exists(join(outputsDir, output.sidecar_path.slice(8))));
    // Nothing was written where the outputs used to go.
    assertEquals(await exists(join(app.dataDir, "outputs", relative)), false);
    await assertServed(app, [output]);

    const status = await app.json<{ data_dir: string; outputs_dir: string }>(
      "/api/system/status",
    );
    assertEquals(status.data_dir, app.dataDir);
    assertEquals(status.outputs_dir, outputsDir);

    // A rebuild reads the moved folder and lands on the same rows.
    const result = await reindexOver(app);
    assertEquals(result.outputs, 1);
    assertEquals(result.removed, []);
    assertEquals(result.errors, []);
    assertEquals(await listed(app), [output]);

    // Deleting removes the files from where they actually are.
    app.outputs.undoWindowMs = 50;
    const deleted = await app.fetch(`/api/outputs/${output.id}`, {
      method: "DELETE",
    });
    assertEquals(deleted.status, 200);
    await deleted.body?.cancel();
    const deadline = Date.now() + 3000;
    while (await exists(join(outputsDir, relative))) {
      if (Date.now() > deadline) throw new Error("the file was never removed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(
      await exists(join(outputsDir, output.sidecar_path.slice(8))),
      false,
    );
  } finally {
    await app.dispose();
    await Deno.remove(outputsDir, { recursive: true });
  }
});

Deno.test("moving the whole data dir keeps the gallery working without a reindex", async () => {
  const parent = await Deno.makeTempDir({ prefix: "forgeui-move-" });
  const before = join(parent, "before");
  const after = join(parent, "elsewhere", "after");
  try {
    const first = await startTestApp({
      comfy: true,
      dataDir: before,
      keepDataDir: true,
    });
    let outputs: Listed[];
    try {
      await generate(first, 1);
      await generate(first, 2);
      outputs = await listed(first);
      assertEquals(outputs.length, 2);
    } finally {
      await stop(first);
    }

    await Deno.mkdir(join(parent, "elsewhere"));
    await Deno.rename(before, after);

    const second = await startTestApp({
      comfy: true,
      dataDir: after,
      keepDataDir: true,
    });
    try {
      assertEquals(await listed(second), outputs);
      await assertServed(second, outputs);
      // And a reindex, had anyone run one, would change nothing.
      const result = await reindexOver(second);
      assertEquals(result.removed, []);
      assertEquals(await listed(second), outputs);
    } finally {
      await stop(second);
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("moving the outputs and pointing outputs.dir at them needs no reindex", async () => {
  const parent = await Deno.makeTempDir({ prefix: "forgeui-move-outputs-" });
  const dataDir = join(parent, "data");
  const moved = join(parent, "disk", "outputs");
  try {
    // Outputs generated where they have always gone: inside the data dir.
    const first = await startTestApp({
      comfy: true,
      dataDir,
      keepDataDir: true,
    });
    let outputs: Listed[];
    try {
      await generate(first, 1);
      await generate(first, 2);
      outputs = await listed(first);
    } finally {
      await stop(first);
    }

    // Move them by hand, and say where they went.
    await Deno.mkdir(join(parent, "disk"));
    await Deno.rename(join(dataDir, "outputs"), moved);
    const config = await Deno.readTextFile(join(dataDir, "config.yaml"));
    await Deno.writeTextFile(
      join(dataDir, "config.yaml"),
      config.replace(/^outputs:\n {2}dir: null$/m, `outputs:\n  dir: ${moved}`),
    );

    const second = await startTestApp({
      comfy: true,
      dataDir,
      keepDataDir: true,
    });
    try {
      assertEquals(second.paths.outputs, moved);
      // The same rows, unchanged, and every file found at its new place.
      assertEquals(await listed(second), outputs);
      await assertServed(second, outputs);

      // New work goes to the moved folder too.
      await generate(second, 3);
      const now = await listed(second);
      assertEquals(now.length, 3);
      for (const output of now) {
        assert(await exists(join(moved, output.path.slice(8))), output.path);
      }

      const result = await reindexOver(second);
      assertEquals(result.removed, []);
      assertEquals(result.errors, []);
      assertEquals(await listed(second), now);
    } finally {
      await stop(second);
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
