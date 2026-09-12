import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import { sha256Of, writeFakeSafetensors } from "../fixtures/models.ts";
import type { ModelView } from "../../src/models/library.ts";
import type { JobRow } from "../../src/db/queries.ts";

/**
 * The model library through its routes (§12): scan, hash, edit, and the
 * `output_models` rows that make an output findable from the model that made
 * it (§8.1). Every assertion goes through HTTP; the database is only read
 * afterwards to check what the routes did.
 */

const CHECKPOINT = "v1-5-pruned-emaonly-fp16.safetensors";

interface ModelsResponse {
  kind: string | null;
  class: string | null;
  classes: Record<string, string>;
  folders: string[];
  models: ModelView[];
  progress: {
    rescan: { running: boolean; models: number };
    hashing: { running: boolean; done: number; total: number };
  };
}

interface Fixtures {
  dir: string;
  checkpoints: string;
  loras: string;
  argv: string[];
}

/** A model folder per kind, with the checkpoint `sd15` names. */
async function modelFixtures(): Promise<Fixtures> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-model-folders-" });
  const checkpoints = join(dir, "checkpoints");
  const loras = join(dir, "loras");
  await writeFakeSafetensors(join(checkpoints, CHECKPOINT), { name: "sd15" });
  await writeFakeSafetensors(join(loras, "film-grain-35mm.safetensors"), {
    name: "grain",
  });
  await writeFakeSafetensors(join(loras, "soft-studio-light.safetensors"), {
    name: "soft",
    bytes: 2048,
  });
  return {
    dir,
    checkpoints,
    loras,
    argv: [
      "--models-dir",
      `checkpoints=${checkpoints}`,
      "--models-dir",
      `loras=${loras}`,
    ],
  };
}

async function withModels(
  body: (app: TestApp, fixtures: Fixtures) => Promise<void>,
  options: { comfy?: boolean } = {},
): Promise<void> {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(
      (app) => body(app, fixtures),
      { argv: fixtures.argv, comfy: options.comfy },
    );
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
}

/** Scan and hash the way the boot and the Rescan button do. */
async function scanAndHash(app: TestApp): Promise<void> {
  await app.json("/api/maintenance/rescan-models", { method: "POST" });
  await app.models.idle();
}

/**
 * ComfyUI's events reach the app over a websocket, so a returned job row does
 * not mean a finished one: wait for the row to settle.
 */
async function awaitJob(app: TestApp, id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let status = "";
  while (!["done", "failed", "cancelled"].includes(status)) {
    if (Date.now() > deadline) {
      throw new Error(`job ${id} was still "${status}" after 5s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<JobRow>(`/api/jobs/${id}`)).status;
  }
  await app.jobs.idle();
}

async function models(
  app: TestApp,
  query = "",
): Promise<ModelsResponse> {
  return await app.json<ModelsResponse>(`/api/models${query}`);
}

Deno.test("the response says what class each configured folder holds", async () => {
  await withModels(async (app) => {
    const listed = await models(app);
    // The Models screen groups its tabs by this rather than by folder: the
    // four folders a generatable model can sit in are one tab (§8.2).
    assertEquals(listed.classes.checkpoints, "diffusion");
    assertEquals(listed.classes.unet, "diffusion");
    assertEquals(listed.classes.diffusion_models, "diffusion");
    assertEquals(listed.classes["Stable-Diffusion"], "diffusion");
    assertEquals(listed.classes.loras, "lora");
    assertEquals(listed.classes.vae, "vae");
    assertEquals(listed.classes.text_encoders, "clip");
    // Every configured folder is in the map, even one with nothing in it.
    assertEquals(
      Object.keys(listed.classes).sort(),
      Object.keys(app.config.config.model_folders).sort(),
    );
  });
});

Deno.test("scanned models are listed before they are hashed", async () => {
  await withModels(async (app) => {
    // The route scans on demand when the background pass has not run.
    const before = await models(app, "?kind=loras");
    assertEquals(before.models.length, 2);
    assert(before.models.every((model) => model.hashing));
    assert(before.models.every((model) => model.hash === null));
    assert(
      before.models.every((model) => model.id.startsWith("path:")),
      "an unhashed model is addressed by its path",
    );
    assertEquals(before.models[0]?.display_name, "film-grain-35mm");
    assertEquals(before.models[0]?.family, "unset");
    assertEquals(before.models[0]?.output_count, 0);
    assertEquals(before.folders.length, 1);

    // Editing has to wait for the hash (§8.1).
    const rejected = await app.fetch(`/api/models/${before.models[0]!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Film grain" }),
    });
    assertEquals(rejected.status, 409);
    const body = await rejected.json() as { error: { code: string } };
    assertEquals(body.error.code, "hashing");
  });
});

