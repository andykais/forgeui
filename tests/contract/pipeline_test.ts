import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { decodePreviewFrame } from "../../src/http/ws.ts";
import { deflateSync } from "node:zlib";
import {
  decodePng,
  readChunks,
  readPngSize,
  readTextChunks,
  serializeChunks,
  SIDECAR_KEYWORD,
} from "../../src/jobs/png.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";
import type { JobRow, Progress } from "../../src/db/queries.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { tinyPng } from "../fixtures/png.ts";
import {
  CHECKPOINT,
  COMFY_DIR,
  COMFY_URL,
  contractTest,
  DATA_DIR,
} from "./env.ts";

/**
 * The other half of the contract check: not "does ComfyUI behave the way the
 * fake says", but "does a generation through the whole app work against a
 * real ComfyUI". This is the automated form of the end-to-end run
 * `docs/HARDWARE-CHECKLIST.md` used to ask a person for — submit, watch
 * progress and previews, find the file, read the sidecar out of the PNG, and
 * reproduce it with Rerun now.
 *
 * It boots the app on the data directory `scripts/with_comfy.ts` created,
 * whose `staging/` is the running ComfyUI's `--output-directory`: the app
 * renames files out of there, so the two have to agree (§6.3).
 *
 * `sd15` is the workflow because it is the only bundled one whose weights are
 * a download rather than a choice (§4.6), and four steps at 256×256 is a few
 * seconds on a CPU.
 */

/** A cold model load plus a handful of steps on a CPU. */
const JOB_TIMEOUT_MS = 600_000;
const PROMPT = "a granite bowl of figs, north light";
const SEED = 424_242;
const SIZE = [256, 256] as const;
const STEPS = 4;

interface JobResponse extends Omit<JobRow, "params" | "api_graph"> {
  params: Record<string, unknown>;
  api_graph: ApiGraph;
  outputs: string[];
}

interface SampleView {
  id: string;
  model_hash: string;
  path: string;
  reusable: boolean;
}

interface ModelEntry {
  hash: string | null;
  filename: string;
  hashing: boolean;
  output_count: number;
  last_used_at: number | null;
}

interface OutputView {
  id: string;
  media_url: string;
  width: number | null;
  height: number | null;
  generation_ms: number | null;
  models: { role: string; name: string }[];
}

const bundled = (id: string, file: string) =>
  fromFileUrl(
    new URL(`../../workflows/bundled/${id}/${file}`, import.meta.url),
  );

/**
 * The bundled `sd15` graphs name the checkpoint `setup-comfy.sh` downloads.
 * When the ComfyUI under test has a different one, shadow them with user
 * copies (§4.6) rather than skipping the run.
 */
async function workflowFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const id of ["sd15", "sd15-inpaint"]) {
    const api = JSON.parse(
      await Deno.readTextFile(bundled(id, "workflow.api.json")),
    );
    if (api["1"].inputs.ckpt_name === CHECKPOINT) continue;
    api["1"].inputs.ckpt_name = CHECKPOINT;
    files[`workflows/user/${id}/workflow.api.json`] = JSON.stringify(
      api,
      null,
      2,
    );
    files[`workflows/user/${id}/manifest.json`] = await Deno.readTextFile(
      bundled(id, "manifest.json"),
    );
  }
  return files;
}

async function startApp(): Promise<TestApp> {
  return await startTestApp({
    dataDir: DATA_DIR,
    keepDataDir: true,
    comfyUrl: COMFY_URL,
    files: await workflowFiles(),
    argv: [
      "--models-dir",
      `checkpoints=${join(COMFY_DIR!, "models", "checkpoints")}`,
      "--models-dir",
      `loras=${join(COMFY_DIR!, "models", "loras")}`,
    ],
  });
}

