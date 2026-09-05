import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  decodeComfyMessage,
  decodePreviewFrame,
  outputImages,
} from "../../src/comfy/events.ts";
import {
  comfyLaunchCommand,
  LaunchError,
  launchFlagsForDisplay,
  pythonFor,
} from "../../src/comfy/launch.ts";
import { comfyTargetPath } from "../../src/comfy/proxy.ts";
import {
  decodePreviewFrame as decodeAppFrame,
  encodePreviewFrame,
} from "../../src/http/ws.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { dataPaths } from "../../src/config/paths.ts";
import type { Config } from "../../src/config/types.ts";
import { effectiveConfig } from "../../src/config/config.ts";

Deno.test("websocket messages decode into the events the app acts on", () => {
  assertEquals(
    decodeComfyMessage(
      '{"type":"execution_start","data":{"prompt_id":"p1","timestamp":7}}',
    ),
    { type: "execution_start", prompt_id: "p1", timestamp: 7 },
  );
  assertEquals(
    decodeComfyMessage(
      '{"type":"executing","data":{"node":"3","prompt_id":"p1"}}',
    ),
    { type: "executing", prompt_id: "p1", node: "3" },
  );
  // The end-of-prompt marker.
  assertEquals(
    decodeComfyMessage(
      '{"type":"executing","data":{"node":null,"prompt_id":"p1"}}',
    ),
    { type: "executing", prompt_id: "p1", node: null },
  );
  assertEquals(
    decodeComfyMessage(
      '{"type":"progress","data":{"value":3,"max":20,"node":"3","prompt_id":"p1"}}',
    ),
    { type: "progress", prompt_id: "p1", node: "3", value: 3, max: 20 },
  );
  assertEquals(
    decodeComfyMessage(
      '{"type":"status","data":{"status":{"exec_info":{"queue_remaining":2}},"sid":"x"}}',
    ),
    { type: "status", queue_remaining: 2 },
  );
});

Deno.test("executed events collect the files a node wrote", () => {
  const event = decodeComfyMessage(JSON.stringify({
    type: "executed",
    data: {
      node: "9",
      prompt_id: "p1",
      output: {
        images: [
          { filename: "out_00001_.png", subfolder: "01JOB", type: "output" },
          { filename: "out_00002_.png", subfolder: "01JOB", type: "output" },
        ],
      },
    },
  }));
  assert(event?.type === "executed");
  assertEquals(event.images.length, 2);
  assertEquals(event.images[0]?.filename, "out_00001_.png");

  // Videos arrive under a different key, and junk entries are dropped.
  assertEquals(
    outputImages({
      gifs: [{ filename: "clip.webp", subfolder: "01JOB", type: "output" }],
      images: [{ nope: true }],
    }).map((image) => image.filename),
    ["clip.webp"],
  );
});

Deno.test("errors and interruptions keep ComfyUI's own payload", () => {
  const error = decodeComfyMessage(JSON.stringify({
    type: "execution_error",
    data: {
      prompt_id: "p1",
      node_id: "3",
      node_type: "KSampler",
      exception_message: "CUDA out of memory",
      exception_type: "torch.OutOfMemoryError",
      traceback: ["line one"],
    },
  }));
  assert(error?.type === "execution_error");
  assertEquals(error.node_id, "3");
  assertEquals(error.exception_type, "torch.OutOfMemoryError");
  assertEquals(error.traceback, ["line one"]);

  const interrupted = decodeComfyMessage(
    '{"type":"execution_interrupted","data":{"prompt_id":"p1","node_id":"3"}}',
  );
  assert(interrupted?.type === "execution_interrupted");
  assertEquals(interrupted.node_id, "3");
});

Deno.test("unknown and malformed messages are dropped, not thrown", () => {
  assertEquals(decodeComfyMessage("not json"), null);
  assertEquals(decodeComfyMessage("[]"), null);
  assertEquals(decodeComfyMessage('{"type":"b_preview"}'), null);
  assertEquals(decodeComfyMessage('{"type":"executed","data":{}}'), null);
  // Missing fields fall back rather than crashing the socket.
  assertEquals(
    decodeComfyMessage('{"type":"progress","data":{"prompt_id":"p1"}}'),
    { type: "progress", prompt_id: "p1", node: null, value: 0, max: 0 },
  );
  assertEquals(
    decodeComfyMessage('{"type":"execution_error","data":{"prompt_id":"p1"}}'),
    {
      type: "execution_error",
      prompt_id: "p1",
      node_id: null,
      node_type: null,
      exception_message: "ComfyUI reported an error",
      exception_type: "Exception",
      traceback: [],
    },
  );
});

