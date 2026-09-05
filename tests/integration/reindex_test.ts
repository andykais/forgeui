import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Database } from "@db/sqlite";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import { DATABASE_OPTIONS } from "../../src/db/db.ts";
import type { ReindexResult } from "../../src/outputs/reindex.ts";
import { buildSidecar, serializeSidecar } from "../../src/jobs/sidecar.ts";
import { writeTinyPng } from "../fixtures/png.ts";

const TERMINAL = ["done", "failed", "cancelled"];

async function generate(
  app: TestApp,
  params: Record<string, unknown> = {},
  workflow = "krea2",
): Promise<string> {
  const job = await app.json<{ id: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: workflow,
      params: { prompt: "a granite bowl of figs", ...params },
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

type Row = Record<string, unknown>;

function dump(db: Database, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function snapshot(db: Database) {
  return {
    jobs: dump(
      db,
      `SELECT id, prompt_id, workflow_id, workflow_hash, status, params_json,
              api_graph_json, progress_json, error_json, created_at, started_at,
              finished_at
         FROM jobs ORDER BY id`,
    ),
    outputs: dump(
      db,
      `SELECT id, job_id, path, sidecar_path, kind, width, height, duration_ms,
              sha256, workflow_id, workflow_hash, family, prompt, params_json,
              deleted_at, created_at
         FROM outputs ORDER BY id`,
    ),
    output_models: dump(
      db,
      `SELECT output_id, model_hash, role FROM output_models
        ORDER BY output_id, model_hash, role`,
    ),
    fts: dump(
      db,
      `SELECT outputs.id FROM outputs_fts JOIN outputs
         ON outputs.rowid = outputs_fts.rowid
        WHERE outputs_fts MATCH 'granite' ORDER BY outputs.id`,
    ),
  };
}

/** Columns a sidecar cannot know; §5.2 says a rebuilt job is a `done` row. */
const NOT_IN_SIDECAR = [
  "prompt_id",
  "progress_json",
  "started_at",
  "finished_at",
];

function without(rows: Row[], keys: string[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !keys.includes(key)),
    )
  );
}

Deno.test("reindex rebuilds an identical index from the sidecars on disk", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-reindex-" });
  const app = await startTestApp({ comfy: true, dataDir });
  let before: ReturnType<typeof snapshot>;
  try {
    // Three jobs, one of them writing two files.
    await generate(app, { seed: 1, size: [512, 512] });
    app.fake!.setScenario("multi-output");
    await generate(app, { seed: 2 }, "illustrious");
    app.fake!.setScenario("success");
    await generate(app, { seed: 3, prompt: "a heron in granite reeds" });

    before = snapshot(app.db);
    assertEquals(before.outputs.length, 4);
    assertEquals(before.jobs.length, 3);
    assertEquals(before.fts.length, 4);
  } finally {
    await app.shutdown();
    await app.fake?.close();
  }

  // Throw the index away entirely: it is derived (§7).
  for (const suffix of ["", "-wal", "-shm"]) {
    await Deno.remove(join(dataDir, `app.db${suffix}`)).catch(() => {});
  }

  const reindexRun = await new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "--quiet",
      "reindex",
      "--data-dir",
      dataDir,
    ],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(reindexRun.stdout);
  assertEquals(
    reindexRun.code,
    0,
    `${stdout}${new TextDecoder().decode(reindexRun.stderr)}`,
  );
  assertStringIncludes(stdout, "reindexed 4 outputs from 3 sidecars");
  assertStringIncludes(stdout, "recreated 3 job rows");

  const rebuilt = new Database(join(dataDir, "app.db"), DATABASE_OPTIONS);
  try {
    const after = snapshot(rebuilt);

    // Outputs and their model rows come back byte for byte, including the
    // sha256, which is recomputed from the files rather than read anywhere.
    assertEquals(after.outputs, before!.outputs);
    assertEquals(after.output_models, before!.output_models);
    // …and the full-text index with them.
    assertEquals(after.fts, before!.fts);

    // Jobs come back as `done` rows with everything a sidecar carries.
    assertEquals(
      without(after.jobs, NOT_IN_SIDECAR),
      without(before!.jobs, NOT_IN_SIDECAR),
    );
    for (const job of after.jobs) {
      assertEquals(job.status, "done");
      assertEquals(job.prompt_id, null);
      assertEquals(job.progress_json, null);
      // DURATION survives: started/finished bracket the sidecar's timing.
      const duration = (job.finished_at as number) - (job.started_at as number);
      assert(duration >= 0, "the rebuilt job has a duration");
    }
  } finally {
    rebuilt.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("POST /api/maintenance/reindex is idempotent and follows the disk", async () => {
  await withTestApp(async (app) => {
    const first = await generate(app, { seed: 1 });
    const second = await generate(app, { seed: 2 });

    const once = await app.json<ReindexResult>("/api/maintenance/reindex", {
      method: "POST",
    });
    assertEquals(once.sidecars, 2);
    assertEquals(once.outputs, 2);
    // The job rows are still there, so nothing is recreated.
    assertEquals(once.jobs_created, 0);
    assertEquals(once.removed, []);
    assertEquals(once.errors, []);

    const twice = await app.json<ReindexResult>("/api/maintenance/reindex", {
      method: "POST",
    });
    assertEquals(twice, once);
    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count")).count,
      2,
    );

    // A file removed behind the app's back drops out of the index.
    const detail = await app.json<{ path: string }>(`/api/outputs/${second}-0`);
    await Deno.remove(join(app.paths.root, detail.path));
    const third = await app.json<ReindexResult>("/api/maintenance/reindex", {
      method: "POST",
    });
    assertEquals(third.outputs, 1);
    assertEquals(third.removed, [`${second}-0`]);
    assertEquals(third.errors.length, 1);
    assertStringIncludes(third.errors[0]!.message, "missing");
    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count")).count,
      1,
    );
    assertEquals((await app.fetch(`/api/outputs/${second}-0`)).status, 404);
    assertEquals((await app.fetch(`/api/outputs/${first}-0`)).status, 200);
  }, { comfy: true });
});

