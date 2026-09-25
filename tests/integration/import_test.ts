import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { sha256Hex } from "../../src/workflows/hash.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";
import type { ImportBatch } from "../../src/models/import.ts";
import type { ModelDetail, ModelView } from "../../src/models/library.ts";
import type { SampleView } from "../../src/samples/store.ts";

/**
 * The import folder (DESIGN-MODEL-IMPORT §7). Every batch here is hand-written
 * — which is the supported way to import a model the CLI cannot find, and the
 * reason the format is one readable JSON file. Nothing in this file reaches
 * the network, and no `forge models` process is involved.
 */

const CHECKPOINT = "cyberrealistic_v90.safetensors";

interface Fixtures {
  dir: string;
  argv: string[];
}

async function modelFixtures(): Promise<Fixtures> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-import-models-" });
  await writeFakeSafetensors(join(dir, "checkpoints", CHECKPOINT), {
    name: "cyberrealistic",
  });
  return {
    dir,
    argv: ["--models-dir", `checkpoints=${join(dir, "checkpoints")}`],
  };
}

function samplePng(): Uint8Array {
  return tinyPng({ width: 12, height: 8, color: [0x22, 0x88, 0xcc] });
}

/** A batch as `forge models` would leave it, minus the fetching. */
function batchJson(hash: string, overrides: Partial<ImportBatch> = {}) {
  const batch: ImportBatch = {
    format: 1,
    forgecli_version: "0.1.0",
    created_at: "2026-09-25T10:00:00Z",
    model: {
      sha256: hash,
      filename: CHECKPOINT,
      kind: "checkpoints",
      display_name: "CyberRealistic",
      family: "sd15",
      tags: ["photorealistic", "base model"],
      notes: "A photoreal SD 1.5 finetune.",
      trigger_words: ["cyberrealistic", "photo"],
    },
    source: {
      kind: "civitai",
      label: "Civitai",
      url: "https://civitai.red/models/15003?modelVersionId=501240",
      model_id: 15003,
      model_version_id: 501240,
      fetched_at: "2026-09-25T09:59:58Z",
    },
    civitai: {
      format: 1,
      creator: { username: "Cyberdelia", url: null },
      model: {
        name: "CyberRealistic",
        type: "Checkpoint",
        tags: ["photorealistic"],
        description_html: "<h1>CyberRealistic</h1><p>Hello</p>",
        description_text: "# CyberRealistic\n\nHello",
      },
      version: {
        name: "v9.0",
        base_model: "SD 1.5",
        description_html: "<p>Better hands</p>",
        description_text: "Better hands",
      },
      trigger_words: ["cyberrealistic", "photo"],
    },
    samples: [],
    ...overrides,
  };
  return batch;
}

