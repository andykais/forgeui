import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { sha256Hex } from "../../src/workflows/hash.ts";
import { parseSidecar } from "../../src/jobs/sidecar.ts";
import type { ImportBatch } from "../../src/models/import.ts";
import type {
  ModelDetail,
  ModelView,
  RescanResult,
} from "../../src/models/library.ts";
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

/** A distinct `n` is a distinct file: the same bytes are one sample (§8.3). */
function samplePng(n = 0xcc): Uint8Array {
  return tinyPng({ width: 12, height: 8, color: [0x22, 0x88, n] });
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
  // Where `forge models` leaves a batch: `fetched/success/` (§5.1).
  const dir = join(importsDir, "fetched", "success", hash);
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

Deno.test("a batch is applied to its model and kept as history", async () => {
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

    // The batch has moved on: its model.json kept in `imported/success/` as
    // the record that it happened, the samples in the sample store, the rest
    // gone. The raw record is kept beside the model's metadata too.
    assertEquals(await exists(dir), false);
    const kept = join(app.paths.imports, "imported", "success", hash);
    assertEquals(
      [...Deno.readDirSync(kept)].map((entry) => entry.name),
      ["model.json"],
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(kept, "model.json"))).model
        .sha256,
      hash,
    );
    assert(
      await exists(join(app.paths.modelsMeta, hash, "civitai.json")),
      "the raw upstream record should be kept in models-meta/",
    );
  });
});

