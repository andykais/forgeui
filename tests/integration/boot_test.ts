import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { withTestApp } from "../fixtures/app.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { SCHEMA_VERSION, schemaVersion } from "../../src/db/db.ts";
import type { Config } from "../../src/config/types.ts";

Deno.test("the server boots against a temp data dir on the first run", async () => {
  await withTestApp(async (app) => {
    assert(app.createdConfig);
    assert(app.port > 0);
    assertEquals(app.paths.root, app.dataDir);
    assertEquals(schemaVersion(app.db), SCHEMA_VERSION);

    // config.yaml, extra_model_paths.yaml and app.db all exist after boot.
    for (
      const path of [
        app.paths.configFile,
        app.paths.extraModelPaths,
        app.paths.db,
      ]
    ) {
      assert((await Deno.stat(path)).isFile, `${path} is missing`);
    }
    // No model folders are configured on a first run, but the download
    // folder is listed under every kind regardless: a model fetched by
    // `forge models --download-model` has to resolve by name even on an
    // install that has pointed ComfyUI at nothing (DESIGN-MODEL-IMPORT §7.2).
    const extraModelPaths = await Deno.readTextFile(app.paths.extraModelPaths);
    assertStringIncludes(extraModelPaths, "forgeui:");
    assertStringIncludes(
      extraModelPaths,
      `${app.paths.downloads}/checkpoints`,
    );
    assert(
      !extraModelPaths.includes("/nowhere"),
      "nothing but the download folder should be listed",
    );

    const response = await app.fetch("/");
    assertEquals(response.status, 200);
    assertStringIncludes(await response.text(), "ForgeUI");
  });
});

Deno.test("GET /api/config serves the effective config", async () => {
  await withTestApp(async (app) => {
    const response = await app.fetch("/api/config");
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    const config = await response.json() as Config;
    // The test harness passes --port 0, which the OS resolved for this run.
    assertEquals(config.server.port, 0);
    assertEquals(config.comfy, defaultConfig().comfy);
    assertEquals(config.keys, defaultConfig().keys);
    assertEquals(config.ui, defaultConfig().ui);
  });
});

Deno.test("PATCH /api/config round-trips through config.yaml", async () => {
  await withTestApp(async (app) => {
    const patched = await app.fetch("/api/config", {
      method: "PATCH",
      body: JSON.stringify({
        comfy: { path: "/opt/ComfyUI" },
        ui: { rail_expanded: true, sidebar_collapsed: { gallery: true } },
      }),
    });
    assertEquals(patched.status, 200);
    const config = await patched.json() as Config;
    assertEquals(config.comfy.path, "/opt/ComfyUI");
    assertEquals(config.ui.rail_expanded, true);
    assertEquals(config.ui.sidebar_collapsed.gallery, true);

    const onDisk = parseYaml(
      await Deno.readTextFile(app.paths.configFile),
    ) as Record<string, Record<string, unknown>>;
    assertEquals(onDisk.comfy?.path, "/opt/ComfyUI");
    assertEquals(onDisk.ui?.rail_expanded, true);
    // --port 0 came from the CLI, so it must not have been written back.
    assertEquals(onDisk.server?.port, defaultConfig().server.port);

    const reread = await (await app.fetch("/api/config")).json() as Config;
    assertEquals(reread, config);
  });
});

Deno.test("PATCH /api/config rejects bad input without writing", async () => {
  await withTestApp(async (app) => {
    const before = await Deno.readTextFile(app.paths.configFile);

    for (
      const [body, expected] of [
        ['{"model_folders":{"loras":["/mnt/x"]}}', "read at launch"],
        ['{"comfy":{"mode":"turbo"}}', "one of managed, local_url"],
        ['{"nonsense":true}', 'unknown key "nonsense"'],
        ["{oops", "invalid JSON body"],
      ] as const
    ) {
      const response = await app.fetch("/api/config", {
        method: "PATCH",
        body,
      });
      assertEquals(response.status, 400, body);
      const payload = await response.json() as {
        error: { code: string; message: string };
      };
      assertEquals(payload.error.code, "bad_request");
      assertStringIncludes(payload.error.message, expected);
    }

    assertEquals(await Deno.readTextFile(app.paths.configFile), before);
  });
});

