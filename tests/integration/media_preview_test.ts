import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { writeTinyPng } from "../fixtures/png.ts";
import { tinyWav } from "../fixtures/wav.ts";
import { buildSidecar, serializeSidecar } from "../../src/jobs/sidecar.ts";
import { ffmpegAvailable } from "../../src/media/audio.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { createBridgeServer } from "../../src/mcp/tools.ts";

/**
 * A smaller copy of an output, and the output itself (DESIGN-AGENT-LOOP
 * §5.1, §6.3). `?max_edge=` is the route; `get_output_preview` and
 * `get_output_file` are the two ways the bridge hands media to a model —
 * one for looking, one for the bytes — and these go through both.
 *
 * Resizing is ffmpeg's job, so most of this skips itself on a machine
 * without it, the way the audio tests do. The one that does not is the
 * refusal: a bad `max_edge` is a 400 before ffmpeg is ever asked.
 */

const haveFfmpeg = await ffmpegAvailable();

/** Width and height of a picture or a clip's first video stream. */
async function dimensions(bytes: Uint8Array): Promise<[number, number]> {
  const path = await Deno.makeTempFile();
  try {
    await Deno.writeFile(path, bytes);
    const { stdout } = await new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path,
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    const [width, height] = new TextDecoder().decode(stdout).trim().split(",")
      .map(Number);
    return [width!, height!];
  } finally {
    await Deno.remove(path);
  }
}

/**
 * One output of each kind, filed the way completion would have and picked
 * up by reindex — the fake ComfyUI writes pictures only, and this needs a
 * clip and a take beside the picture.
 */
async function importOutputs(app: TestApp): Promise<{
  image: string;
  video: string;
  audio: string;
}> {
  const dir = join(app.paths.outputs, "2026", "03", "04");
  await Deno.mkdir(dir, { recursive: true });
  const files = {
    image: { id: "01JPREVIEWIMAGE00000000000", ext: "png" },
    video: { id: "01JPREVIEWVIDEO00000000000", ext: "mp4" },
    audio: { id: "01JPREVIEWAUDIO00000000000", ext: "wav" },
  } as const;

  await writeTinyPng(join(dir, `${files.image.id}-0.png`), {
    width: 640,
    height: 400,
  });
  await Deno.writeFile(join(dir, `${files.audio.id}-0.wav`), tinyWav());
  const { code } = await new Deno.Command("ffmpeg", {
    args: [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=12:duration=1",
      "-pix_fmt",
      "yuv420p",
      join(dir, `${files.video.id}-0.mp4`),
    ],
  }).output();
  assertEquals(code, 0, "ffmpeg could not make the fixture clip");

  for (const [kind, { id, ext }] of Object.entries(files)) {
    const sidecar = buildSidecar({
      job_id: id,
      created_at: "2026-03-04T05:06:07Z",
      workflow: {
        id: "krea2",
        name: "Flux Krea 2",
        hash: "sha256:deadbeef",
        family: "flux",
        kind: kind as "image" | "video" | "audio",
      },
      params: { prompt: `a ${kind} to preview`, seed: 1 },
      models: [],
      api_graph: { "9": { class_type: "SaveImage", inputs: {} } },
      outputs: [{
        file: `${id}-0.${ext}`,
        kind: kind as "image" | "video" | "audio",
      }],
      timing: { total_ms: 1, nodes: { "9": 1 } },
    });
    await Deno.writeTextFile(
      join(dir, `${id}.json`),
      serializeSidecar(sidecar),
    );
  }
  await app.json("/api/maintenance/reindex", { method: "POST" });
  return {
    image: `${files.image.id}-0`,
    video: `${files.video.id}-0`,
    audio: `${files.audio.id}-0`,
  };
}

async function mediaUrl(app: TestApp, id: string): Promise<string> {
  return (await app.json<{ media_url: string }>(`/api/outputs/${id}`))
    .media_url;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | {
    type: "resource";
    resource: { uri: string; mimeType: string; blob: string };
  };

/** One tool call over the HTTP binding, content blocks and all. */
async function callTool(
  app: TestApp,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Block[] }> {
  const handler = createMcpHandler(() =>
    createBridgeServer({
      forge: new ForgeUi({ url: app.url }),
      llama: null,
      freeVram: false,
      progress: false,
      defaultTimeoutMs: 30_000,
    })
  );
  try {
    const response = await handler.fetch(
      new Request("http://bridge/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data:"));
    assert(data, `no JSON-RPC response in: ${body}`);
    const message = JSON.parse(data.slice("data:".length));
    assert(!message.error, `${name} failed: ${message.error?.message}`);
    return message.result;
  } finally {
    await handler.close();
  }
}

// ------------------------------------------------------------------ route

Deno.test("max_edge must be a size, not anything that parses", async () => {
  await withTestApp(async (app) => {
    const dir = join(app.paths.outputs, "x");
    await Deno.mkdir(dir, { recursive: true });
    await writeTinyPng(join(dir, "a.png"), { width: 8, height: 8 });
    for (const bad of ["0", "12.5", "huge", "99999"]) {
      const response = await app.fetch(
        `/api/media/outputs/x/a.png?max_edge=${bad}`,
      );
      assertEquals(response.status, 400, `max_edge=${bad}`);
      assertStringIncludes((await response.json()).error.message, "max_edge");
    }
  });
});

Deno.test({
  name: "max_edge fits a picture inside the edge, whole and never enlarged",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { image } = await importOutputs(app);
      const url = await mediaUrl(app, image);

      const small = await app.fetch(`${url}?max_edge=160`);
      assertEquals(small.status, 200);
      assertEquals(small.headers.get("content-type"), "image/jpeg");
      // The whole 640×400 frame, scaled — not a square crop of it.
      assertEquals(
        await dimensions(new Uint8Array(await small.arrayBuffer())),
        [
          160,
          100,
        ],
      );

      const big = await app.fetch(`${url}?max_edge=2048`);
      assertEquals(
        await dimensions(new Uint8Array(await big.arrayBuffer())),
        [640, 400],
        "an edge longer than the picture leaves it the size it is",
      );

      // And without the parameter, the file itself, as before.
      const original = await app.fetch(url);
      assertEquals(original.headers.get("content-type"), "image/png");
      await original.body?.cancel();
    });
  },
});

