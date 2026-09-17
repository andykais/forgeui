import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";
import { ffmpegAvailable } from "../../src/media/audio.ts";
import type { Sidecar } from "../../src/jobs/sidecar.ts";

/**
 * A workflow that makes sound, end to end (DESIGN-AUDIO §4.1, §2.2).
 *
 * Every piece of this was a hole before: ComfyUI files audio under its own
 * `audio` key, which the app did not read, so the run finished and reported
 * no files at all; the kind had nowhere to be filed; and a result with no
 * thumbnail had nothing to show in a grid built on pictures.
 */

const TERMINAL = ["done", "failed", "cancelled"];
const haveFfmpeg = await ffmpegAvailable();

/** A graph whose one output node is a save-audio node. */
function songGraph(jobId: string) {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "test-checkpoint.safetensors" },
      _meta: { title: "Load Checkpoint" },
    },
    "2": {
      class_type: "EmptyLatentAudio",
      inputs: { seconds: 2, batch_size: 1 },
      _meta: { title: "Empty Latent Audio" },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 42,
        steps: 4,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["1", 0],
        positive: ["1", 1],
        negative: ["1", 1],
        latent_image: ["2", 0],
      },
      _meta: { title: "KSampler" },
    },
    "8": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["3", 0], vae: ["1", 2] },
      _meta: { title: "VAE Decode Audio" },
    },
    "9": {
      class_type: "SaveAudioAdvanced",
      inputs: {
        filename_prefix: `${jobId}/take`,
        audio: ["8", 0],
        format: "flac",
      },
      _meta: { title: "Save Audio" },
    },
  };
}

const manifest = {
  id: "song",
  name: "Song",
  family: null,
  kind: "audio",
  params: [
    { key: "prompt", label: "Style", type: "text", bind: "9.filename_prefix" },
  ],
  outputs: [{ node: "9", kind: "audio" }],
};

function files(jobId: string): Record<string, string> {
  return {
    "workflows/user/song/manifest.json": JSON.stringify(manifest, null, 2),
    "workflows/user/song/workflow.api.json": JSON.stringify(
      songGraph(jobId),
      null,
      2,
    ),
  };
}

Deno.test({
  name: "a workflow that writes audio produces an audio output",
  ignore: !haveFfmpeg,
  fn: () =>
    withTestApp(async (app) => {
      const job = await app.json<{ id: string }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "song",
          params: { prompt: "a slow neo-soul groove" },
        }),
      });

      const deadline = Date.now() + 5000;
      let status = "queued";
      while (!TERMINAL.includes(status)) {
        if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await app.json<{ status: string }>(`/api/jobs/${job.id}`))
          .status;
      }
      // Without the `audio` key this is where it failed: "ComfyUI finished
      // without writing any files".
      assertEquals(status, "done");
      await app.jobs.idle();

      const page = await app.json<{
        outputs: {
          id: string;
          kind: string;
          path: string;
          duration_ms: number | null;
          media_url: string;
          waveform_url: string | null;
        }[];
      }>("/api/outputs?limit=5");
      const output = page.outputs[0];
      assert(output, "the run produced no output row");
      assertEquals(output.kind, "audio");

      // ffprobe read the container: the fake writes two seconds of tone.
      assertEquals(output.duration_ms, 2000);

      // The waveform is a sibling file, so the URL is the media's plus a
      // suffix, and it is served by the route that already serves media.
      assertEquals(output.waveform_url, `${output.media_url}.waveform.png`);
      const drawn = await app.fetch(output.waveform_url!);
      assertEquals(drawn.status, 200);
      assertEquals(drawn.headers.get("content-type"), "image/png");
      assert((await drawn.arrayBuffer()).byteLength > 0);

      // And the sidecar says audio too, so a reindex files it the same way.
      const detail = await app.json<{ sidecar: Sidecar | null }>(
        `/api/outputs/${output.id}`,
      );
      assertEquals(detail.sidecar?.outputs[0]?.kind, "audio");
      assertEquals(detail.sidecar?.outputs[0]?.duration_ms, 2000);

      // Deleting the output takes the waveform with it; the undo window is
      // shortened so the sweep happens inside the test.
      app.outputs.undoWindowMs = 0;
      await app.fetch(`/api/outputs/${output.id}`, { method: "DELETE" });
      const waveform = join(app.dataDir, `${output.path}.waveform.png`);
      await waitGone(waveform);
    }, { comfy: true, files: files("song") }),
});

async function waitGone(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${path} outlived its output`);
}