Deno.test("ComfyUI's binary preview frame decodes", () => {
  const frame = new Uint8Array(8 + 3);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 2);
  frame.set([9, 8, 7], 8);
  assertEquals(decodePreviewFrame(frame), {
    type: "preview",
    format: 2,
    bytes: new Uint8Array([9, 8, 7]),
  });
  // Anything that is not a preview frame is ignored.
  view.setUint32(0, 4);
  assertEquals(decodePreviewFrame(frame), null);
  assertEquals(decodePreviewFrame(new Uint8Array(4)), null);
});

Deno.test("the app's preview frame carries the job id", () => {
  const image = new Uint8Array([1, 2, 3, 4]);
  const frame = encodePreviewFrame("01JOBID", 2, image);
  assertEquals(decodeAppFrame(frame), {
    jobId: "01JOBID",
    format: 2,
    image,
  });
  assertEquals(decodeAppFrame(new Uint8Array(6)), null);
});

function config(over: Partial<Config["comfy"]>): Config {
  return effectiveConfig({ comfy: { ...defaultConfig().comfy, ...over } });
}

Deno.test("the launch command carries the three directory flags (§2)", () => {
  const paths = dataPaths("/home/nt/.forgeui");
  const launch = comfyLaunchCommand(
    config({
      path: "/opt/ComfyUI",
      python: "/opt/ComfyUI/venv/bin/python",
      url: "http://127.0.0.1:8188",
    }),
    paths,
  );
  assertEquals(launch.command, "/opt/ComfyUI/venv/bin/python");
  assertEquals(launch.cwd, "/opt/ComfyUI");
  assertEquals(launch.port, 8188);
  assertEquals(launch.args, [
    "main.py",
    "--port",
    "8188",
    "--listen",
    "127.0.0.1",
    "--output-directory",
    "/home/nt/.forgeui/staging",
    "--input-directory",
    "/home/nt/.forgeui/comfy-input",
    "--extra-model-paths-config",
    "/home/nt/.forgeui/extra_model_paths.yaml",
  ]);

  // Extra args are appended verbatim, for flags like --lowvram.
  assertEquals(
    comfyLaunchCommand(
      config({
        path: "/opt/ComfyUI",
        python: "python3",
        extra_args: ["--lowvram"],
      }),
      paths,
    ).args.at(-1),
    "--lowvram",
  );
});

Deno.test("managed mode without an install path cannot be launched", () => {
  assertThrows(
    () => comfyLaunchCommand(config({ path: null }), dataPaths("/tmp/x")),
    LaunchError,
    "no ComfyUI install path",
  );
});

Deno.test("the interpreter falls back to the platform python", () => {
  assertEquals(
    pythonFor(config({ python: "/usr/bin/python3.12" })),
    "/usr/bin/python3.12",
  );
  assertEquals(
    pythonFor(config({ python: null, path: "/nonexistent" })),
    Deno.build.os === "windows" ? "python" : "python3",
  );
});

Deno.test("Settings shows the same flags, read-only", () => {
  const flags = launchFlagsForDisplay(
    config({ path: "/opt/ComfyUI", url: "http://127.0.0.1:8188" }),
    dataPaths("/home/nt/.forgeui"),
  );
  assertEquals(flags[0], "--port 8188");
  assert(flags.some((flag) => flag.startsWith("--output-directory ")));
  assert(flags.some((flag) => flag.startsWith("--extra-model-paths-config ")));
});

Deno.test("the proxy strips its own prefix and keeps the query", () => {
  assertEquals(
    comfyTargetPath(
      new URL("http://app/comfy/view?filename=a.png&type=output"),
    ),
    "/view?filename=a.png&type=output",
  );
  assertEquals(comfyTargetPath(new URL("http://app/comfy/")), "/");
  assertEquals(comfyTargetPath(new URL("http://app/comfy")), "/");
  assertEquals(
    comfyTargetPath(new URL("http://app/comfy/scripts/app.js")),
    "/scripts/app.js",
  );
});