async function awaitJob(
  app: TestApp,
  id: string,
  timeoutMs = JOB_TIMEOUT_MS,
): Promise<JobResponse> {
  const deadline = Date.now() + timeoutMs;
  let current = await app.json<JobResponse>(`/api/jobs/${id}`);
  while (!["done", "failed", "cancelled"].includes(current.status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `job ${id} was still "${current.status}" after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await app.json<JobResponse>(`/api/jobs/${id}`);
  }
  await app.jobs.idle();
  return await app.json<JobResponse>(`/api/jobs/${id}`);
}

function dayOf(createdAt: number): string {
  const date = new Date(createdAt);
  return `${date.getUTCFullYear()}/${
    `${date.getUTCMonth() + 1}`.padStart(2, "0")
  }/${`${date.getUTCDate()}`.padStart(2, "0")}`;
}

/** The image without its text chunks: what two runs of one seed must share. */
function pixels(png: Uint8Array): Uint8Array {
  return serializeChunks(readChunks(png).filter((c) => c.type !== "tEXt"));
}

contractTest("a real generation runs end to end through the app", async () => {
  const app = await startApp();
  try {
    const socket = await app.socket();
    const submitted = await app.json<JobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15",
        params: {
          prompt: PROMPT,
          size: [...SIZE],
          seed: SEED,
          steps: STEPS,
          cfg: 5,
        },
      }),
    });
    assert(
      submitted.prompt_id,
      "the app chose the prompt id before submitting",
    );
    assertEquals(
      submitted.api_graph["9"]?.inputs.filename_prefix,
      `${submitted.id}/out`,
    );

    const done = await awaitJob(app, submitted.id);
    assertEquals(done.status, "done", JSON.stringify(done.error));
    assertEquals(done.progress?.pct, 100);
    assertEquals(done.outputs, [`${submitted.id}-0`]);
    assert(done.finished_at! >= done.started_at!);

    // The file ComfyUI wrote is now in the day directory, and staging is
    // empty again (§5 step 7).
    const day = dayOf(submitted.created_at);
    const outputDir = join(app.paths.outputs, day);
    const image = join(outputDir, `${submitted.id}-0.png`);
    const bytes = await Deno.readFile(image);
    assertEquals(readPngSize(bytes), { width: SIZE[0], height: SIZE[1] });
    assertEquals(await Deno.stat(outputDir).then((s) => s.isDirectory), true);
    let stagingLeft = 0;
    for await (const entry of Deno.readDir(app.paths.staging)) {
      if (entry.name === submitted.id) stagingLeft++;
    }
    assertEquals(stagingLeft, 0, "the job's staging directory was left behind");

    // The sidecar reproduces the run, and the PNG carries a copy of it.
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(outputDir, `${submitted.id}.json`)),
    );
    assertEquals(sidecar.job_id, submitted.id);
    assertEquals(sidecar.workflow?.id, "sd15");
    assertEquals(sidecar.workflow?.family, "sd15");
    assertEquals(sidecar.params.prompt, PROMPT);
    assertEquals(sidecar.params.seed, SEED);
    assertEquals(sidecar.outputs, [{
      file: `${submitted.id}-0.png`,
      kind: "image",
      width: SIZE[0],
      height: SIZE[1],
    }]);
    assertEquals(
      sidecar.models.map((model) => `${model.role}:${model.name}`),
      [`checkpoint:${CHECKPOINT}`],
    );
    assert(sidecar.timing.total_ms > 0);
    // Real per-node timings, which is what M8 seeds node_timings from.
    assert(
      Object.keys(sidecar.timing.nodes).length > 0,
      "no per-node timings were recorded",
    );
    assertEquals(
      parseSidecar(readTextChunks(bytes)[SIDECAR_KEYWORD]!).job_id,
      submitted.id,
    );

    // ComfyUI's own metadata survived the tEXt chunk the app added.
    const text = readTextChunks(bytes);
    assert(
      "prompt" in text,
      `ComfyUI's own chunks were lost: ${Object.keys(text).join(", ")}`,
    );

    // The gallery row, and the bytes served back through the media route.
    const listed = await app.json<{ outputs: OutputView[] }>("/api/outputs");
    const view = listed.outputs.find((o) => o.id === `${submitted.id}-0`);
    assert(view, "the output is not in the gallery");
    assertEquals(view.width, SIZE[0]);
    assertEquals(view.height, SIZE[1]);
    assert(view.generation_ms !== null && view.generation_ms > 0);
    // Nothing has been hashed yet, so there is nothing to link it to: the
    // sidecar names the checkpoint, and the backfill below is what turns that
    // into a row (§8.1).
    assertEquals(view.models, []);
    const media = await app.fetch(view.media_url);
    assertEquals(media.status, 200);
    assertEquals(new Uint8Array(await media.arrayBuffer()), bytes);

    // Progress and previews reached the app's own clients while it ran.
    const jobEvents = socket.json("job").map((m) => m.data as unknown as JobRow)
      .filter((event) => event.id === submitted.id);
    assert(
      jobEvents.some((event) => event.status === "running"),
      "no running state was pushed",
    );
    const progress = jobEvents
      .map((event) => event.progress)
      .filter((p): p is Progress => p !== null && p.node_id !== null);
    assert(progress.length > 0, "no progress was pushed");
    assert(
      progress.some((p) => p.step !== null && p.step > 0),
      "no step counter arrived from the sampler",
    );
    const previews = socket.binary()
      .map((frame) => decodePreviewFrame(frame.raw))
      .filter((frame) => frame?.jobId === submitted.id);
    assert(
      previews.length > 0,
      "no preview frames were relayed (ComfyUI needs --preview-method auto)",
    );
    assert(previews[0]!.format === 1 || previews[0]!.format === 2);

    // Hashing a real checkpoint — two gigabytes, streamed — and linking the
    // generation that came out of it back to it (§8.1). This is the only
    // place the hasher meets a file of the size it was written for.
    await app.json("/api/maintenance/rescan-models", { method: "POST" });
    await app.models.idle();
    const library = await app.json<{ models: ModelEntry[] }>(
      "/api/models?kind=checkpoints",
    );
    const checkpoint = library.models.find((model) =>
      model.filename === CHECKPOINT
    );
    assert(checkpoint, `${CHECKPOINT} is not in the library`);
    assertEquals(checkpoint.hashing, false);
    assertMatch(checkpoint.hash ?? "", /^[0-9a-f]{64}$/);
    assertEquals(checkpoint.output_count, 1, "the backfill linked the output");
    assert(checkpoint.last_used_at !== null);

    const linked = await app.json<{ outputs: OutputView[] }>(
      `/api/outputs?models=${checkpoint.hash}`,
    );
    assertEquals(linked.outputs.map((output) => output.id), [
      `${submitted.id}-0`,
    ]);
    assertEquals(
      linked.outputs[0]?.models.map((model) => model.role),
      ["checkpoint"],
    );

    // Promote to sample: a hard link, so the model's sample and the output
    // are two names for the same bytes on a real filesystem (§8.3).
    const promoted = await app.json<{ samples: SampleView[] }>(
      `/api/outputs/${submitted.id}-0/promote`,
      {
        method: "POST",
        body: JSON.stringify({ model_hashes: [checkpoint.hash] }),
      },
    );
    const sample = promoted.samples[0]!;
    assertEquals(sample.model_hash, checkpoint.hash);
    assertEquals(sample.reusable, true);
    const sampleStat = await Deno.stat(join(app.paths.root, sample.path));
    assertEquals(sampleStat.ino, (await Deno.stat(image)).ino);
    assertEquals(
      (await app.json<{ samples: SampleView[] }>(
        `/api/models/${checkpoint.hash}`,
      )).samples.map((entry) => entry.id),
      [sample.id],
    );

    // A paste of it — the same pixels, written again as a browser would —
    // finds its way back to it (§9). ComfyUI's PNGs are PIL's, filtered and
    // compressed as the fake's are not, which is the point of asking here.
    const decoded = (await decodePng(bytes))!;
    assertEquals([decoded.width, decoded.height], [SIZE[0], SIZE[1]]);
    const raw = new Uint8Array((decoded.width * 4 + 1) * decoded.height);
    for (let y = 0; y < decoded.height; y++) {
      raw.set(
        decoded.rgba.subarray(
          y * decoded.width * 4,
          (y + 1) * decoded.width * 4,
        ),
        y * (decoded.width * 4 + 1) + 1,
      );
    }
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, decoded.width);
    new DataView(header.buffer).setUint32(4, decoded.height);
    header[8] = 8;
    header[9] = 6;
    const pasted = serializeChunks([
      { type: "IHDR", data: header },
      { type: "IDAT", data: new Uint8Array(deflateSync(raw)) },
      { type: "IEND", data: new Uint8Array(0) },
    ]);
    const form = new FormData();
    form.set("file", new File([pasted.buffer as ArrayBuffer], "image.png"));
    const input = await app.json<{ derived_from_output: string | null }>(
      "/api/inputs",
      { method: "POST", body: form },
    );
    assertEquals(input.derived_from_output, `${submitted.id}-0`);

    // Rerun now ⟳ queues the frozen graph verbatim: same seed, same image.
    const rerun = await app.json<JobResponse>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ output_id: `${submitted.id}-0` }),
    });
    const rerunDone = await awaitJob(app, rerun.id);
    assertEquals(rerunDone.status, "done", JSON.stringify(rerunDone.error));
    const rerunBytes = await Deno.readFile(
      join(app.paths.outputs, dayOf(rerun.created_at), `${rerun.id}-0.png`),
    );
    assertEquals(
      pixels(rerunBytes),
      pixels(bytes),
      "the same seed and graph produced a different image",
    );
    // The files still differ, because each embeds its own sidecar.
    assert(
      readTextChunks(rerunBytes)[SIDECAR_KEYWORD] !==
        readTextChunks(bytes)[SIDECAR_KEYWORD],
      "the rerun embedded the first job's sidecar",
    );
  } finally {
    await app.dispose();
  }
}, { sampler: true, app: true });

