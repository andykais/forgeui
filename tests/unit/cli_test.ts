import { assertEquals, assertThrows } from "@std/assert";
import { parseCliArgs } from "../../src/config/cli.ts";
import { ConfigError } from "../../src/config/validate.ts";

Deno.test("no arguments means start with no overrides", () => {
  const args = parseCliArgs([]);
  assertEquals(args.command, "start");
  assertEquals(args.dataDir, null);
  assertEquals(args.overrides, {});
});

Deno.test("flags become a per-run override layer", () => {
  const args = parseCliArgs([
    "--data-dir",
    "/tmp/forgeui",
    "--port",
    "8080",
    "--host",
    "0.0.0.0",
    "--comfy-mode",
    "local_url",
    "--comfy-path",
    "/opt/ComfyUI",
    "--comfy-url",
    "http://127.0.0.1:8189",
    "--models-dir",
    "loras=/mnt/models/loras",
    "--models-dir",
    "loras=/mnt/archive/loras",
    "--models-dir",
    "checkpoints=/mnt/models/checkpoints",
  ]);
  assertEquals(args.dataDir, "/tmp/forgeui");
  assertEquals(args.overrides, {
    server: { host: "0.0.0.0", port: 8080 },
    comfy: {
      mode: "local_url",
      path: "/opt/ComfyUI",
      url: "http://127.0.0.1:8189",
    },
    model_folders: {
      loras: ["/mnt/models/loras", "/mnt/archive/loras"],
      checkpoints: ["/mnt/models/checkpoints"],
    },
  });
});

Deno.test("reindex is a command, not a flag", () => {
  assertEquals(parseCliArgs(["reindex"]).command, "reindex");
  assertThrows(
    () => parseCliArgs(["reeindex"]),
    ConfigError,
    "unknown command: reeindex",
  );
  assertThrows(
    () => parseCliArgs(["start", "extra"]),
    ConfigError,
    "unexpected argument: extra",
  );
});

Deno.test("bad flags are reported, not ignored", () => {
  assertThrows(
    () => parseCliArgs(["--datadir", "/tmp/x"]),
    ConfigError,
    "unknown option: --datadir",
  );
  assertThrows(
    () => parseCliArgs(["--port", "no"]),
    ConfigError,
    "--port: expected an integer",
  );
  assertThrows(
    () => parseCliArgs(["--models-dir", "/mnt/loras"]),
    ConfigError,
    "expected kind=path",
  );
  assertThrows(
    () => parseCliArgs(["--comfy-mode", "turbo"]),
    ConfigError,
    "one of managed, local_url",
  );
});

Deno.test("help and version are recognised", () => {
  assertEquals(parseCliArgs(["--help"]).help, true);
  assertEquals(parseCliArgs(["-h"]).help, true);
  assertEquals(parseCliArgs(["--version"]).version, true);
  assertEquals(parseCliArgs(["-V"]).version, true);
});