Deno.test("one class lists every diffusion folder at once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-classes-" });
  try {
    const checkpoints = join(dir, "checkpoints");
    const diffusion = join(dir, "diffusion_models");
    const loras = join(dir, "loras");
    await writeFakeSafetensors(join(checkpoints, "sdxl.safetensors"), {
      name: "sdxl",
    });
    await writeFakeSafetensors(join(diffusion, "flux1-dev.safetensors"), {
      name: "flux",
    });
    await writeFakeSafetensors(join(loras, "grain.safetensors"), {
      name: "grain",
    });
    await withTestApp(async (app) => {
      // Two folders, one class: what a workflow's model picker asks for.
      const listed = await models(app, "?class=diffusion");
      assertEquals(listed.class, "diffusion");
      assertEquals(
        listed.models.map((model) => model.name).sort(),
        ["flux1-dev.safetensors", "sdxl.safetensors"],
      );
      assert(listed.models.every((model) => model.class === "diffusion"));
      assertEquals(listed.folders.sort(), [checkpoints, diffusion].sort());

      // A LoRA is a different class and stays out of it.
      const loraClass = await models(app, "?class=lora");
      assertEquals(loraClass.models.map((model) => model.name), [
        "grain.safetensors",
      ]);

      // The folder a model came from is still reported as its kind.
      const byKind = await models(app, "?kind=diffusion_models");
      assertEquals(byKind.models.map((model) => model.name), [
        "flux1-dev.safetensors",
      ]);

      // class and q compose.
      const searched = await models(app, "?class=diffusion&q=flux");
      assertEquals(searched.models.map((model) => model.name), [
        "flux1-dev.safetensors",
      ]);

      const bad = await app.fetch("/api/models?class=nonsense");
      assertEquals(bad.status, 400);
    }, {
      argv: [
        "--models-dir",
        `checkpoints=${checkpoints}`,
        "--models-dir",
        `diffusion_models=${diffusion}`,
        "--models-dir",
        `loras=${loras}`,
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a model's family is read from its header, and the user overrides it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-family-" });
  try {
    const checkpoints = join(dir, "checkpoints");
    const diffusion = join(dir, "diffusion_models");
    await writeFakeSafetensors(join(checkpoints, "someSDXL.safetensors"), {
      name: "sdxl",
      tensors: [
        "model.diffusion_model.input_blocks.0.0.weight",
        "model.diffusion_model.label_emb.0.0.weight",
      ],
    });
    await writeFakeSafetensors(join(diffusion, "flux1-dev.safetensors"), {
      name: "flux",
      tensors: [
        "double_blocks.0.img_attn.norm.key_norm.weight",
        "img_in.weight",
      ],
    });
    await writeFakeSafetensors(join(diffusion, "mystery.safetensors"), {
      name: "mystery",
    });
    await withTestApp(async (app) => {
      await scanAndHash(app);
      const listed = await models(app, "?class=diffusion");
      const byName = new Map(
        listed.models.map((model) => [model.name, model]),
      );
      // Nobody filed any of these; the header did (§6).
      assertEquals(byName.get("someSDXL.safetensors")?.family, "sdxl");
      assertEquals(byName.get("flux1-dev.safetensors")?.family, "flux");
      // An architecture the probe does not know stays unfiled rather than
      // being guessed at.
      assertEquals(byName.get("mystery.safetensors")?.family, "unset");

      // What the user says wins over what the file says.
      const flux = byName.get("flux1-dev.safetensors")!;
      const patched = await app.json(`/api/models/${flux.id}`, {
        method: "PATCH",
        body: JSON.stringify({ family: "sd15" }),
      }) as ModelView;
      assertEquals(patched.family, "sd15");
      const after = await models(app, "?class=diffusion");
      assertEquals(
        after.models.find((model) => model.name === "flux1-dev.safetensors")
          ?.family,
        "sd15",
      );

      // Clearing it falls back to the header again, not to unset.
      const cleared = await app.json(`/api/models/${flux.id}`, {
        method: "PATCH",
        body: JSON.stringify({ family: "unset" }),
      }) as ModelView;
      assertEquals(cleared.family, "flux");
    }, {
      argv: [
        "--models-dir",
        `checkpoints=${checkpoints}`,
        "--models-dir",
        `diffusion_models=${diffusion}`,
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a model a workflow names but the folders do not hold is refused", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-missing-" });
  try {
    const checkpoints = join(dir, "checkpoints");
    await writeFakeSafetensors(join(checkpoints, "real.safetensors"), {
      name: "real",
    });
    await withTestApp(async (app) => {
      await scanAndHash(app);
      const response = await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "illustrious",
          params: { prompt: "figs", model: "not-on-disk.safetensors" },
        }),
      });
      // Refused before anything is queued, naming the param and the value so
      // it can be fixed in the panel rather than in a ComfyUI log.
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertStringIncludes(body.error.message, "not in your model folders");
      assertStringIncludes(body.error.message, "not-on-disk.safetensors");

      // One that is there passes the check.
      const ok = await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "illustrious",
          params: { prompt: "figs", model: "real.safetensors" },
        }),
      });
      // No ComfyUI in this app, so it stops later — but not as a bad param.
      assertEquals(ok.status, 503);
    }, { argv: ["--models-dir", `checkpoints=${checkpoints}`] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hashing fills in identity, and only re-reads what changed", async () => {
  await withModels(async (app, fixtures) => {
    await scanAndHash(app);

    const listed = await models(app);
    assertEquals(listed.models.length, 3);
    assert(listed.models.every((model) => !model.hashing));
    assertEquals(listed.progress.hashing.running, false);
    assertEquals(listed.progress.hashing.done, 3);

    const checkpoint = listed.models.find((model) =>
      model.filename === CHECKPOINT
    )!;
    assert(checkpoint, "the checkpoint is listed");
    assertEquals(
      checkpoint.hash,
      await sha256Of(
        await Deno.readFile(join(fixtures.checkpoints, CHECKPOINT)),
      ),
    );
    assertEquals(checkpoint.id, checkpoint.hash);
    assertEquals(checkpoint.kind, "checkpoints");
    assertEquals(checkpoint.present, true);

    // A second pass has nothing to do, and says so as 0 of 0 rather than
    // carrying the last pass's totals forward.
    await scanAndHash(app);
    assertEquals((await models(app)).progress.hashing.done, 0);
    assertEquals((await models(app)).progress.hashing.total, 0);

    // …until a file changes, which is decided on size and mtime.
    await writeFakeSafetensors(join(fixtures.checkpoints, CHECKPOINT), {
      name: "sd15-v2",
      bytes: 4096,
    });
    await scanAndHash(app);
    const rehashed = (await models(app, "?kind=checkpoints")).models[0]!;
    assert(
      rehashed.hash !== checkpoint.hash,
      "the rewritten file has a new hash",
    );
    assertEquals(
      app.db.prepare("SELECT count(*) FROM models").value<[number]>()?.[0],
      3,
      "the row for that path was replaced, not duplicated",
    );
  });
});

