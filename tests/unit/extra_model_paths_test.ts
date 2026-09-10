import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderExtraModelPaths,
  resolveExtraModelPaths,
} from "../../src/config/extra_model_paths.ts";
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
    // One diffusion folder, but it is still written under both keys so a
    // UNETLoader can resolve a name the picker took from checkpoints/.
    "  checkpoints: |-",
    "    /mnt/models/checkpoints",
    "  diffusion_models: |-",
    "    /mnt/models/checkpoints",
    "  loras: |-",
    "    /mnt/models/loras",
    "    /mnt/archive/loras",
    "",
  ]);
});

Deno.test("every diffusion folder is listed under both keys", () => {
  const rendered = renderExtraModelPaths(configWith({
    checkpoints: ["/models/checkpoints"],
    diffusion_models: ["/models/diffusion_models"],
    unet: ["/models/unet"],
    "Stable-Diffusion": ["/models/Stable-Diffusion"],
    vae: ["/models/vae"],
  }));
  const body = rendered.split("\n").filter((line) => !line.startsWith("#"));
  const pooled = [
    "    /models/checkpoints",
    "    /models/Stable-Diffusion",
    "    /models/diffusion_models",
    "    /models/unet",
  ];
  assertEquals(body, [
    "forgeui:",
    "  checkpoints: |-",
    ...pooled,
    "  diffusion_models: |-",
    ...pooled,
    "  vae: |-",
    "    /models/vae",
    "",
  ]);
});

Deno.test("a folder shared by two diffusion kinds is listed once", () => {
  const paths = resolveExtraModelPaths(configWith({
    checkpoints: ["/models/all"],
    diffusion_models: ["/models/all"],
  }));
  assertEquals(paths.checkpoints, ["/models/all"]);
  assertEquals(paths.diffusion_models, ["/models/all"]);
});

Deno.test("a model_classes override joins the diffusion pool", () => {
  const config = configWith({
    checkpoints: ["/models/checkpoints"],
    my_models: ["/models/mine"],
  });
  config.model_classes = { my_models: "diffusion" };
  const paths = resolveExtraModelPaths(config);
  assertEquals(paths.checkpoints, ["/models/checkpoints", "/models/mine"]);
  assertEquals(paths.diffusion_models, ["/models/checkpoints", "/models/mine"]);
  // It was pooled, so it is not also emitted under its own key.
  assertEquals(paths.my_models, undefined);
});

Deno.test("an unknown kind keeps its own key", () => {
  const paths = resolveExtraModelPaths(configWith({
    checkpoints: ["/models/checkpoints"],
    gligen: ["/models/gligen"],
  }));
  assertEquals(paths.gligen, ["/models/gligen"]);
});
