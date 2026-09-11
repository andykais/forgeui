import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  ConfigError,
  DATA_DIR_ENV,
  effectiveConfig,
  loadConfig,
  mergePartialConfig,
  parseConfigDocument,
  resolveDataDir,
} from "../../src/config/config.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { dataPaths } from "../../src/config/paths.ts";
import { validatePartialConfig } from "../../src/config/validate.ts";

const noEnv = { get: () => undefined };

function envWith(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

async function withTempDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-config-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("data dir: --data-dir beats the env var beats ~/.forgeui", () => {
  const env = envWith({ [DATA_DIR_ENV]: "/from/env", HOME: "/home/nt" });
  assertEquals(resolveDataDir({ flag: "/from/flag", env }), "/from/flag");
  assertEquals(resolveDataDir({ env }), "/from/env");
  assertEquals(
    resolveDataDir({ env: envWith({ HOME: "/home/nt" }) }),
    "/home/nt/.forgeui",
  );
});

Deno.test("data dir: relative paths are resolved", () => {
  const resolved = resolveDataDir({ flag: "./data", env: noEnv });
  assert(resolved.startsWith("/"), resolved);
  assert(resolved.endsWith("/data"), resolved);
});

Deno.test("data dir: no home and no flag is an error", () => {
  assertThrows(() => resolveDataDir({ env: noEnv }), ConfigError);
});

Deno.test("first run writes config.yaml with defaults and a keys block", async () => {
  await withTempDir(async (dir) => {
    const { store, created } = await loadConfig({ dataDir: dir });
    assert(created);
    assertEquals(store.config, defaultConfig());

    const text = await Deno.readTextFile(dataPaths(dir).configFile);
    const parsed = parseYaml(text) as Record<string, unknown>;
    assertEquals(parsed.keys, {
      // WASD beside the arrows; a list is alternates, not a chord (§11.4).
      select_prev: ["ArrowLeft", "a"],
      select_next: ["ArrowRight", "d"],
      select_up: ["ArrowUp", "w"],
      select_down: ["ArrowDown", "s"],
      fullscreen: ["f"],
      close: ["Escape"],
    });
    // Every known kind is written out empty, so pointing one somewhere is
    // an edit rather than a guess at the key's name (§3).
    assertEquals(parsed.model_folders, {
      checkpoints: [],
      "Stable-Diffusion": [],
      diffusion_models: [],
      unet: [],
      loras: [],
      vae: [],
      text_encoders: [],
      controlnet: [],
      upscale_models: [],
      latent_upscale_models: [],
      embeddings: [],
    });

    // A second boot reads the file instead of recreating it.
    const again = await loadConfig({ dataDir: dir });
    assertEquals(again.created, false);
    assertEquals(again.store.config, defaultConfig());
  });
});

Deno.test("first run creates the whole data directory layout", async () => {
  await withTempDir(async (dir) => {
    await loadConfig({ dataDir: dir });
    const paths = dataPaths(dir);
    for (
      const path of [
        paths.bundledWorkflows,
        paths.userWorkflows,
        paths.outputs,
        paths.inputs,
        paths.samples,
        paths.modelsMeta,
        paths.staging,
        paths.comfyInput,
      ]
    ) {
      assert((await Deno.stat(path)).isDirectory, `${path} is missing`);
    }
  });
});

Deno.test("config round-trips through the file", async () => {
  await withTempDir(async (dir) => {
    const { store } = await loadConfig({ dataDir: dir });
    await store.patch({
      comfy: { path: "/opt/ComfyUI", mode: "local_url" },
      ui: { rail_expanded: true, tile_size: { gallery: "table" } },
      keys: { fullscreen: ["f", "F11"] },
    });

    const reloaded = (await loadConfig({ dataDir: dir })).store;
    assertEquals(reloaded.config, store.config);
    assertEquals(reloaded.config.comfy.path, "/opt/ComfyUI");
    assertEquals(reloaded.config.comfy.mode, "local_url");
    assertEquals(reloaded.config.ui.tile_size, {
      generate: "small",
      gallery: "table",
      models: "small",
    });
    assertEquals(reloaded.config.keys.fullscreen, ["f", "F11"]);
    // Untouched keys keep their defaults.
    assertEquals(reloaded.config.comfy.url, defaultConfig().comfy.url);
  });
});

Deno.test("CLI overrides apply for the run but are never written back", async () => {
  await withTempDir(async (dir) => {
    const { store } = await loadConfig({
      dataDir: dir,
      overrides: {
        server: { port: 9999 },
        comfy: { url: "http://127.0.0.1:9188" },
        model_folders: { loras: ["/mnt/models/loras"] },
      },
    });
    assertEquals(store.config.server.port, 9999);
    assertEquals(store.config.model_folders.loras, ["/mnt/models/loras"]);
    assertEquals(store.overriddenPaths, [
      "comfy.url",
      "model_folders.loras",
      "server.port",
    ]);

    // A write triggered by Settings must not persist the override.
    await store.patch({ ui: { rail_expanded: true } });
    const onDisk = parseConfigDocument(
      await Deno.readTextFile(dataPaths(dir).configFile),
      "config.yaml",
    );
    assertEquals(onDisk.server?.port, defaultConfig().server.port);
    assertEquals(onDisk.comfy?.url, defaultConfig().comfy.url);
    assertEquals(onDisk.model_folders?.loras, []);
    assertEquals(onDisk.ui?.rail_expanded, true);

    // And the override still wins in memory.
    assertEquals(store.config.server.port, 9999);
  });
});

Deno.test("model folders are launch-time only", async () => {
  await withTempDir(async (dir) => {
    const { store } = await loadConfig({ dataDir: dir });
    await assertRejects(
      () => store.patch({ model_folders: { loras: ["/mnt/x"] } }),
      ConfigError,
      "read at launch",
    );
  });
});

Deno.test("an unreadable config.yaml fails loudly", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/config.yaml`, "comfy:\n  mode: turbo\n");
    await assertRejects(
      () => loadConfig({ dataDir: dir }),
      ConfigError,
      "config.yaml.comfy.mode: expected one of managed, local_url",
    );
  });
});

Deno.test("validation rejects unknown keys and wrong types", () => {
  assertThrows(
    () => validatePartialConfig({ comfyui: {} }),
    ConfigError,
    'unknown key "comfyui"',
  );
  assertThrows(
    () => validatePartialConfig({ keys: { generate: ["g"] } }),
    ConfigError,
    'unknown key "generate"',
  );
  assertThrows(
    () => validatePartialConfig({ keys: { fullscreen: [] } }),
    ConfigError,
    "at least one key name",
  );
  assertThrows(
    () => validatePartialConfig({ server: { port: "7777" } }),
    ConfigError,
    "config.server.port: expected an integer",
  );
  assertThrows(
    () => validatePartialConfig({ ui: { tile_size: { gallery: "huge" } } }),
    ConfigError,
    "one of small, large, table",
  );
  assertThrows(
    () => validatePartialConfig({ ui: { tile_size: { nowhere: "small" } } }),
    ConfigError,
    'unknown key "nowhere"',
  );
});

Deno.test("an empty config.yaml means all defaults", () => {
  assertEquals(parseConfigDocument("", "config.yaml"), {});
  assertEquals(parseConfigDocument("# just a comment\n", "config.yaml"), {});
  assertEquals(effectiveConfig({}), defaultConfig());
});

Deno.test("layers merge per key, deepest last", () => {
  const merged = mergePartialConfig(
    {
      comfy: { mode: "managed", path: "/a" },
      ui: { tile_size: { gallery: "small" } },
    },
    { comfy: { path: "/b" }, ui: { tile_size: { models: "table" } } },
  );
  assertEquals(merged.comfy, { mode: "managed", path: "/b" });
  assertEquals(merged.ui?.tile_size, { gallery: "small", models: "table" });
});