async function writeBatch(
  importsDir: string,
  hash: string,
  overrides: Partial<ImportBatch> = {},
  files: Record<string, Uint8Array> = {},
): Promise<string> {
  const dir = join(importsDir, hash);
  await Deno.mkdir(join(dir, "samples"), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeFile(join(dir, name), bytes);
  }
  await Deno.writeTextFile(
    join(dir, "model.json"),
    `${JSON.stringify(batchJson(hash, overrides), null, 2)}\n`,
  );
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withImports(
  body: (h: {
    app: import("../fixtures/app.ts").TestApp;
    hash: string;
  }) => Promise<void>,
): Promise<void> {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      await app.models.rescan();
      await app.models.idle();
      const { models } = await app.json<{ models: ModelView[] }>("/api/models");
      const hash = models.find((m) => m.filename === CHECKPOINT)?.hash;
      assert(hash, "the fixture checkpoint should have hashed");
      await body({ app, hash });
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
}

Deno.test("a batch is applied to its model and then deleted", async () => {
  await withImports(async ({ app, hash }) => {
    const dir = await writeBatch(app.paths.imports, hash, {
      samples: [{
        file: "samples/0001.png",
        kind: "image",
        source: {
          kind: "civitai",
          label: "Civitai",
          url: "https://civitai.red/images/26534668",
        },
        raw: { format: "civitai-meta", fields: { prompt: "a fox", seed: 3 } },
      }],
    }, { "samples/0001.png": samplePng() });

    await app.models.rescan();
    await app.models.idle();

    const model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.display_name, "CyberRealistic");
    assertEquals(model.family, "sd15");
    assertEquals(model.tags, ["photorealistic", "base model"]);
    assertEquals(model.trigger_words, ["cyberrealistic", "photo"]);
    assertEquals(model.samples.length, 1);

    // The sample carries where it came from, as a link.
    const [sample] = model.samples;
    assertEquals(sample!.source?.kind, "civitai");
    assertEquals(sample!.source?.label, "Civitai");
    assertEquals(sample!.source_url, "https://civitai.red/images/26534668");

    // …and so does its sidecar, which is what `reindex` would rebuild from.
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(app.paths.root, sample!.sidecar_path)),
    );
    assertEquals(sidecar.source?.kind, "civitai");
    assertEquals(
      (sidecar.raw as { fields: { seed: number } }).fields.seed,
      3,
    );

    // The batch is gone; the raw record is kept beside the model's metadata.
    assertEquals(await exists(dir), false);
    assert(
      await exists(join(app.paths.modelsMeta, hash, "civitai.json")),
      "the raw upstream record should be kept in models-meta/",
    );
  });
});

Deno.test("the API serves the text, and the HTML only when asked", async () => {
  await withImports(async ({ app, hash }) => {
    await writeBatch(app.paths.imports, hash);
    await app.models.rescan();
    await app.models.idle();

    const plain = await app.json<ModelDetail>(`/api/models/${hash}`);
    const source = plain.source as {
      model: Record<string, unknown>;
      version: Record<string, unknown>;
    };
    assertEquals(source.model.description_text, "# CyberRealistic\n\nHello");
    assertEquals("description_html" in source.model, false);
    assertEquals("description_html" in source.version, false);

    const withHtml = await app.json<ModelDetail>(
      `/api/models/${hash}?html=1`,
    );
    const full = withHtml.source as { model: Record<string, unknown> };
    assertEquals(
      full.model.description_html,
      "<h1>CyberRealistic</h1><p>Hello</p>",
    );
  });
});

Deno.test("re-ingesting the same batch imports no second sample", async () => {
  await withImports(async ({ app, hash }) => {
    const sample = {
      file: "samples/0001.png",
      kind: "image",
      source: {
        kind: "civitai",
        label: "Civitai",
        url: "https://civitai.red/images/1",
      },
    };
    for (let round = 0; round < 2; round++) {
      await writeBatch(app.paths.imports, hash, { samples: [sample] }, {
        "samples/0001.png": samplePng(),
      });
      await app.models.rescan();
      await app.models.idle();
    }
    const { samples } = await app.json<{ samples: SampleView[] }>(
      `/api/models/${hash}/samples`,
    ).catch(async () => ({
      samples: (await app.json<ModelDetail>(`/api/models/${hash}`)).samples,
    }));
    assertEquals(samples.length, 1);
  });
});

Deno.test("a batch for an unhashed model waits, then lands", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      // A hash the library has never seen: nothing on disk answers to it.
      const orphan = await sha256Hex("a model that is not here yet");
      const dir = await writeBatch(app.paths.imports, orphan);

      await app.models.rescan();
      await app.models.idle();
      assert(
        await exists(dir),
        "a batch whose model has no row is left exactly where it is",
      );

      // Now put a file there that hashes to what the batch names, and let the
      // library find it. The batch lands without anyone touching it.
      const bytes = new TextEncoder().encode("a model that is not here yet");
      await Deno.writeFile(
        join(fixtures.dir, "checkpoints", "late.safetensors"),
        bytes,
      );
      await app.models.rescan();
      await app.models.idle();

      assertEquals(await exists(dir), false);
      const model = await app.json<ModelDetail>(`/api/models/${orphan}`);
      assertEquals(model.display_name, "CyberRealistic");
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

Deno.test("a malformed batch is set aside and the next one still lands", async () => {
  await withImports(async ({ app, hash }) => {
    // Sorts before the good one, so it is met first.
    const badDir = join(app.paths.imports, "0000-broken");
    await Deno.mkdir(badDir, { recursive: true });
    await Deno.writeTextFile(join(badDir, "model.json"), "{ not json");
    const goodDir = await writeBatch(app.paths.imports, hash);

    await app.models.rescan();
    await app.models.idle();

    assertEquals(await exists(badDir), false);
    assertEquals(await exists(goodDir), false);
    const failed = join(app.paths.imports, ".failed", "0000-broken");
    assert(await exists(failed), "a bad batch is moved aside, not deleted");
    assertStringIncludes(
      await Deno.readTextFile(join(failed, "error.txt")),
      "invalid JSON",
    );
    const model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.display_name, "CyberRealistic");
  });
});