contractTest("the model scan sees ComfyUI's own folders", async () => {
  const app = await startApp();
  try {
    const listed = await app.json<{
      kind: string;
      folders: string[];
      models: { name: string; path: string; size: number }[];
    }>("/api/models?kind=checkpoints");
    const model = listed.models.find((entry) => entry.name === CHECKPOINT);
    assert(
      model,
      `${CHECKPOINT} is not in ${
        JSON.stringify(listed.models.map((m) => m.name))
      }`,
    );
    assert(model.size > 0, "the scan reported a zero-byte model");
    assertEquals(await Deno.stat(model.path).then((s) => s.isFile), true);
  } finally {
    await app.dispose();
  }
}, { sampler: true, app: true });

contractTest("the embedded editor is served through /comfy/", async () => {
  const app = await startTestApp({ comfyUrl: COMFY_URL });
  try {
    // Same-origin is the whole point: the iframe's `app.graphToPrompt()` is
    // unreachable otherwise (§4.1).
    const page = await app.fetch("/comfy/");
    assertEquals(page.status, 200);
    assert(
      page.headers.get("content-type")?.includes("text/html"),
      `/comfy/ answered ${page.headers.get("content-type")}`,
    );
    const html = await page.text();
    assert(html.length > 0, "/comfy/ served an empty page");

    // The proxy carries ComfyUI's API too, which is what the editor calls.
    const objectInfo = await app.fetch("/comfy/object_info/KSampler");
    assertEquals(objectInfo.status, 200);
    const body = await objectInfo.json() as Record<string, unknown>;
    assert("KSampler" in body, "ComfyUI's object_info did not come through");

    // An image dropped into the editor is uploaded the way its own frontend
    // does it — multipart, to /api/upload/image — and that has to survive
    // the proxy, body and boundary intact.
    const form = new FormData();
    const picture = tinyPng({ width: 32, height: 24, color: [10, 20, 30] });
    form.set(
      "image",
      new File([picture.buffer as ArrayBuffer], "dropped-into-editor.png", {
        type: "image/png",
      }),
    );
    form.set("type", "input");
    form.set("overwrite", "true");
    const upload = await app.fetch("/comfy/api/upload/image", {
      method: "POST",
      body: form,
    });
    assertEquals(upload.status, 200, await upload.clone().text());
    assertEquals(
      (await upload.json() as { name: string }).name,
      "dropped-into-editor.png",
    );
    const view = await app.fetch(
      "/comfy/api/view?filename=dropped-into-editor.png&type=input",
    );
    assertEquals(view.status, 200);
    assertEquals(new Uint8Array(await view.arrayBuffer()), picture);
  } finally {
    await app.dispose();
  }
});