Deno.test("reindex picks up outputs the app never saw, hashes and all", async () => {
  await withTestApp(async (app) => {
    // A sidecar and its file, dropped straight into the outputs tree — a
    // restored backup, or a copy from another machine.
    const jobId = "01JIMPORTED0000000000000000";
    const dir = join(app.paths.outputs, "2026", "01", "02");
    await Deno.mkdir(dir, { recursive: true });
    await writeTinyPng(join(dir, `${jobId}-0.png`), { width: 96, height: 64 });
    const sidecar = buildSidecar({
      job_id: jobId,
      created_at: "2026-01-02T03:04:05Z",
      workflow: {
        id: "krea2",
        name: "Flux Krea 2",
        hash: "sha256:deadbeef",
        family: "flux",
        kind: "image",
      },
      params: { prompt: "an imported heron", seed: 5 },
      models: [
        { role: "checkpoint", name: "krea2.safetensors", hash: "sha256:aaa" },
        { role: "lora", name: "grain.safetensors", hash: "sha256:bbb" },
      ],
      api_graph: { "9": { class_type: "SaveImage", inputs: {} } },
      outputs: [{ file: `${jobId}-0.png`, kind: "image" }],
      timing: { total_ms: 4321, nodes: { "9": 4321 } },
    });
    await Deno.writeTextFile(
      join(dir, `${jobId}.json`),
      serializeSidecar(sidecar),
    );

    const result = await app.json<ReindexResult>("/api/maintenance/reindex", {
      method: "POST",
    });
    assertEquals(result.sidecars, 1);
    assertEquals(result.outputs, 1);
    assertEquals(result.jobs_created, 1);
    // Model hashes in a sidecar become discoverability rows (§7).
    assertEquals(result.output_models, 2);

    const row = await app.json<{
      id: string;
      width: number;
      height: number;
      sha256: string;
      prompt: string;
      created_at: number;
      family: string;
      generation_ms: number;
      models: { model_hash: string; role: string }[];
    }>(`/api/outputs/${jobId}-0`);
    assertEquals(row.id, `${jobId}-0`);
    // Dimensions come from the file itself, not from the sidecar's claim.
    assertEquals([row.width, row.height], [96, 64]);
    assertEquals(row.prompt, "an imported heron");
    assertEquals(row.family, "flux");
    assertEquals(row.created_at, Date.parse("2026-01-02T03:04:05Z"));
    assertEquals(row.generation_ms, 4321);
    assertEquals(row.models.map((model) => model.role).sort(), [
      "checkpoint",
      "lora",
    ]);
    assert(row.sha256.length === 64);

    // And it is searchable, so the FTS index was rebuilt with it.
    assertEquals(
      (await app.json<{ outputs: { id: string }[] }>("/api/outputs?q=imported"))
        .outputs.map((output) => output.id),
      [`${jobId}-0`],
    );
  }, { comfy: true });
});

Deno.test("a broken sidecar is reported, and the rest still rebuilds", async () => {
  await withTestApp(async (app) => {
    const good = await generate(app);
    const dir = join(app.paths.outputs, "2026", "01", "03");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "broken.json"), "{ not json");
    await Deno.writeTextFile(
      join(dir, "incomplete.json"),
      JSON.stringify({ app_version: "0.1.0", job_id: "01JBAD" }),
    );

    const result = await app.json<ReindexResult>("/api/maintenance/reindex", {
      method: "POST",
    });
    assertEquals(result.sidecars, 1);
    assertEquals(result.outputs, 1);
    assertEquals(result.errors.length, 2);
    assertStringIncludes(
      result.errors.map((error) => error.message).join(" "),
      "invalid JSON",
    );
    assertEquals((await app.fetch(`/api/outputs/${good}-0`)).status, 200);
  }, { comfy: true });
});

Deno.test("deno task reindex on an empty data dir does nothing loudly", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-reindex-empty-" });
  try {
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["task", "--quiet", "reindex", "--data-dir", dataDir],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 0);
    assertStringIncludes(
      new TextDecoder().decode(run.stdout),
      "reindexed 0 outputs from 0 sidecars",
    );
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});