Deno.test("a batch from a newer format is refused rather than misread", async () => {
  await withImports(async ({ app, hash }) => {
    await writeBatch(app.paths.imports, hash, { format: 99 });
    await app.models.rescan();
    await app.models.idle();
    assertStringIncludes(
      await Deno.readTextFile(
        join(app.paths.imports, ".failed", hash, "error.txt"),
      ),
      "newer than this build reads",
    );
  });
});

Deno.test("overwrite decides whether a hand-typed name survives", async () => {
  await withImports(async ({ app, hash }) => {
    await app.json(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Mine" }),
    });

    // Without the flag, what you typed wins and the rest still fills in.
    await writeBatch(app.paths.imports, hash);
    await app.models.rescan();
    await app.models.idle();
    let model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.display_name, "Mine");
    assertEquals(model.family, "sd15");

    // With it, the import replaces it.
    await writeBatch(app.paths.imports, hash, { overwrite: true });
    await app.models.rescan();
    await app.models.idle();
    model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.display_name, "CyberRealistic");
  });
});

Deno.test("a downloaded model is filed, scanned, hashed and applied", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      // A weights file inside the batch, as `--download-model` leaves it.
      const weights = await writeFakeSafetensors(
        join(fixtures.dir, "staged.safetensors"),
        { name: "downloaded" },
      );
      const hash = await sha256Hex(weights);
      await writeBatch(app.paths.imports, hash, {
        model: {
          sha256: hash,
          filename: "downloaded.safetensors",
          kind: "checkpoints",
          display_name: "Downloaded",
          family: "sd15",
          tags: [],
          trigger_words: ["downloaded"],
        },
        files: [{
          file: "model/downloaded.safetensors",
          kind: "checkpoints",
          sha256: hash,
        }],
      }, { "model/downloaded.safetensors": weights });

      // Phase A files it, the scan finds it, the hasher identifies it, and
      // Phase B applies the metadata — all inside one rescan.
      await app.models.rescan();
      await app.models.idle();

      const filed = join(
        app.paths.downloads,
        "checkpoints",
        "downloaded.safetensors",
      );
      assert(await exists(filed), "the weights should be filed by kind");
      const model = await app.json<ModelDetail>(`/api/models/${hash}`);
      assertEquals(model.display_name, "Downloaded");
      assertEquals(model.trigger_words, ["downloaded"]);
      assertEquals(await exists(join(app.paths.imports, hash)), false);
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

Deno.test("weights that do not hash to the batch's name are refused", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      const claimed = await sha256Hex("what it says it is");
      await writeBatch(app.paths.imports, claimed, {
        files: [{
          file: "model/wrong.safetensors",
          kind: "checkpoints",
          sha256: claimed,
        }],
      }, {
        "model/wrong.safetensors": new TextEncoder().encode("other bytes"),
      });

      await app.models.rescan();
      await app.models.idle();

      assertEquals(
        await exists(
          join(app.paths.downloads, "checkpoints", "wrong.safetensors"),
        ),
        false,
      );
      assertStringIncludes(
        await Deno.readTextFile(
          join(app.paths.imports, ".failed", claimed, "error.txt"),
        ),
        "but the batch says",
      );
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});
