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
      breezetts2: [],
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
  assertThrows(
    () => validatePartialConfig({ ui: { layout: { generate: "sideways" } } }),
    ConfigError,
    "one of columns, split, wide, top, top-split, media-split, media",
  );
  assertThrows(
    () => validatePartialConfig({ import: { civitai: "yes" } }),
    ConfigError,
    'unknown key "civitai"',
  );
  assertThrows(
    () => validatePartialConfig({ import: { browsing_level: "31" } }),
    ConfigError,
    "config.import.browsing_level: expected a whole number",
  );
  assertThrows(
    () => validatePartialConfig({ import: { samples: -1 } }),
    ConfigError,
    "config.import.samples: expected a whole number",
  );
});

/**
 * DESIGN-MODEL-IMPORT §8. Two levels rather than one because they answer two
 * questions: what a lookup may *see*, and what may be *kept*.
 */
Deno.test("the import block defaults, and what a layer may override", () => {
  const base = defaultConfig().import;
  assertEquals(base.civitai_url, "https://civitai.red");
  assertEquals(base.archive_url, "https://civitaiarchive.com");
  assertEquals(base.browsing_level, 31);
  assertEquals(base.nsfw_level, 1);
  assertEquals(base.dir, null);
  assertEquals(base.model_dir, null);

  const layered = effectiveConfig({ import: { nsfw_level: 31, samples: 8 } });
  assertEquals(layered.import.nsfw_level, 31);
  assertEquals(layered.import.samples, 8);
  // Everything the layer did not mention keeps its default.
  assertEquals(layered.import.civitai_url, "https://civitai.red");
  assertEquals(layered.import.ingest_on_boot, true);
});

Deno.test("import.dir and import.model_dir move the folders", () => {
  const under = dataPaths("/data");
  assertEquals(under.imports, "/data/import");
  assertEquals(under.downloads, "/data/models");

  const moved = dataPaths("/data", { dir: "/mnt/share/in", model_dir: null });
  assertEquals(moved.imports, "/mnt/share/in");
  assertEquals(moved.downloads, "/data/models");

  // A relative path is relative to the data directory, not the cwd.
  const relative = dataPaths("/data", { dir: "inbox", model_dir: "weights" });
  assertEquals(relative.imports, "/data/inbox");
  assertEquals(relative.downloads, "/data/weights");
});

/**
 * The arrangement of the three panes (§11.3). It is a per-screen key like
 * the tile size, and `sidebar_collapsed` — which it supersedes — is still
 * accepted, because a config.yaml written before it exists must still load.
 */
Deno.test("the layout is a per-screen preference, and the old key still loads", async () => {
  await withTempDir(async (dir) => {
    const { store } = await loadConfig({ dataDir: dir });
    assertEquals(store.config.ui.layout, {
      generate: "columns",
      gallery: "columns",
      models: "columns",
    });

    // One of the two that hide the inputs panel, so the round-trip covers a
    // layout added after the file format was.
    await store.patch({ ui: { layout: { generate: "media" } } });
    const reloaded = (await loadConfig({ dataDir: dir })).store;
    assertEquals(reloaded.config.ui.layout, {
      generate: "media",
      gallery: "columns",
      models: "columns",
    });

    // The key the layouts replaced is still a key.
    const older = validatePartialConfig({
      ui: { sidebar_collapsed: { gallery: true } },
    });
    assertEquals(older.ui?.sidebar_collapsed, { gallery: true });
  });
});

Deno.test("an empty config.yaml means all defaults", () => {
  assertEquals(parseConfigDocument("", "config.yaml"), {});
  assertEquals(parseConfigDocument("# just a comment\n", "config.yaml"), {});
  assertEquals(effectiveConfig({}), defaultConfig());
});

Deno.test("a default that changed reaches a config already on disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-config-" });
  try {
    // What an earlier build wrote as its own defaults. A first run persists
    // the whole tree, so every value in it is frozen against later changes:
    // the stored array wins the merge, and `a`/`d` never arrived.
    await Deno.writeTextFile(
      dataPaths(dir).configFile,
      [
        "keys:",
        "  select_prev: [ArrowLeft]",
        "  select_next: [ArrowRight]",
        "  select_up: [ArrowUp]",
        "  select_down: [ArrowDown]",
        "  fullscreen: [f]",
        "  close: [Escape]",
        "",
      ].join("\n"),
    );
    const { store } = await loadConfig({ dataDir: dir });
    assertEquals(store.config.keys.select_prev, ["ArrowLeft", "a"]);
    assertEquals(store.config.keys.select_next, ["ArrowRight", "d"]);
    assertEquals(store.config.keys.select_up, ["ArrowUp", "w"]);
    assertEquals(store.config.keys.select_down, ["ArrowDown", "s"]);

    // And it is written back, so the file says what the app is doing.
    const after = parseYaml(
      await Deno.readTextFile(dataPaths(dir).configFile),
    ) as Record<string, unknown>;
    assertEquals(
      (after.keys as Record<string, string[]>).select_prev,
      ["ArrowLeft", "a"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bindings somebody chose are left exactly as they are", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-config-" });
  try {
    // One binding differs from every default this app has shipped, so the
    // block was edited and none of it is ours to move.
    await Deno.writeTextFile(
      dataPaths(dir).configFile,
      [
        "keys:",
        "  select_prev: [h]",
        "  select_next: [ArrowRight]",
        "  select_up: [ArrowUp]",
        "  select_down: [ArrowDown]",
        "  fullscreen: [f]",
        "  close: [Escape]",
        "",
      ].join("\n"),
    );
    const { store } = await loadConfig({ dataDir: dir });
    assertEquals(store.config.keys.select_prev, ["h"]);
    assertEquals(store.config.keys.select_next, ["ArrowRight"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