Deno.test("a hashed model can be named, filed and tagged", async () => {
  await withModels(async (app) => {
    await scanAndHash(app);
    const lora = (await models(app, "?kind=loras")).models[0]!;

    const patched = await app.json<ModelView>(`/api/models/${lora.hash}`, {
      method: "PATCH",
      body: JSON.stringify({
        display_name: "  Film grain 35mm  ",
        family: "sd15",
        notes: "Subtle at 0.4",
        tags: ["film", "grain", "film", "  "],
      }),
    });
    assertEquals(patched.display_name, "Film grain 35mm");
    assertEquals(patched.family, "sd15");
    assertEquals(patched.notes, "Subtle at 0.4");
    assertEquals(patched.tags, ["film", "grain"]);
    // The filename is immutable and keeps naming the file (§8.1).
    assertEquals(patched.filename, lora.filename);
    assertEquals(patched.name, lora.name);

    // It survives a fetch by hash, and a rescan.
    assertEquals(
      (await app.json<ModelView>(`/api/models/${lora.hash}`)).display_name,
      "Film grain 35mm",
    );
    await scanAndHash(app);
    assertEquals(
      (await app.json<ModelView>(`/api/models/${lora.hash}`)).display_name,
      "Film grain 35mm",
    );

    // Clearing the display name falls back to the filename (§8.1).
    const cleared = await app.json<ModelView>(`/api/models/${lora.hash}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "" }),
    });
    assertEquals(cleared.display_name, "film-grain-35mm");

    // `q` searches display name, filename and tags; family filters.
    assertEquals((await models(app, "?q=grain")).models.length, 1);
    assertEquals((await models(app, "?q=FILM")).models.length, 1);
    assertEquals((await models(app, "?family=sd15")).models.length, 1);
    assertEquals((await models(app, "?family=unset")).models.length, 2);
    assertEquals((await models(app, "?q=nothing")).models.length, 0);

    // `tags` asks for tags and nothing else: `q=film` also matches the
    // filename, where this only matches the tag.
    assertEquals((await models(app, "?tags=film")).models.length, 1);
    assertEquals((await models(app, "?tags=FILM")).models.length, 1);
    // Several narrow rather than widen.
    assertEquals((await models(app, "?tags=film,grain")).models.length, 1);
    assertEquals((await models(app, "?tags=film,nope")).models.length, 0);
    // A model with no tags is not matched by a tag search.
    assertEquals((await models(app, "?tags=anything")).models.length, 0);
    // An empty ask is not a tag everything carries.
    assertEquals(
      (await models(app, "?tags=")).models.length,
      (await models(app)).models.length,
    );
    assertEquals(
      (await models(app, "?tags=%20,%20")).models.length,
      (await models(app)).models.length,
    );
  });
});

Deno.test("one model can be re-read past the caches", async () => {
  await withModels(async (app, fixtures) => {
    // A LoRA whose keys actually say what it is.
    await writeFakeSafetensors(join(fixtures.loras, "fluxy.safetensors"), {
      name: "fluxy",
      tensors: ["lora_unet_double_blocks_0_img_attn_qkv.lora_up.weight"],
    });
    await scanAndHash(app);
    const model = (await models(app, "?kind=loras")).models.find((entry) =>
      entry.name === "fluxy.safetensors"
    )!;
    assertEquals(model.family, "flux");

    // An ordinary rescan reads nothing: its whole job is to skip files that
    // have not moved, which is exactly why it cannot fix a wrong cached
    // answer. A pass with nothing to do is 0 of 0 (§8.1).
    await scanAndHash(app);
    assertEquals((await models(app)).progress.hashing.total, 0);

    // Re-reading one file does read it, cache or no cache.
    const reread = await app.json<ModelView>(
      `/api/models/${model.id}/rescan`,
      { method: "POST" },
    );
    assertEquals(reread.family, "flux");
    assertEquals(reread.hash, model.hash, "the file did not change");
    assertEquals(
      (await models(app)).progress.hashing.total,
      1,
      "the re-read should have hashed exactly one file",
    );

    // A model that is not there is a 404, not a crash.
    const missing = await app.fetch(`/api/models/${"f".repeat(64)}/rescan`, {
      method: "POST",
    });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  });
});

Deno.test("a family the config hides takes its models with it", async () => {
  await withModels(async (app, fixtures) => {
    await writeFakeSafetensors(join(fixtures.loras, "fluxy.safetensors"), {
      name: "fluxy",
      tensors: ["lora_unet_double_blocks_0_img_attn_qkv.lora_up.weight"],
    });
    await scanAndHash(app);
    const listed = () =>
      models(app, "?kind=loras").then((body) =>
        body.models.map((entry) => entry.name)
      );
    assert((await listed()).includes("fluxy.safetensors"));

    await app.json("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ ui: { hidden_families: ["flux"] } }),
    });

    // Gone from the list, exactly as a model hidden one at a time would be.
    assert(!(await listed()).includes("fluxy.safetensors"));
    // And back under Show hidden, which is what makes this reversible.
    const hidden = await models(app, "?kind=loras&hidden=1");
    assert(hidden.models.some((entry) => entry.name === "fluxy.safetensors"));
    assertEquals(
      hidden.models.find((entry) => entry.name === "fluxy.safetensors")?.hidden,
      true,
    );

    // The family itself is no longer one to file anything as.
    const families = await app.json<{ families: { family: string }[] }>(
      "/api/families",
    );
    assert(!families.families.some((entry) => entry.family === "flux"));

    // Turning it back on restores it; the per-model flag was never touched.
    await app.json("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ ui: { hidden_families: [] } }),
    });
    assert((await listed()).includes("fluxy.safetensors"));
  });
});

Deno.test("a bad family or an unknown model is refused", async () => {
  await withModels(async (app) => {
    await scanAndHash(app);
    const lora = (await models(app, "?kind=loras")).models[0]!;

    const badFamily = await app.fetch(`/api/models/${lora.hash}`, {
      method: "PATCH",
      body: JSON.stringify({ family: "sdxl-turbo" }),
    });
    assertEquals(badFamily.status, 400);
    assertStringIncludes(
      (await badFamily.json() as { error: { message: string } }).error.message,
      "expected one of",
    );

    const empty = await app.fetch(`/api/models/${lora.hash}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    assertEquals(empty.status, 400);
    await empty.body?.cancel();

    const missing = await app.fetch(`/api/models/${"f".repeat(64)}`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  });
});

Deno.test("families come back with model and workflow counts", async () => {
  await withModels(async (app) => {
    await scanAndHash(app);
    const lora = (await models(app, "?kind=loras")).models[0]!;
    await app.json(`/api/models/${lora.hash}`, {
      method: "PATCH",
      body: JSON.stringify({ family: "flux" }),
    });

    const { families } = await app.json<{
      families: { family: string; models: number; workflows: number }[];
    }>("/api/families");
    const byName = new Map(families.map((entry) => [entry.family, entry]));
    // The hardcoded list of §8.1, plus `unset`. Families are generational:
    // ltx and ltx-2 differ by text encoder, as do flux and flux2 (§6).
    assertEquals(
      families.map((entry) => entry.family).sort(),
      [
        "anima",
        "chroma",
        "flux",
        "flux2",
        "krea2",
        "ltx",
        "ltx-2",
        "qwen-image",
        "sd15",
        "sdxl",
        "unset",
        "wan2",
        "z-image",
      ],
    );
    assertEquals(byName.get("flux")?.models, 1);
    assertEquals(byName.get("unset")?.models, 2);
    // One bundled workflow is Flux.1, one FLUX.2, one Krea 2, one sd15 (§4.6).
    assertEquals(byName.get("flux")?.workflows, 1);
    assertEquals(byName.get("flux2")?.workflows, 1);
    // The enhancer is a checkbox on the one Krea 2 workflow, not a second
    // workflow of its own (§7.1).
    // The plain workflow and the upscale one (§10).
    assertEquals(byName.get("krea2")?.workflows, 2);
    assertEquals(byName.get("sd15")?.workflows, 1);
    assertEquals(byName.get("sd15")?.models, 0);
  });
});

Deno.test("storage reports what the data dir holds", async () => {
  await withModels(async (app) => {
    const storage = await app.json<{
      data_dir: string;
      outputs: { files: number; bytes: number };
      inputs: { files: number; bytes: number };
      samples: { files: number; bytes: number };
      db: { files: number; bytes: number };
      telemetry: { files: number; bytes: number };
      total: { files: number; bytes: number };
    }>("/api/system/storage");

    assertEquals(storage.data_dir, app.paths.root);
    assertEquals(storage.outputs, { files: 0, bytes: 0 });
    assertEquals(storage.samples, { files: 0, bytes: 0 });
    assert(storage.db.bytes > 0, "app.db is on disk");
    // The health log is counted on its own line: it grows by itself and is
    // safe to delete, which is not true of anything else here (§7.1).
    assert(storage.telemetry.bytes > 0, "telemetry.db is on disk");
    assertEquals(
      storage.total.files,
      storage.db.files + storage.telemetry.files,
    );

    await Deno.writeFile(
      join(app.paths.outputs, "2026", "09", "05", "one.png"),
      new Uint8Array(1234),
    ).catch(async () => {
      await Deno.mkdir(join(app.paths.outputs, "2026", "09", "05"), {
        recursive: true,
      });
      await Deno.writeFile(
        join(app.paths.outputs, "2026", "09", "05", "one.png"),
        new Uint8Array(1234),
      );
    });
    const after = await app.json<{ outputs: { files: number; bytes: number } }>(
      "/api/system/storage",
    );
    assertEquals(after.outputs, { files: 1, bytes: 1234 });
  });
});

Deno.test("rescan and hashing progress are pushed on /ws", async () => {
  await withModels(async (app) => {
    const socket = await app.socket();
    await scanAndHash(app);

    const rescan = socket.json("rescan_progress");
    assert(rescan.length > 0, "a rescan pushes progress");
    assertEquals(rescan.at(-1)?.data.running, false);
    assertEquals(rescan.at(-1)?.data.models, 3);

    // The events are pushed, so the client sees the end of the pass a moment
    // after the library does.
    const finished = await socket.waitFor((message) =>
      message.kind === "json" && message.type === "hashing_progress" &&
      (message.data as { running: boolean; done: number }).running === false &&
      (message.data as { done: number }).done === 3
    );
    assert(finished.kind === "json");
    const hashing = socket.json("hashing_progress");
    assert(hashing.length > 1, "hashing pushes progress as it goes");
    const last = finished.data as {
      running: boolean;
      done: number;
      total: number;
      bytes_total: number;
    };
    assertEquals(last.running, false);
    assertEquals(last.done, 3);
    assertEquals(last.total, 3);
    assert(last.bytes_total > 0);
    // A client that connects late is told where things stand.
    const late = await app.socket();
    const hello = await late.waitFor("hashing_progress");
    assert(hello.kind === "json");
    assertEquals((hello.data as { done: number }).done, 3);
  });
});

/**
 * The §8.1 backfill: an output generated before its checkpoint was hashed has
 * `hash: null` in its sidecar and no `output_models` row, and gets one when
 * the hash lands — without the sidecar being rewritten.
 */
Deno.test("hashing backfills the outputs that named the model", async () => {
  await withModels(async (app) => {
    const first = await app.json<JobRow & { outputs: string[] }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15",
        params: { prompt: "a granite bowl of figs", seed: 7 },
      }),
    });
    await awaitJob(app, first.id);
    const outputId = `${first.id}-0`;

    // Nothing linked it yet: the library had not hashed anything.
    assertEquals(
      app.db.prepare("SELECT count(*) FROM output_models WHERE output_id = ?")
        .value<[number]>(outputId)?.[0],
      0,
    );

    await scanAndHash(app);

    const checkpoint = (await models(app, "?kind=checkpoints")).models[0]!;
    assertEquals(checkpoint.output_count, 1);
    assert(checkpoint.last_used_at !== null);
    assertEquals(
      app.db.prepare(
        "SELECT model_hash, role FROM output_models WHERE output_id = ?",
      ).value<[string, string]>(outputId),
      [checkpoint.hash, "checkpoint"],
    );

    // The sidecar still says what the graph knew (§8.1).
    const sidecar = JSON.parse(
      await Deno.readTextFile(
        join(
          app.paths.root,
          `outputs/${dayOf(first.created_at)}/${first.id}.json`,
        ),
      ),
    ) as { models: { name: string; hash: string | null }[] };
    assertEquals(sidecar.models[0]?.hash, null);

    // The gallery can now filter by that model, which is the point.
    const filtered = await app.json<{ outputs: { id: string }[] }>(
      `/api/outputs?models=${checkpoint.hash}`,
    );
    assertEquals(filtered.outputs.map((output) => output.id), [outputId]);

    // A job run after the hash lands is linked at completion instead.
    const second = await app.json<JobRow>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "sd15",
        params: { prompt: "a second run", seed: 8 },
      }),
    });
    await awaitJob(app, second.id);
    assertEquals(
      app.db.prepare("SELECT count(*) FROM output_models WHERE output_id = ?")
        .value<[number]>(`${second.id}-0`)?.[0],
      1,
    );
    assertEquals(
      (await app.json<ModelView>(`/api/models/${checkpoint.hash}`))
        .output_count,
      2,
    );

    // Deleting an output takes it out of the count; undo puts it back.
    await app.fetch(`/api/outputs/${outputId}`, { method: "DELETE" });
    assertEquals(
      (await app.json<ModelView>(`/api/models/${checkpoint.hash}`))
        .output_count,
      1,
    );
    await app.fetch(`/api/outputs/${outputId}/restore`, { method: "POST" });
    assertEquals(
      (await app.json<ModelView>(`/api/models/${checkpoint.hash}`))
        .output_count,
      2,
    );

    // And a reindex rebuilds exactly the same rows from the sidecars.
    const before = outputModelRows(app);
    await app.json("/api/maintenance/reindex", { method: "POST" });
    assertEquals(outputModelRows(app), before);
    assertEquals(
      (await app.json<ModelView>(`/api/models/${checkpoint.hash}`))
        .output_count,
      2,
    );
  }, { comfy: true });
});

Deno.test("the boot scan runs on its own", async () => {
  const fixtures = await modelFixtures();
  const app = await startTestApp({ argv: fixtures.argv, scanModels: true });
  try {
    await app.models.idle();
    const listed = await app.json<ModelsResponse>("/api/models");
    assertEquals(listed.models.length, 3);
    assert(listed.models.every((model) => !model.hashing));
  } finally {
    await app.dispose();
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

function outputModelRows(app: TestApp): [string, string, string][] {
  return app.db.prepare(
    "SELECT output_id, model_hash, role FROM output_models ORDER BY output_id, model_hash, role",
  ).values<[string, string, string]>();
}

function dayOf(createdAt: number): string {
  const date = new Date(createdAt);
  return `${date.getUTCFullYear()}/${
    `${date.getUTCMonth() + 1}`.padStart(2, "0")
  }/${`${date.getUTCDate()}`.padStart(2, "0")}`;
}
