import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";
import type { ModelDetail } from "../../src/models/library.ts";
import type { SampleView } from "../../src/samples/store.ts";
import type { JobRow } from "../../src/db/queries.ts";

/**
 * Samples (§8.3): a file dropped on a model page, and Promote to sample on an
 * output. Both go through the routes; the filesystem is checked afterwards,
 * because "one copy of the bytes" is the point of the hard link.
 */

const CHECKPOINT = "v1-5-pruned-emaonly-fp16.safetensors";
const LORA = "film-grain-35mm.safetensors";

interface Fixtures {
  dir: string;
  argv: string[];
}

async function modelFixtures(): Promise<Fixtures> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-sample-models-" });
  await writeFakeSafetensors(join(dir, "checkpoints", CHECKPOINT), {
    name: "sd15",
  });
  await writeFakeSafetensors(join(dir, "loras", LORA), { name: "grain" });
  return {
    dir,
    argv: [
      "--models-dir",
      `checkpoints=${join(dir, "checkpoints")}`,
      "--models-dir",
      `loras=${join(dir, "loras")}`,
    ],
  };
}

interface Harness {
  app: import("../fixtures/app.ts").TestApp;
  /** Hashes, keyed by filename, once the library has read the files. */
  hashes: Map<string, string>;
}

async function withSamples(
  body: (h: Harness) => Promise<void>,
  options: { comfy?: boolean } = {},
): Promise<void> {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      await app.json("/api/maintenance/rescan-models", { method: "POST" });
      await app.models.idle();
      const listed = await app.json<{ models: ModelDetail[] }>("/api/models");
      const hashes = new Map(
        listed.models.map((model) => [model.filename, model.hash!]),
      );
      await body({ app, hashes });
    }, { argv: fixtures.argv, comfy: options.comfy });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
}

async function upload(
  app: Harness["app"],
  hash: string,
  file: File,
): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  return await app.fetch(`/api/models/${hash}/samples`, {
    method: "POST",
    body: form,
  });
}

function pngFile(name: string, width = 24, height = 16): File {
  const bytes = tinyPng({ width, height, color: [0x6f, 0xb6, 0xc8] });
  return new File([bytes.buffer as ArrayBuffer], name, { type: "image/png" });
}

Deno.test("a dropped file becomes a sample with its own sidecar", async () => {
  await withSamples(async ({ app, hashes }) => {
    const hash = hashes.get(LORA)!;
    const response = await upload(app, hash, pngFile("reference.png", 24, 16));
    assertEquals(response.status, 201);
    const sample = await response.json() as SampleView;

    assertEquals(sample.model_hash, hash);
    // Kind and size come from the bytes, not from the name (§14.1).
    assertEquals(sample.kind, "image");
    assertEquals(sample.source_url, null);
    assertEquals(sample.path, `samples/${hash}/${sample.id}.png`);
    assertEquals(
      sample.media_url,
      `/api/media/samples/${hash}/${sample.id}.png`,
    );
    // Nothing to reuse: a dropped file has no generation behind it (§8.3).
    assertEquals(sample.reusable, false);
    assertEquals(sample.params, null);

    // The bytes are where the row says, and the media route serves them.
    const media = await app.fetch(sample.media_url);
    assertEquals(media.status, 200);
    assertEquals(media.headers.get("content-type"), "image/png");
    assertEquals(
      (await media.arrayBuffer()).byteLength,
      (await Deno.stat(join(app.paths.root, sample.path))).size,
    );

    // The sidecar is the §6.2 schema, empty where a drop has nothing to say.
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, sample.sidecar_path)),
    );
    assertEquals(sidecar.job_id, sample.id);
    assertEquals(sidecar.workflow, null);
    assertEquals(sidecar.params, {});
    assertEquals(sidecar.api_graph, null);
    assertEquals(sidecar.raw, null);
    assertEquals(sidecar.models, [{ role: "model", name: LORA, hash }]);
    assertEquals(sidecar.outputs, [{
      file: `${sample.id}.png`,
      kind: "image",
      width: 24,
      height: 16,
    }]);

    // It shows up on the model page.
    const model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.samples.map((entry) => entry.id), [sample.id]);
    // …and the thumbnail is still unset: a sample is not chosen by arriving.
    assertEquals(model.thumb_path, null);
  });
});