Deno.test("an imported sample's generation data is on the API", async () => {
  // Saved by `forge models` as the sidecar's `raw`; served from there. The
  // fields are read again from the blob they came from, so a sample fetched
  // before the parser learned `civitaiResources` shows its LoRAs anyway.
  await withImports(async ({ app, hash }) => {
    await writeBatch(app.paths.imports, hash, {
      samples: [{
        file: "samples/0001.png",
        kind: "image",
        source: {
          kind: "civitai",
          label: "Civitai",
          url: "https://civitai.com/images/94080991",
        },
        raw: {
          format: "civitai-meta",
          // What an older parser made of it: the prompt, and no LoRAs.
          fields: { prompt: "a hiker" },
          source: {
            prompt: "a hiker",
            seed: 746810293,
            steps: 25,
            cfgScale: 7,
            clipSkip: 2,
            sampler: "DPM++ 2M Karras",
            civitaiResources: [
              {
                type: "checkpoint",
                modelVersionId: 128713,
                modelVersionName: "8",
              },
              {
                type: "lora",
                weight: 0.8,
                modelVersionId: 1558543,
                modelVersionName: "Abstract Painting",
              },
            ],
          },
        },
      }],
    }, { "samples/0001.png": samplePng() });
    await app.models.rescan();
    await app.models.idle();

    const [sample] = (await app.json<ModelDetail>(`/api/models/${hash}`))
      .samples;
    assertEquals(sample!.raw?.format, "civitai-meta");
    assertEquals(sample!.raw?.fields.seed, 746810293);
    assertEquals(sample!.raw?.fields.clip_skip, 2);
    assertEquals(sample!.raw?.fields.model_version_id, 128713);
    assertEquals(sample!.raw?.fields.loras, [
      { name: "Abstract Painting", model_version_id: 1558543, weight: 0.8 },
    ]);
    // The untouched blob stays in the sidecar; the API hands out the reading.
    assertEquals("source" in sample!.raw!, false);
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

Deno.test("a batch's samples keep the batch's order", async () => {
  // The CLI lists the model page's own media first, in the author's order;
  // the model page shows them that way, and the first is its thumbnail.
  await withImports(async ({ app, hash }) => {
    const names = ["first", "second", "third"];
    await writeBatch(
      app.paths.imports,
      hash,
      {
        samples: names.map((name) => ({
          file: `samples/${name}.png`,
          kind: "image",
          source: {
            kind: "civitai",
            label: "Civitai",
            url: `https://civitai.red/images/${name}`,
          },
        })),
      },
      Object.fromEntries(
        names.map((name, i) => [`samples/${name}.png`, samplePng(i)]),
      ),
    );
    await app.models.rescan();
    await app.models.idle();
    const model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(
      model.samples.map((sample) => sample.source?.url),
      names.map((name) => `https://civitai.red/images/${name}`),
    );
  });
});

Deno.test("a batch told to overwrite samples replaces the ones from the same link", async () => {
  // `--overwrite` naming imported samples (§3.2, §7.2): the same link is
  // still one sample, but the new copy — new bytes, new generation data —
  // takes the old one's place, and a thumbnail that was the old one follows.
  await withImports(async ({ app, hash }) => {
    const sample = (name: string, seed: number) => ({
      file: `samples/${name}.png`,
      kind: "image",
      source: {
        kind: "civitai",
        label: "Civitai",
        url: `https://civitai.red/images/${name}`,
      },
      raw: { format: "civitai-meta", source: { seed } },
    });
    const ingest = async (overrides: Partial<ImportBatch>) => {
      await writeBatch(app.paths.imports, hash, overrides, {
        "samples/a.png": samplePng(1),
        "samples/b.png": samplePng(2),
      });
      await app.models.rescan();
      await app.models.idle();
      return await app.json<ModelDetail>(`/api/models/${hash}`);
    };

    const first = await ingest({ samples: [sample("a", 1), sample("b", 2)] });
    const oldB = first.samples.find((s) => s.source?.url?.endsWith("/b"))!;
    const patched = await app.fetch(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ thumb_sample_id: oldB.id }),
    });
    assertEquals(patched.status, 200);
    await patched.body?.cancel();

    // Without the flag, the same link is skipped: the seed stays 2.
    const skipped = await ingest({ samples: [sample("b", 3)] });
    assertEquals(skipped.samples.length, 2);
    assertEquals(
      skipped.samples.find((s) => s.id === oldB.id)?.raw?.fields.seed,
      2,
    );

    const replaced = await ingest({
      overwrite_samples: true,
      samples: [sample("b", 9)],
    });
    assertEquals(replaced.samples.length, 2);
    const newB = replaced.samples.find((s) => s.source?.url?.endsWith("/b"))!;
    assert(newB.id !== oldB.id);
    assertEquals(newB.raw?.fields.seed, 9);
    // The untouched sample is untouched.
    assertEquals(
      replaced.samples.find((s) => s.source?.url?.endsWith("/a"))?.raw
        ?.fields.seed,
      1,
    );
    assertEquals(replaced.thumb_path, newB.path);
  });
});

Deno.test("the same file under another link, imported later, is not a second sample", async () => {
  // Civitai lists one image under two ids now and then, and a model's page
  // and its gallery overlap: two links, one file, one sample (§8.3).
  await withImports(async ({ app, hash }) => {
    const entry = (file: string, url: string, seed: number) => ({
      file,
      kind: "image",
      source: { kind: "civitai", label: "Civitai", url },
      raw: { format: "civitai-meta", source: { seed } },
    });
    const ingest = async (overrides: Partial<ImportBatch>) => {
      await writeBatch(app.paths.imports, hash, overrides, {
        "samples/0001.png": samplePng(1),
        "samples/0002.png": samplePng(1),
      });
      await app.models.rescan();
      await app.models.idle();
      return (await app.json<ModelDetail>(`/api/models/${hash}`)).samples;
    };

    // Twice in one batch: once.
    let samples = await ingest({
      samples: [
        entry("samples/0001.png", "https://civitai.red/images/1", 1),
        entry("samples/0002.png", "https://civitai.red/images/2", 2),
      ],
    });
    assertEquals(samples.map((s) => s.source?.url), [
      "https://civitai.red/images/1",
    ]);

    // Again later, under a third link: still once, and still the first.
    samples = await ingest({
      samples: [entry("samples/0001.png", "https://civitai.red/images/3", 3)],
    });
    assertEquals(samples.map((s) => s.source?.url), [
      "https://civitai.red/images/1",
    ]);

    // Told to overwrite samples, the newer copy takes the old one's place.
    samples = await ingest({
      overwrite_samples: true,
      samples: [entry("samples/0001.png", "https://civitai.red/images/4", 4)],
    });
    assertEquals(samples.map((s) => s.source?.url), [
      "https://civitai.red/images/4",
    ]);
    assertEquals(samples[0]?.raw?.fields.seed, 4);
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
    const badDir = join(app.paths.imports, "fetched", "success", "0000-broken");
    await Deno.mkdir(badDir, { recursive: true });
    await Deno.writeTextFile(join(badDir, "model.json"), "{ not json");
    const goodDir = await writeBatch(app.paths.imports, hash);

    await app.models.rescan();
    await app.models.idle();

    assertEquals(await exists(badDir), false);
    assertEquals(await exists(goodDir), false);
    const failed = join(
      app.paths.imports,
      "imported",
      "failure",
      "0000-broken",
    );
    assert(await exists(failed), "a bad batch is moved aside, not deleted");
    // The same note `forge models` writes, so one grep prunes both sides.
    assertStringIncludes(
      await Deno.readTextFile(join(failed, "error.txt")),
      "failure: refused\n",
    );
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
        join(app.paths.imports, "imported", "failure", hash, "error.txt"),
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

Deno.test("a family the import knows replaces the app's; an unknown one does not", async () => {
  await withImports(async ({ app, hash }) => {
    // Picked by hand, or guessed by the header probe: either way, not what
    // the model's own page says it was trained on.
    await app.json(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ family: "flux" }),
    });

    // No `overwrite`, and the family still moves: it is a fact, not a taste.
    await writeBatch(app.paths.imports, hash);
    await app.models.rescan();
    await app.models.idle();
    let model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.family, "sd15");

    // A source that does not know leaves the app's answer where it is.
    await app.json(`/api/models/${hash}`, {
      method: "PATCH",
      body: JSON.stringify({ family: "sdxl" }),
    });
    await writeBatch(app.paths.imports, hash, {
      model: { ...batchJson(hash).model, family: null },
    });
    await app.models.rescan();
    await app.models.idle();
    model = await app.json<ModelDetail>(`/api/models/${hash}`);
    assertEquals(model.family, "sdxl");
  });
});

Deno.test("rescan-models?wait=1 answers once the batch has landed", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      await app.models.rescan();
      await app.models.idle();
      const { models } = await app.json<{ models: ModelView[] }>("/api/models");
      const hash = models.find((m) => m.filename === CHECKPOINT)!.hash!;

      // A new file to hash, which is what defers the batch: with anything
      // queued, Phase B runs when the hasher drains, not inside the rescan.
      await writeFakeSafetensors(
        join(fixtures.dir, "checkpoints", "another.safetensors"),
        { name: "another" },
      );
      await writeBatch(app.paths.imports, hash);

      const result = await app.json<RescanResult>(
        "/api/maintenance/rescan-models?wait=1",
        { method: "POST" },
      );
      assertEquals(result.queued, 1);
      // Applied after the hashing, so the answer counts what is on disk.
      assertEquals(result.imports, { batches: 1, samples: 0 });
      // No `idle()`: the answer is itself the promise that it is done, which
      // is what lets the model page reload once and see the import.
      const model = await app.json<ModelDetail>(`/api/models/${hash}`);
      assertEquals(model.display_name, "CyberRealistic");
      assertEquals(model.trigger_words, ["cyberrealistic", "photo"]);
      assert(
        !(await exists(join(app.paths.imports, "fetched", "success", hash))),
      );
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

Deno.test("rescan-models says what it imported, for the toast", async () => {
  await withImports(async ({ app, hash }) => {
    const sample = (n: number) => ({
      file: `samples/000${n}.png`,
      kind: "image",
    });
    await writeBatch(app.paths.imports, hash, {
      samples: [sample(1), sample(2)],
    }, {
      "samples/0001.png": samplePng(1),
      "samples/0002.png": samplePng(2),
    });
    // A model this library has never seen: it waits, and is not counted.
    const stranger = "b".repeat(64);
    await writeBatch(app.paths.imports, stranger, {
      samples: [sample(1)],
    }, { "samples/0001.png": samplePng() });
    // Refused on reading, before anything is applied.
    const broken = join(
      app.paths.imports,
      "fetched",
      "success",
      "c".repeat(64),
    );
    await Deno.mkdir(broken, { recursive: true });
    await Deno.writeTextFile(join(broken, "model.json"), "{");

    const result = await app.json<RescanResult>(
      "/api/maintenance/rescan-models",
      { method: "POST" },
    );
    assertEquals(result.queued, 0);
    assertEquals(result.imports, { batches: 1, samples: 2 });

    // Nothing left to import, and the batch still waiting says nothing.
    const again = await app.json<RescanResult>(
      "/api/maintenance/rescan-models",
      { method: "POST" },
    );
    assertEquals(again.imports, { batches: 0, samples: 0 });
  });
});

Deno.test("ingest never writes notes, whatever a batch says", async () => {
  await withImports(async ({ app, hash }) => {
    const notesAfter = async (mine: string | null, batchNotes: string) => {
      await app.json(`/api/models/${hash}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: mine }),
      });
      await writeBatch(app.paths.imports, hash, {
        model: { ...batchJson(hash).model, notes: batchNotes },
        overwrite: true,
      });
      await app.models.rescan();
      await app.models.idle();
      return (await app.json<ModelDetail>(`/api/models/${hash}`)).notes;
    };
    // Not filled when empty, not replaced when set — even with --overwrite.
    assertEquals(await notesAfter(null, "An author's blurb."), null);
    assertEquals(
      await notesAfter("my own note", "An author's blurb."),
      "my own note",
    );
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
      assertEquals(
        await exists(join(app.paths.imports, "fetched", "success", hash)),
        false,
      );
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
          join(app.paths.imports, "imported", "failure", claimed, "error.txt"),
        ),
        "but the batch says",
      );
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

Deno.test("a batch with no model to attach to says so, rather than nothing", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      // Metadata for a model that is not on this machine — what you get from
      // `forge models --url …` without `--download-model`. It cannot be
      // applied, because metadata attaches to a `models` row and a row only
      // exists once a file has been hashed. Saying nothing made that look
      // like the import had silently failed, which is what it looks like
      // from outside.
      const absent = await sha256Hex("a model nobody has");
      const dir = await writeBatch(app.paths.imports, absent);

      const lines: string[] = [];
      const write = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(" "));
      try {
        await app.models.rescan();
        await app.models.idle();
      } finally {
        console.log = write;
      }

      const said = lines.join("\n");
      assertStringIncludes(
        said,
        "waiting for a model this library has not seen",
      );
      // Names the model and the file to go looking for, and what to do.
      assertStringIncludes(said, "CyberRealistic");
      assertStringIncludes(said, CHECKPOINT);
      assertStringIncludes(said, "--download-model");
      // And the batch is kept, because it is not wrong — only early.
      assert(await exists(dir));
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});

Deno.test("a batch carrying its own weights is not reported as stuck", async () => {
  const fixtures = await modelFixtures();
  try {
    await withTestApp(async (app) => {
      const weights = await writeFakeSafetensors(
        join(fixtures.dir, "staged2.safetensors"),
        { name: "carried" },
      );
      const hash = await sha256Hex(weights);
      await writeBatch(app.paths.imports, hash, {
        model: {
          sha256: hash,
          filename: "carried.safetensors",
          kind: "checkpoints",
          display_name: "Carried",
          tags: [],
        },
        files: [{
          file: "model/carried.safetensors",
          kind: "checkpoints",
          sha256: hash,
        }],
      }, { "model/carried.safetensors": weights });

      const lines: string[] = [];
      const write = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(" "));
      try {
        await app.models.rescan();
        await app.models.idle();
      } finally {
        console.log = write;
      }

      // It brought its own file, so it was mid-flight rather than stuck: the
      // warning is for the case a person has to act on.
      const said = lines.join("\n");
      assert(
        !said.includes("waiting for a model this library has not seen"),
        `a self-contained batch should not be reported as stuck:\n${said}`,
      );
      assertEquals(
        await exists(join(app.paths.imports, "fetched", "success", hash)),
        false,
      );
    }, { argv: fixtures.argv });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});
