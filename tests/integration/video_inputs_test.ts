import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { ffmpegAvailable } from "../../src/media/audio.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";

/**
 * A video as an input (§9): the store takes it, measures it with ffprobe and
 * hands it to ComfyUI under its hash, and `frame-interpolate` (§4.6) is the
 * workflow that reads one. A real MP4 is drawn by ffmpeg for each test, so
 * these skip on a machine without it, as the audio tests do.
 */

const haveFfmpeg = await ffmpegAvailable();
const TERMINAL = ["done", "failed", "cancelled"];

interface InputView {
  sha256: string;
  ext: string;
  filename: string;
  kind: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  url: string;
}

/** Two seconds of ffmpeg's test pattern, 96×64 at 12 fps, with a tone. */
async function tinyMp4(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-video-" });
  const path = join(dir, "clip.mp4");
  try {
    const { success, stderr } = await new Deno.Command("ffmpeg", {
      args: [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=96x64:rate=12:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!success) throw new Error(new TextDecoder().decode(stderr));
    return await Deno.readFile(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function upload(app: TestApp, bytes: Uint8Array): Promise<InputView> {
  const form = new FormData();
  form.set("file", new File([bytes.buffer as ArrayBuffer], "clip.mp4"));
  return await app.json<InputView>("/api/inputs", {
    method: "POST",
    body: form,
  });
}

Deno.test({
  name: "an uploaded video is filed as a video, with its size and length",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const bytes = await tinyMp4();
      const input = await upload(app, bytes);

      // Not `.m4a`: an MP4 shares its container with one, and the brand is
      // what tells them apart.
      assertEquals(input.kind, "video");
      assertEquals(input.ext, "mp4");
      assertEquals(input.filename, `${input.sha256}.mp4`);
      assertEquals([input.width, input.height], [96, 64]);
      assert(
        input.duration_ms !== null &&
          Math.abs(input.duration_ms - 2000) < 200,
        `duration ${input.duration_ms}`,
      );

      // The bytes are in the store, and served back as a video.
      const onDisk = await Deno.readFile(
        join(
          app.paths.root,
          "inputs",
          input.sha256.slice(0, 2),
          input.filename,
        ),
      );
      assertEquals(onDisk.length, bytes.length);
      const served = await app.fetch(input.url);
      assertEquals(served.headers.get("content-type"), "video/mp4");
      await served.body?.cancel();

      // And asked about again, it is still a video.
      const again = await app.json<InputView>(`/api/inputs/${input.sha256}`);
      assertEquals(again.kind, "video");
    });
  },
});

Deno.test({
  name: "frame interpolation uploads the video and multiplies the frame rate",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const input = await upload(app, await tinyMp4());
      const job = await app.json<{ id: string }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "frame-interpolate",
          params: {
            video: input.filename,
            multiplier: 4,
            model: "rife-v4.25.pkl",
          },
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
      await app.jobs.idle();
      assertEquals(status, "done");

      // ComfyUI was handed the file under the name the graph uses.
      assertEquals(
        app.fake!.uploads.map((upload) => upload.name),
        [input.filename],
      );

      const { outputs } = await app.json<{ outputs: { id: string }[] }>(
        "/api/outputs?limit=1",
      );
      const detail = await app.json<{ sidecar_path: string; kind: string }>(
        `/api/outputs/${outputs[0]!.id}`,
      );
      assertEquals(detail.kind, "video");
      const sidecar = parseSidecar(
        await Deno.readTextFile(join(app.paths.root, detail.sidecar_path)),
        detail.sidecar_path,
      );
      const graph = sidecar.api_graph as Record<
        string,
        { class_type: string; inputs: Record<string, unknown> }
      >;
      assertEquals(graph["1"]!.inputs.file, input.filename);
      assertEquals(graph["3"]!.inputs.model_name, "rife-v4.25.pkl");
      // One number feeds both the interpolator and the frame rate, so the
      // result runs as long as the source did.
      assertEquals(graph["4"]!.inputs.value, 4);
      assertEquals(graph["5"]!.inputs.multiplier, ["4", 0]);
      assertEquals(graph["6"]!.inputs["values.b"], ["4", 0]);
      assertEquals(graph["7"]!.inputs.fps, ["6", 0]);
      // The sound is carried over from the source.
      assertEquals(graph["7"]!.inputs.audio, ["2", 1]);
    }, { comfy: true });
  },
});