contractTest("a painted mask repaints only what it covers", async () => {
  const app = await startApp();
  try {
    const upload = async (bytes: Uint8Array, name: string) => {
      const form = new FormData();
      form.set("file", new File([bytes.buffer as ArrayBuffer], name));
      return await app.json<{ filename: string }>("/api/inputs", {
        method: "POST",
        body: form,
      });
    };
    // A flat picture, and a mask over its right half: white repaints (§9).
    const ORIGINAL: [number, number, number] = [96, 128, 160];
    const image = await upload(
      tinyPng({ width: 256, height: 256, color: ORIGINAL }),
      "flat.png",
    );
    const mask = await upload(
      tinyPng({
        width: 256,
        height: 256,
        pixel: (x) => x >= 128 ? [255, 255, 255] : [0, 0, 0],
      }),
      "mask.png",
    );

    const submitted = await app.json<JobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15-inpaint",
        params: {
          image: image.filename,
          mask: mask.filename,
          prompt: PROMPT,
          seed: SEED,
          steps: STEPS,
          creativity: 1,
          grow: 8,
          feather: 8,
        },
      }),
    });
    const done = await awaitJob(app, submitted.id);
    assertEquals(done.status, "done", JSON.stringify(done.error));

    const bytes = await Deno.readFile(
      join(
        app.paths.outputs,
        dayOf(submitted.created_at),
        `${submitted.id}-0.png`,
      ),
    );
    const { width, height, rgba } = (await decodePng(bytes))!;
    assertEquals([width, height], [256, 256]);
    const at = (
      x: number,
      y: number,
    ) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];

    // Well clear of the mask, grown and feathered: the original's own
    // pixels, exactly, because the result is pasted back through the mask
    // rather than decoded wholesale out of the latent.
    for (const y of [4, 64, 128, 200, 250]) {
      for (const x of [2, 40, 90]) {
        assertEquals(at(x, y), ORIGINAL, `kept pixel ${x},${y} changed`);
      }
    }
    // Inside it, the model drew something: a flat field stays flat only if
    // nothing was repainted.
    const inside = [at(200, 64), at(220, 128), at(180, 200), at(240, 240)];
    assert(
      inside.some((pixel) =>
        pixel.some((value, channel) =>
          Math.abs(value - ORIGINAL[channel]!) > 12
        )
      ),
      `nothing was repainted under the mask: ${JSON.stringify(inside)}`,
    );

    // The mask is an input of the output, as the image is (§9 step 5).
    const sidecar = parseSidecar(
      await Deno.readTextFile(
        join(
          app.paths.outputs,
          dayOf(submitted.created_at),
          `${submitted.id}.json`,
        ),
      ),
    );
    assertEquals(sidecar.params.mask, mask.filename);
  } finally {
    await app.dispose();
  }
}, { sampler: true, app: true });
