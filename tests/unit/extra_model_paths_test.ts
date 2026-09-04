import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderExtraModelPaths } from "../../src/config/extra_model_paths.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { Config } from "../../src/config/types.ts";

function configWith(folders: Config["model_folders"]): Config {
  return { ...defaultConfig(), model_folders: folders };
}

Deno.test("empty folders still produce a file ComfyUI can read", () => {
  const rendered = renderExtraModelPaths(defaultConfig());
  assertStringIncludes(rendered, "forgeui: {}");
});

Deno.test("each kind becomes one newline-separated block", () => {
  const rendered = renderExtraModelPaths(configWith({
    loras: ["/mnt/models/loras", "/mnt/archive/loras"],
    checkpoints: ["/mnt/models/checkpoints"],
    vae: [],
  }));
  const body = rendered.split("\n").filter((line) => !line.startsWith("#"));
  assertEquals(body, [
    "forgeui:",
    "  checkpoints: |-",
    "    /mnt/models/checkpoints",
    "  loras: |-",
    "    /mnt/models/loras",
    "    /mnt/archive/loras",
    "",
  ]);
});