Deno.test("what is not media, and what has no model, are refused", async () => {
  await withSamples(async ({ app, hashes }) => {
    const hash = hashes.get(LORA)!;

    const text = new File([new TextEncoder().encode("not an image")], "a.txt", {
      type: "text/plain",
    });
    const refused = await upload(app, hash, text);
    assertEquals(refused.status, 400);
    assertStringIncludes(
      (await refused.json() as { error: { message: string } }).error.message,
      "not an image or a video",
    );

    const unknown = await upload(app, "f".repeat(64), pngFile("a.png"));
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();

    // The Civitai form is Phase 3 and says so rather than doing nothing.
    const civitai = await app.fetch(`/api/models/${hash}/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ civitai_url: "https://civitai.com/images/1" }),
    });
    assertEquals(civitai.status, 501);
    assertEquals(
      (await civitai.json() as { error: { code: string } }).error.code,
      "not_implemented",
    );
  });
});

Deno.test("promoting an output hard-links one file to every model", async () => {
  await withSamples(async ({ app, hashes }) => {
    const checkpoint = hashes.get(CHECKPOINT)!;
    const lora = hashes.get(LORA)!;
    const job = await app.json<JobRow>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15",
        params: { prompt: "a granite bowl of figs", seed: 11 },
      }),
    });
    await awaitJob(app, job.id);
    const outputId = `${job.id}-0`;
    const outputPath = join(
      app.paths.root,
      (await app.json<{ path: string }>(`/api/outputs/${outputId}`)).path,
    );

    const response = await app.fetch(`/api/outputs/${outputId}/promote`, {
      method: "POST",
      body: JSON.stringify({ model_hashes: [checkpoint, lora] }),
    });
    assertEquals(response.status, 201);
    const { samples } = await response.json() as { samples: SampleView[] };
    assertEquals(samples.length, 2);
    assertEquals(samples.map((sample) => sample.model_hash), [
      checkpoint,
      lora,
    ]);

    // One copy of the bytes, three names for it (§8.3).
    const original = await Deno.stat(outputPath);
    for (const sample of samples) {
      const stat = await Deno.stat(join(app.paths.root, sample.path));
      assertEquals(stat.size, original.size);
      assertEquals(stat.ino, original.ino, "the sample is a hard link");
      assertEquals(sample.reusable, true, "a promotion carries its params");
      assertEquals(sample.params?.seed, 11);
    }

    // The copied sidecar reproduces the generation, and names the file that
    // sits beside it rather than the output's.
    const promoted = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, samples[0]!.sidecar_path)),
    );
    assertEquals(promoted.job_id, job.id);
    assertEquals(promoted.workflow?.id, "sd15");
    assertEquals(promoted.params.seed, 11);
    assert(promoted.api_graph !== null, "the graph came with it");
    assertEquals(promoted.outputs.length, 1);
    assertEquals(promoted.outputs[0]?.file, `${samples[0]!.id}.png`);
    assertEquals(
      promoted.models.find((model) => model.name === CHECKPOINT)?.hash,
      checkpoint,
    );

    // Both model pages show it.
    for (const hash of [checkpoint, lora]) {
      const model = await app.json<ModelDetail>(`/api/models/${hash}`);
      assertEquals(model.samples.length, 1);
    }

    // Deleting a sample takes its row and its files, and nothing else.
    const gone = await app.fetch(`/api/samples/${samples[0]!.id}`, {
      method: "DELETE",
    });
    assertEquals(gone.status, 200);
    await assertMissing(join(app.paths.root, samples[0]!.path));
    await assertMissing(join(app.paths.root, samples[0]!.sidecar_path));
    // The output it came from is untouched, bytes and all.
    assertEquals((await Deno.stat(outputPath)).size, original.size);
    assertEquals(
      (await app.fetch(`/api/outputs/${outputId}`)).status,
      200,
    );
    // …and so is the other model's sample.
    assertEquals(
      (await Deno.stat(join(app.paths.root, samples[1]!.path))).size,
      original.size,
    );
    assertEquals(
      (await app.json<ModelDetail>(`/api/models/${checkpoint}`)).samples,
      [],
    );

    assertEquals(
      (await app.fetch(`/api/samples/${samples[0]!.id}`, { method: "DELETE" }))
        .status,
      404,
    );
  }, { comfy: true });
});

Deno.test("a sample can be made the model's thumbnail", async () => {
  await withSamples(async ({ app, hashes }) => {
    const hash = hashes.get(LORA)!;
    const other = hashes.get(CHECKPOINT)!;
    const sample = await (await upload(app, hash, pngFile("a.png")))
      .json() as SampleView;

    const chosen = await app.json<ModelDetail>(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ thumb_sample_id: sample.id }),
    });
    assertEquals(chosen.thumb_path, sample.path);
    assertEquals(chosen.thumb_url, sample.media_url);
    // The card reads the same thing the page does.
    const listed = await app.json<{ models: ModelDetail[] }>(
      "/api/models?kind=loras",
    );
    assertEquals(listed.models[0]?.thumb_url, sample.media_url);

    // A sample of another model is not this model's to choose.
    const wrong = await app.fetch(`/api/models/${other}`, {
      method: "PATCH",
      body: JSON.stringify({ thumb_sample_id: sample.id }),
    });
    assertEquals(wrong.status, 404);
    await wrong.body?.cancel();

    // Clearing it drops back to whatever `ui.model_thumbnail` asks for —
    // the newest output by default, of which there are none — and then to
    // the other candidate rather than to an empty plate (§8.1). There is a
    // sample here, so that is what it lands on; nothing is *chosen*, so
    // `thumb_path` is still null.
    const cleared = await app.json<ModelDetail>(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ thumb_sample_id: null }),
    });
    assertEquals(cleared.thumb_path, null);
    assertEquals(cleared.thumb_url, `/api/media/${sample.path}`);

    // Deleting the chosen sample cannot leave the model pointing at nothing.
    await app.json(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ thumb_sample_id: sample.id }),
    });
    await app.fetch(`/api/samples/${sample.id}`, { method: "DELETE" });
    assertEquals(
      (await app.json<ModelDetail>(`/api/models/${hash}`)).thumb_path,
      null,
    );
  });
});

Deno.test("with no sample, the newest output is the thumbnail", async () => {
  await withSamples(async ({ app, hashes }) => {
    const checkpoint = hashes.get(CHECKPOINT)!;
    const job = await app.json<JobRow>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15",
        params: { prompt: "a granite bowl of figs", seed: 3 },
      }),
    });
    await awaitJob(app, job.id);

    const model = await app.json<ModelDetail>(`/api/models/${checkpoint}`);
    assertEquals(model.thumb_path, null);
    assertEquals(
      model.thumb_url,
      (await app.json<{ media_url: string }>(`/api/outputs/${job.id}-0`))
        .media_url,
      "the fallback is the most recent output (§8.1)",
    );

    // A deleted output stops standing in for the model.
    await app.fetch(`/api/outputs/${job.id}-0`, { method: "DELETE" });
    assertEquals(
      (await app.json<ModelDetail>(`/api/models/${checkpoint}`)).thumb_url,
      null,
    );
  }, { comfy: true });
});

async function awaitJob(
  app: Harness["app"],
  id: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  let status = "";
  while (!["done", "failed", "cancelled"].includes(status)) {
    if (Date.now() > deadline) {
      throw new Error(`job ${id} was still "${status}" after 5s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<JobRow>(`/api/jobs/${id}`)).status;
  }
  await app.jobs.idle();
}

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`${path} is still there`);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound, `${path} is still there`);
  }
}