Deno.test("a hand-written config.yaml is honoured on boot", async () => {
  await withTestApp(async (app) => {
    const config = await (await app.fetch("/api/config")).json() as Config;
    assertEquals(config.comfy.mode, "local_url");
    assertEquals(config.comfy.url, "http://127.0.0.1:9999");
    assertEquals(config.keys.fullscreen, ["f", "F11"]);
    // Kinds the file omits stay in the map as empty lists, so Settings can
    // still list every known kind.
    assertEquals(config.model_folders, {
      checkpoints: ["/mnt/models/checkpoints"],
      "Stable-Diffusion": [],
      diffusion_models: [],
      unet: [],
      loras: ["/mnt/models/loras"],
      vae: [],
      text_encoders: [],
      controlnet: [],
      upscale_models: [],
      latent_upscale_models: [],
      embeddings: [],
      breezetts2: [],
    });
    assertEquals(app.createdConfig, false);

    // Folders reach ComfyUI through the generated file, not through the app,
    // and a diffusion folder is written under both keys so either loader
    // resolves a name the one picker offered (§4).
    const extra = await Deno.readTextFile(app.paths.extraModelPaths);
    assertStringIncludes(
      extra,
      "  checkpoints: |-\n    /mnt/models/checkpoints",
    );
    assertStringIncludes(
      extra,
      "  diffusion_models: |-\n    /mnt/models/checkpoints",
    );
    assertStringIncludes(extra, "  loras: |-\n    /mnt/models/loras");
  }, {
    files: {
      "config.yaml": [
        "comfy:",
        "  mode: local_url",
        "  url: http://127.0.0.1:9999",
        "model_folders:",
        "  checkpoints: [/mnt/models/checkpoints]",
        "  loras: [/mnt/models/loras]",
        "keys:",
        "  fullscreen: [f, F11]",
        "",
      ].join("\n"),
    },
  });
});

Deno.test("CLI model folders override the file for one run only", async () => {
  await withTestApp(async (app) => {
    const config = await (await app.fetch("/api/config")).json() as Config;
    assertEquals(config.model_folders.loras, ["/mnt/override/loras"]);

    await app.fetch("/api/config", {
      method: "PATCH",
      body: '{"ui":{"rail_expanded":true}}',
    });
    const onDisk = parseYaml(
      await Deno.readTextFile(app.paths.configFile),
    ) as Record<string, Record<string, unknown>>;
    assertEquals(onDisk.model_folders?.loras, ["/mnt/file/loras"]);
  }, {
    argv: ["--models-dir", "loras=/mnt/override/loras"],
    files: {
      "config.yaml": "model_folders:\n  loras: [/mnt/file/loras]\n",
    },
  });
});

Deno.test("unknown routes and methods answer in JSON", async () => {
  await withTestApp(async (app) => {
    const missing = await app.fetch("/api/nothing-here");
    assertEquals(missing.status, 404);
    assertEquals(
      (await missing.json() as { error: { code: string } }).error.code,
      "not_found",
    );

    const wrongMethod = await app.fetch("/api/config", { method: "POST" });
    assertEquals(wrongMethod.status, 405);
    assertEquals(wrongMethod.headers.get("allow"), "GET, PATCH");
    await wrongMethod.body?.cancel();
  });
});

/**
 * `import.civitai_token` is a credential (DESIGN-MODEL-IMPORT §8). Storing it
 * safely on disk is out of scope; not handing it to every HTTP client that
 * can reach this port — the browser, the MCP bridge, a published container
 * port — is not.
 */
Deno.test("the Civitai token is never served by /api/config", async () => {
  await withTestApp(async (app) => {
    const secret = "0123456789abcdef0123456789abcdef";
    const patched = await app.json<Config>("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ import: { civitai_token: secret } }),
    });
    // Not in the PATCH echo…
    assertEquals(patched.import.civitai_token, "(hidden)");
    // …not in a GET…
    const read = await app.json<Config>("/api/config");
    assertEquals(read.import.civitai_token, "(hidden)");
    // …and not anywhere in the raw body, however it might be nested.
    const raw = await (await app.fetch("/api/config")).text();
    assert(!raw.includes(secret), "the token leaked into GET /api/config");

    // But it is really there, where the CLI reads it.
    assertEquals(app.config.config.import.civitai_token, secret);
    assertStringIncludes(await Deno.readTextFile(app.paths.configFile), secret);
  });
});

Deno.test("echoing the redacted config back does not clobber the token", async () => {
  await withTestApp(async (app) => {
    const secret = "fedcba9876543210fedcba9876543210";
    await app.json("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ import: { civitai_token: secret } }),
    });
    // A client that round-trips what it was given sends the marker back.
    const read = await app.json<Config>("/api/config");
    await app.json("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ import: read.import }),
    });
    assertEquals(app.config.config.import.civitai_token, secret);
  });
});

Deno.test("an unset token reads as null, not as hidden", async () => {
  await withTestApp(async (app) => {
    // The marker means "one is set"; showing it when none is would lie.
    const read = await app.json<Config>("/api/config");
    assertEquals(read.import.civitai_token, null);
  });
});
