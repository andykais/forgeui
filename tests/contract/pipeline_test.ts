import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { decodePreviewFrame } from "../../src/http/ws.ts";
import {
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

interface OutputView {
  id: string;
  media_url: string;
  width: number | null;
  height: number | null;
  generation_ms: number | null;
  models: { role: string; name: string }[];
}

const bundled = (file: string) =>
  fromFileUrl(new URL(`../../workflows/bundled/sd15/${file}`, import.meta.url));

/**
 * The bundled `sd15` graph names the checkpoint `setup-comfy.sh` downloads.
 * When the ComfyUI under test has a different one, shadow it with a user copy
 * (§4.6) rather than skipping the run.
 */
async function workflowFiles(): Promise<Record<string, string>> {
  const api = JSON.parse(await Deno.readTextFile(bundled("workflow.api.json")));
  if (api["1"].inputs.ckpt_name === CHECKPOINT) return {};
  api["1"].inputs.ckpt_name = CHECKPOINT;
  return {
    "workflows/user/sd15/workflow.api.json": JSON.stringify(api, null, 2),
    "workflows/user/sd15/manifest.json": await Deno.readTextFile(
      bundled("manifest.json"),
    ),
  };
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
    // Empty because nothing is hashed yet: `output_models` rows need a hash,
    // and M6 is what gives them one (§8.1). The sidecar above already names
    // the checkpoint, which is why the backfill can find it later.
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
  } finally {
    await app.dispose();
  }
});