Deno.test({
  name: "max_edge makes a clip smaller and keeps it a clip",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { video } = await importOutputs(app);
      const url = await mediaUrl(app, video);
      const response = await app.fetch(`${url}?max_edge=320`);
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("content-type"), "video/mp4");
      assertEquals(
        await dimensions(new Uint8Array(await response.arrayBuffer())),
        [320, 180],
      );
    });
  },
});

Deno.test({
  name: "max_edge leaves a take alone: sound has no edge",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { audio } = await importOutputs(app);
      const url = await mediaUrl(app, audio);
      const response = await app.fetch(`${url}?max_edge=256`);
      assertEquals(response.status, 200);
      assert(
        response.headers.get("content-type")?.startsWith("audio/"),
        response.headers.get("content-type") ?? "no type",
      );
      assertEquals(new Uint8Array(await response.arrayBuffer()), tinyWav());
    });
  },
});

// ------------------------------------------------------------------ bridge

Deno.test({
  name: "get_output_preview shows a picture small, and a clip as a small clip",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { image, video } = await importOutputs(app);

      const picture = await callTool(app, "get_output_preview", {
        output_id: image,
        max_edge: 128,
      });
      assert(!picture.isError, JSON.stringify(picture));
      const [note, block] = picture.content;
      assertStringIncludes((note as { text: string }).text, "640×400");
      assert(block?.type === "image", `got ${block?.type}`);
      assertEquals(block.mimeType, "image/jpeg");
      assertEquals(await dimensions(decodeBase64(block.data)), [128, 80]);

      // A clip has no content type of its own in MCP, so it travels as an
      // embedded resource: the bytes, their type, and where they came from.
      const clip = await callTool(app, "get_output_preview", {
        output_id: video,
        max_edge: 256,
      });
      assert(!clip.isError, JSON.stringify(clip));
      const resource = clip.content[1];
      assert(resource?.type === "resource", `got ${resource?.type}`);
      assertEquals(resource.resource.mimeType, "video/mp4");
      assert(resource.resource.uri.startsWith(app.url), resource.resource.uri);
      assertEquals(
        await dimensions(decodeBase64(resource.resource.blob)),
        [256, 144],
      );
    });
  },
});

Deno.test({
  name: "get_output_preview sends a take to get_output_file",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { audio } = await importOutputs(app);
      const result = await callTool(app, "get_output_preview", {
        output_id: audio,
      });
      assert(result.isError);
      assertStringIncludes(
        (result.content[0] as { text: string }).text,
        "get_output_file",
      );
    });
  },
});

Deno.test({
  name: "get_output_file hands over the file itself, inline or on disk",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withTestApp(async (app) => {
      const { image, video, audio } = await importOutputs(app);
      const dir = join(app.paths.outputs, "2026", "03", "04");

      // Byte for byte: the PNG as it was written, not the preview's JPEG.
      const picture = await callTool(app, "get_output_file", {
        output_id: image,
      });
      const pictureBlock = picture.content[1];
      assert(pictureBlock?.type === "image", `got ${pictureBlock?.type}`);
      assertEquals(pictureBlock.mimeType, "image/png");
      assertEquals(
        decodeBase64(pictureBlock.data),
        await Deno.readFile(join(dir, `${image}.png`)),
      );

      const take = await callTool(app, "get_output_file", { output_id: audio });
      const takeBlock = take.content[1];
      assert(takeBlock?.type === "audio", `got ${takeBlock?.type}`);
      assertEquals(decodeBase64(takeBlock.data), tinyWav());

      const clip = await callTool(app, "get_output_file", { output_id: video });
      const clipBlock = clip.content[1];
      assert(clipBlock?.type === "resource", `got ${clipBlock?.type}`);
      assertEquals(
        decodeBase64(clipBlock.resource.blob),
        await Deno.readFile(join(dir, `${video}.mp4`)),
      );

      // Into a directory, under the name ForgeUI filed it by.
      const target = await Deno.makeTempDir();
      try {
        const saved = await callTool(app, "get_output_file", {
          output_id: video,
          save_to: target,
        });
        assert(!saved.isError, JSON.stringify(saved));
        const answer = JSON.parse((saved.content[0] as { text: string }).text);
        assertEquals(answer.saved, join(target, `${video}.mp4`));
        assertEquals(answer.kind, "video");
        assertEquals(
          await Deno.readFile(answer.saved),
          await Deno.readFile(join(dir, `${video}.mp4`)),
        );
      } finally {
        await Deno.remove(target, { recursive: true });
      }
    });
  },
});
