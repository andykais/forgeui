import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { startFakeCivitai } from "../fake-civitai/server.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { effectiveConfig } from "../../src/config/config.ts";
import { dataPaths, ensureDataDirs } from "../../src/config/paths.ts";
import { sha256Hex } from "../../src/workflows/hash.ts";
import { CivitaiClient } from "../../src/cli/civitai_client.ts";
import { parseOverwrite } from "../../src/cli/overwrite.ts";
import {
  civitaiToken,
  LookupError,
  NotFoundError,
  runModels,
  UsageError,
} from "../../src/cli/models.ts";
import type { ImportBatch } from "../../src/models/import.ts";

/**
 * `forge models` end to end (DESIGN-MODEL-IMPORT §10), against a fake Civitai
 * the config points at. The real one is never called.
 */

const FILENAME = "cyberrealistic_v90.safetensors";

/** The bytes the fixture model is made of, and what they hash to. */
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-cli-src-" });
  try {
    const bytes = await writeFakeSafetensors(join(dir, "m.safetensors"), {
      name: "cyber",
    });
    return { bytes, hash: await sha256Hex(bytes) };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function civitaiModel(hash: string, base: string) {
  return {
    id: 15003,
    name: "CyberRealistic",
    type: "Checkpoint",
    description: "<h1>CyberRealistic</h1><p>A photoreal finetune.</p>",
    creator: { username: "Cyberdelia" },
    tags: ["photorealistic", "base model"],
    modelVersions: [{
      id: 501240,
      modelId: 15003,
      name: "v9.0",
      baseModel: "SD 1.5",
      trainedWords: ["cyberrealistic, photo, "],
      description: "<p>Better hands</p>",
      files: [{
        name: FILENAME,
        primary: true,
        sizeKB: 4,
        downloadUrl: `${base}/api/download/models/501240`,
        hashes: { SHA256: hash.toUpperCase() },
      }],
      // The version's own showcase, as the live API gives it: generation
      // data, but no `id` — so no page to link to until the same images,
      // asked for by their author, supply one.
      images: [
        {
          url: `${base}/img/anim=false,width=450,optimized=true/900001.jpeg`,
          width: 768,
          height: 512,
          type: "image",
          nsfwLevel: 1,
          meta: { prompt: "a fox", seed: 3, steps: 28, cfgScale: 4.5 },
        },
        {
          url: `${base}/img/width=450/900002.jpeg`,
          width: 768,
          height: 512,
          type: "image",
          // Above the default ceiling of 1: fetched by the lookup, kept off
          // the disk by import.nsfw_level.
          nsfwLevel: 8,
        },
      ],
    }],
  };
}

interface Harness {
  fake: ReturnType<typeof startFakeCivitai>;
  bytes: Uint8Array;
  modelsDir: string;
  config: ReturnType<typeof effectiveConfig>;
  paths: ReturnType<typeof dataPaths>;
  client: CivitaiClient;
  hash: string;
}

async function withCli(
  body: (h: Harness) => Promise<void>,
  options: {
    archiveOnly?: boolean;
    nsfwLevel?: number;
    /** Leave the configured model folder empty, as a fresh machine is. */
    noLocalFile?: boolean;
    /** More of the version's gallery: other people's posts under it. */
    gallery?: (url: string) => unknown[];
  } = {},
): Promise<void> {
  const { bytes, hash } = await fixture();
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-cli-" });
  const modelsDir = await Deno.makeTempDir({ prefix: "forgeui-cli-models-" });
  await Deno.mkdir(join(modelsDir, "checkpoints"), { recursive: true });
  if (!options.noLocalFile) {
    await Deno.writeFile(join(modelsDir, "checkpoints", FILENAME), bytes);
  }

  // One fake plays both sites, which is enough: what the test is about is
  // which one is asked, and in what order.
  const fake = startFakeCivitai();
  const model = civitaiModel(hash, fake.url);
  // What `/api/v1/images` really answers with: ids, already-original URLs,
  // dimensions, `meta` and who posted it. The creator's two are the showcase
  // above; asked for by username, they are what supplies its ids (§4.3).
  const meta = {
    501240: [
      {
        id: 900001,
        url: `${fake.url}/img/original=true/900001.jpeg`,
        width: 768,
        height: 512,
        type: "image",
        nsfwLevel: 1,
        username: "Cyberdelia",
        meta: { prompt: "a fox", seed: 3, steps: 28, cfgScale: 4.5 },
      },
      {
        id: 900002,
        url: `${fake.url}/img/original=true/900002.jpeg`,
        width: 768,
        height: 512,
        type: "image",
        // Above the default ceiling of 1: offered by the lookup, kept off the
        // disk by import.nsfw_level.
        nsfwLevel: 8,
        username: "Cyberdelia",
        meta: {},
      },
      ...(options.gallery?.(fake.url) ?? []),
    ],
  };
  const archive = {
    archiveByHash: {
      [hash]: {
        files: [{
          filename: FILENAME,
          source: "civitai",
          model_id: "15003",
          model_version_id: "501240",
        }],
      },
    },
    archiveModels: {
      15003: {
        id: 15003,
        name: "CyberRealistic (archived)",
        type: "Checkpoint",
        description: "<p>From the archive</p>",
        creator_username: "Cyberdelia",
        tags: ["photorealistic"],
        version: {
          id: 501240,
          name: "v9.0",
          baseModel: "SD 1.5",
          trigger: ["cyberrealistic"],
          files: [{ name: FILENAME, sha256: hash, is_primary: true }],
          images: [],
        },
      },
    },
  };
  fake.configure({
    imageBytes: tinyPng({ width: 8, height: 8, color: [1, 2, 3] }),
    download: { bytes, filename: FILENAME },
    // `archiveOnly` leaves Civitai empty, so every lookup 404s there and the
    // fallback is what answers — which is the case the archive exists for.
    models: options.archiveOnly ? {} : { 15003: model },
    versionsByHash: options.archiveOnly
      ? {}
      : { [hash]: model.modelVersions[0]! },
    images: meta,
    ...archive,
  });

  const config = effectiveConfig({
    model_folders: { checkpoints: [join(modelsDir, "checkpoints")] },
    import: {
      civitai_url: fake.url,
      archive_url: fake.url,
      nsfw_level: options.nsfwLevel ?? 1,
    },
  });
  const paths = dataPaths(dataDir, config.import);
  await ensureDataDirs(paths);
  const client = new CivitaiClient({
    civitaiUrl: fake.url,
    archiveUrl: fake.url,
    browsingLevel: config.import.browsing_level,
    timeoutMs: 5000,
    now: () => new Date("2026-09-25T10:00:00Z"),
  });

  try {
    await body({ fake, bytes, modelsDir, config, paths, client, hash });
  } finally {
    await fake.close();
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
  }
}

const base = {
  source: "auto" as const,
  downloadSamples: 0,
  downloadModel: false,
  overwrite: false,
  dryRun: false,
  timeoutMs: 5000,
};

async function readBatch(dir: string): Promise<ImportBatch> {
  return JSON.parse(await Deno.readTextFile(join(dir, "model.json")));
}

Deno.test("a run says where it came from and what it holds", async () => {
  await withCli(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      sha256checksum: h.hash,
      downloadSamples: 4,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    const said = lines.join("\n");
    assertStringIncludes(
      said,
      `from Civitai (${new URL(h.fake.url).host}): ${h.fake.url}/models/15003`,
    );
    assertStringIncludes(said, "model         CyberRealistic");
    // The version and its base model: what tells versions apart, trigger
    // words included.
    assertStringIncludes(said, "version       v9.0");
    assertStringIncludes(said, "kind          checkpoints · sd15 (SD 1.5)");
    assertStringIncludes(said, "by            Cyberdelia");
    assertStringIncludes(said, "trigger words cyberrealistic, photo");
    assertStringIncludes(said, "their tags    photorealistic, base model");
    assertStringIncludes(
      said,
      "samples       1 (1 from the model page, 0 from its gallery) " +
        "(1 over import.nsfw_level",
    );
    assert(lines.at(-1) === `wrote ${result.dir}`, said);
    // The model is not in a model folder here, and nothing nags about it:
    // the machine running this usually has none (§2).
    assert(!said.includes("note:"), said);
  }, { noLocalFile: true });
});

Deno.test("--local-file hashes what is on disk and writes a batch", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });

    assertEquals(
      result.dir,
      join(h.paths.imports, "fetched", "success", h.hash),
    );
    const batch = await readBatch(result.dir);
    assertEquals(batch.format, 1);
    assertEquals(batch.model.sha256, h.hash);
    assertEquals(batch.model.family, "sd15");
    assertEquals(batch.model.kind, "checkpoints");
    assertEquals(batch.model.display_name, "CyberRealistic");
    // Civitai's tags are kept in the record, not pressed into ForgeUI's own
    // tag taxonomy (§5.5).
    assertEquals(batch.model.tags, []);
    assertEquals(
      (batch.civitai as { model: { tags: string[] } }).model.tags,
      ["photorealistic", "base model"],
    );
    // The comma-separated single string is split, trimmed and de-duplicated.
    assertEquals(batch.model.trigger_words, ["cyberrealistic", "photo"]);
    // Notes are the user's: the batch carries none, not even the trigger
    // words, which have their own field.
    assert(!("notes" in batch.model), "the batch should carry no notes");

    const record = batch.civitai as {
      model: { description_text: string; description_html: string };
    };
    assertStringIncludes(record.model.description_text, "# CyberRealistic");
    assertStringIncludes(record.model.description_html, "<h1>");

    // It was found by hash, which means the local file decided it — not a
    // name search that happened to land on something similar.
    assert(h.fake.matching("/model-versions/by-hash/").length > 0);
  });
});

Deno.test("the lookup sends the visibility parameter §4.0's table names", async () => {
  await withCli(async (h) => {
    await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 2,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });

    // /models takes nsfw; browsingLevel is a 400 there.
    const models = h.fake.matching("/api/v1/models/");
    assert(models.length > 0, "the model endpoint should have been asked");
    assertEquals(models[0]!.params.nsfw, "true");
    assertEquals(models[0]!.params.browsingLevel, undefined);

    // /images takes browsingLevel.
    const images = h.fake.matching("/api/v1/images");
    assert(images.length > 0, "the images endpoint should have been asked");
    assertEquals(images[0]!.params.browsingLevel, "31");
    assertEquals(images[0]!.params.withMeta, "true");

    // by-hash takes neither.
    const byHash = h.fake.matching("/by-hash/");
    assertEquals(byHash[0]!.params.nsfw, undefined);
    assertEquals(byHash[0]!.params.browsingLevel, undefined);
  });
});

Deno.test("samples are fetched at full size, with their generation data", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 4,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });

    // Two images were offered; one is above import.nsfw_level.
    assertEquals(result.samples, 1);
    assertEquals(result.skipped, 1);

    const batch = await readBatch(result.dir);
    const [sample] = batch.samples!;
    assertEquals(sample!.file, "samples/0001.jpeg");
    assertEquals(sample!.source?.url, `${h.fake.url}/images/900001`);
    const raw = sample!.raw as { format: string; fields: { seed: number } };
    assertEquals(raw.format, "civitai-meta");
    assertEquals(raw.fields.seed, 3);
    assert(
      await Deno.stat(join(result.dir, "samples", "0001.jpeg")),
      "the bytes should be in the batch",
    );

    // The card transform is rewritten to the original.
    const fetched = h.fake.matching("/img/");
    assert(
      fetched.some((entry) => entry.path.includes("original=true")),
      `expected an original=true fetch, got ${
        fetched.map((e) => e.path).join(", ")
      }`,
    );
  });
});

/** Two posts by somebody else under the version: its gallery. */
function galleryOf(url: string) {
  return [900003, 900004].map((id) => ({
    id,
    url: `${url}/img/original=true/${id}.jpeg`,
    width: 512,
    height: 512,
    type: "image",
    nsfwLevel: 1,
    username: "someone",
    meta: { prompt: `a gallery fox ${id}`, seed: id },
  }));
}

Deno.test("samples start from the model's own media, and the gallery tops up", async () => {
  // What the author put on the model page comes first, in their order; the
  // gallery — everyone's posts under the version — only fills a count the
  // showcase cannot reach (§4.3).
  await withCli(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 3,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      batch.samples!.map((sample) => sample.source?.url),
      [
        `${h.fake.url}/images/900001`,
        `${h.fake.url}/images/900003`,
        `${h.fake.url}/images/900004`,
      ],
    );
    // The showcase image kept its own generation data and gained its page.
    const raw = batch.samples![0]!.raw as { fields: { seed: number } };
    assertEquals(raw.fields.seed, 3);
    assertStringIncludes(
      lines.join("\n"),
      "samples       3 (1 from the model page, 2 from its gallery)",
    );
  }, { gallery: galleryOf });
});

Deno.test("the gallery is not asked when the model's own media are enough", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 1,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      batch.samples!.map((sample) => sample.source?.url),
      [`${h.fake.url}/images/900001`],
    );
    // The images endpoint was asked only for the creator's own posts, for
    // the showcase's links — never for the gallery.
    const asked = h.fake.matching("/api/v1/images");
    assert(asked.length > 0);
    for (const request of asked) {
      assertEquals(request.params.username, "Cyberdelia");
    }
  }, { gallery: galleryOf });
});

Deno.test("the batch is renamed into place, never written in halves", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 1,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    // Staging is empty afterwards: the finished directory was renamed, so the
    // app never sees a partial batch.
    const staged: string[] = [];
    for await (
      const entry of Deno.readDir(join(h.paths.imports, "fetched", ".staging"))
    ) {
      staged.push(entry.name);
    }
    assertEquals(staged, []);
    assert(await Deno.stat(result.dir));
  });
});

Deno.test("--dry-run touches nothing", async () => {
  await withCli(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      dryRun: true,
      downloadSamples: 3,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    await assertRejects(() => Deno.stat(result.dir), Deno.errors.NotFound);
    assertStringIncludes(lines.join("\n"), "would write");
  });
});

Deno.test("a hash nothing knows is reported, not guessed at", async () => {
  await withCli(async (h) => {
    await assertRejects(
      () =>
        runModels({
          ...base,
          sha256checksum: "f".repeat(64),
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
      "knows the hash",
    );
  });
});

Deno.test("exactly one identifier, and the message says which", async () => {
  await withCli(async (h) => {
    await assertRejects(
      () =>
        runModels({
          ...base,
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      UsageError,
      "say which model",
    );
    await assertRejects(
      () =>
        runModels({
          ...base,
          localFile: FILENAME,
          sha256checksum: "a".repeat(64),
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      UsageError,
      "pass exactly one",
    );
  });
});

Deno.test("the archive answers when civitai does not", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const batch = await readBatch(result.dir);
    const source = batch.source as { kind: string; label: string };
    assertEquals(source.kind, "civitai-archive");
    assertEquals(source.label, "CivArchive");
    assertEquals(batch.model.display_name, "CyberRealistic (archived)");
    // The primary road was tried and 404'd before the fallback ran.
    assert(h.fake.matching("/by-hash/").length > 0);
    assert(h.fake.matching("/api/sha256/").length > 0);
  }, { archiveOnly: true });
});

Deno.test("§3.1's invariant: `forge models` never opens app.db", async () => {
  await withCli(async (h) => {
    // A fresh data directory: if anything in this path opened the database it
    // would create the file, because that is what `openDatabase` does.
    await assertRejects(() => Deno.stat(h.paths.db), Deno.errors.NotFound);
    await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 2,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    await assertRejects(() => Deno.stat(h.paths.db), Deno.errors.NotFound);
  });
});

/**
 * Nothing on disk (DESIGN-MODEL-IMPORT §4.1, amended). Pulling metadata,
 * samples and weights *before* a model is on this machine is the point of
 * the command, so none of these fixtures put the file in a model folder.
 */

Deno.test("--filename with nothing local lists what nearly matched", async () => {
  await withCli(async (h) => {
    // Civitai stores its own mangled filenames, so a near miss is the normal
    // case. The old behaviour said "nothing was found" while holding twenty
    // candidates, which was simply false.
    const error = await assertRejects(
      () =>
        runModels({
          ...base,
          filename: "krea2_turbo_bf16.safetensors",
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
    );
    assertStringIncludes(error.message, "look close");
    assertStringIncludes(error.message, "Pick one and pass its --url");
    // The candidate's real filename is there, which is what tells you it is
    // the thing you meant.
    assertStringIncludes(error.message, FILENAME);
    assertStringIncludes(error.message, "modelVersionId=501240");
  }, { noLocalFile: true });
});

Deno.test("--filename takes an exact remote match when there is one", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      filename: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals(result.batch?.model.sha256, h.hash);
  }, { noLocalFile: true });
});

Deno.test("--filename finds a file in a version older than the newest", async () => {
  await withCli(async (h) => {
    // The listing's newest version is for another base model with another
    // file; the one asked for is in the version before it — the shape of
    // most multi-base LoRAs.
    const model = civitaiModel(h.hash, h.fake.url);
    const older = model.modelVersions[0]!;
    const newer = {
      ...older,
      id: 601000,
      name: "v10 (Flux)",
      baseModel: "Flux.1 D",
      trainedWords: ["other"],
      files: [{
        name: "cyberrealistic_flux.safetensors",
        primary: true,
        sizeKB: 4,
        downloadUrl: `${h.fake.url}/api/download/models/601000`,
        hashes: { SHA256: "D".repeat(64) },
      }],
    };
    h.fake.configure({
      models: { 15003: { ...model, modelVersions: [newer, older] } },
    });
    const result = await runModels({
      ...base,
      filename: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const batch = result.batch!;
    assertEquals(batch.model.sha256, h.hash);
    assertEquals(batch.model.family, "sd15");
    // That version's words, not the newest's.
    assertEquals(batch.model.trigger_words, ["cyberrealistic", "photo"]);
  }, { noLocalFile: true });
});

Deno.test("--search lists candidates and writes nothing", async () => {
  await withCli(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      search: "cyberrealistic",
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    assertEquals(result.batch, null);
    assertStringIncludes(lines.join("\n"), "CyberRealistic");
    assertStringIncludes(lines.join("\n"), "modelVersionId=501240");
    // Discovery is read-only: it is how you find a URL, not a way to import.
    assertEquals(await namesIn(h.paths.imports), []);
  }, { noLocalFile: true });
});

Deno.test("--download-model works with no local file and no civitai CLI", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      // By hash rather than by URL: `parseModelUrl` only accepts the real
      // hosts, which is right in production and means the fake is reached
      // through the lookups that read `import.civitai_url`.
      sha256checksum: h.hash,
      downloadModel: true,
      // `civitai` is not installed here, which is true of most machines and
      // is exactly the case that used to fail.
      config: {
        ...h.config,
        import: { ...h.config.import, civitai_cli: null },
      },
      paths: h.paths,
      client: h.client,
      log: () => {},
    });

    assertEquals(result.files, 1);
    const batch = await readBatch(result.dir);
    const [file] = batch.files!;
    assertEquals(file!.file, `model/${FILENAME}`);
    assertEquals(file!.kind, "checkpoints");
    // Hashed from what actually landed, and equal to the batch's own name,
    // which is what makes ingest able to verify it.
    assertEquals(file!.sha256, h.hash);
    assertEquals(file!.size, h.bytes.byteLength);
    const onDisk = await Deno.readFile(join(result.dir, file!.file));
    assertEquals(onDisk, h.bytes);
  }, { noLocalFile: true });
});

/**
 * A version ships several files, and the source record names its primary.
 * The hash given names one of the others — the fp16 file here — and that is
 * the file the batch has to be about, or ingest waits for a model that is
 * never coming (the bug this was written for).
 */
function twoFileVersion(h: Harness) {
  const model = civitaiModel(h.hash, h.fake.url);
  const version = model.modelVersions[0]!;
  version.files = [
    {
      name: "cyberrealistic_v90_fp32.safetensors",
      primary: true,
      sizeKB: 8,
      downloadUrl: `${h.fake.url}/api/download/models/501240?precision=fp32`,
      hashes: { SHA256: "E".repeat(64) },
    },
    {
      name: FILENAME,
      primary: false,
      sizeKB: 4,
      downloadUrl: `${h.fake.url}/api/download/models/501240?precision=fp16`,
      hashes: { SHA256: h.hash.toUpperCase() },
    },
  ];
  // `configure` replaces what the fake serves rather than adding to it.
  h.fake.configure({
    models: { 15003: model },
    versionsByHash: { [h.hash]: version },
    download: { bytes: h.bytes, filename: FILENAME },
  });
}

Deno.test("--sha256checksum names the file it was given, not the primary", async () => {
  await withCli(async (h) => {
    twoFileVersion(h);
    const result = await runModels({
      ...base,
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals(
      result.dir,
      join(h.paths.imports, "fetched", "success", h.hash),
    );
    const batch = await readBatch(result.dir);
    assertEquals(batch.model.sha256, h.hash);
    assertEquals(batch.model.filename, FILENAME);
  }, { noLocalFile: true });
});

Deno.test("--local-file of a non-primary file is keyed on that file", async () => {
  await withCli(async (h) => {
    twoFileVersion(h);
    const result = await runModels({
      ...base,
      localFile: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals((await readBatch(result.dir)).model.sha256, h.hash);
  });
});

Deno.test("--download-model fetches the variant the hash names", async () => {
  await withCli(async (h) => {
    twoFileVersion(h);
    const result = await runModels({
      ...base,
      sha256checksum: h.hash,
      downloadModel: true,
      config: {
        ...h.config,
        import: { ...h.config.import, civitai_cli: null },
      },
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const [download] = h.fake.matching("/api/download/");
    assertEquals(download!.params.precision, "fp16");
    assertEquals((await readBatch(result.dir)).files![0]!.sha256, h.hash);
  }, { noLocalFile: true });
});

Deno.test("a download that cannot match its batch writes nothing", async () => {
  await withCli(async (h) => {
    // Civitai's listing says one hash; the bytes it serves are another.
    const model = civitaiModel(h.hash, h.fake.url);
    h.fake.configure({
      models: { 15003: model },
      versionsByHash: { [h.hash]: model.modelVersions[0]! },
      download: {
        bytes: new TextEncoder().encode("other"),
        filename: FILENAME,
      },
    });
    await assertRejects(
      () =>
        runModels({
          ...base,
          sha256checksum: h.hash,
          downloadModel: true,
          config: {
            ...h.config,
            import: { ...h.config.import, civitai_cli: null },
          },
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
      "could never be matched",
    );
    // No batch — but the "no" is kept, so the same bytes are not fetched
    // again for nothing (§3.2).
    assertEquals(
      await namesIn(join(h.paths.imports, "fetched", "success")),
      [],
    );
    assertStringIncludes(
      await Deno.readTextFile(
        join(h.paths.imports, "fetched", "failure", h.hash, "error.txt"),
      ),
      "could never be matched",
    );
  }, { noLocalFile: true });
});

Deno.test("a gated model says what to do rather than writing half a batch", async () => {
  await withCli(async (h) => {
    const model = civitaiModel(h.hash, h.fake.url);
    h.fake.configure({
      models: { 15003: model },
      versionsByHash: { [h.hash]: model.modelVersions[0]! },
      downloadStatus: 401,
    });
    await assertRejects(
      () =>
        runModels({
          ...base,
          sha256checksum: h.hash,
          downloadModel: true,
          config: {
            ...h.config,
            import: { ...h.config.import, civitai_cli: null },
          },
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      Error,
      "CIVITAI_TOKEN",
    );
    // The staging directory is cleaned up, so a failed run leaves nothing for
    // the app to trip over.
    const staged: string[] = [];
    for await (
      const entry of Deno.readDir(join(h.paths.imports, "fetched", ".staging"))
    ) {
      staged.push(entry.name);
    }
    assertEquals(staged, []);
  }, { noLocalFile: true });
});

/**
 * `--filename` and `--local-file` are two different questions (§4.1): "find
 * me this by name, wherever it is" and "identify the file I already have".
 */

Deno.test("--filename reads nothing on this machine, even when the file is here", async () => {
  await withCli(async (h) => {
    // The fixture *is* in a configured folder. A remote lookup must not
    // notice, or the two flags would quietly be the same flag.
    await runModels({
      ...base,
      filename: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    // The name search ran; the hash road did not.
    assert(h.fake.matching("/api/v1/models").length > 0);
    assertEquals(h.fake.matching("/by-hash/").length, 0);
  });
});

Deno.test("--local-file takes a path as well as a configured-folder name", async () => {
  await withCli(async (h) => {
    const byPath = await runModels({
      ...base,
      localFile: join(h.modelsDir, "checkpoints", FILENAME),
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals(byPath.batch?.model.sha256, h.hash);
  });
});

Deno.test("--local-file that is nowhere points at the flags that do not need it", async () => {
  await withCli(async (h) => {
    const error = await assertRejects(
      () =>
        runModels({
          ...base,
          localFile: "not-here.safetensors",
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      UsageError,
    );
    assertStringIncludes(error.message, "--filename");
    assertStringIncludes(error.message, "--search");
  }, { noLocalFile: true });
});

Deno.test("the archive answers a filename Civitai cannot", async () => {
  await withCli(async (h) => {
    h.fake.configure({
      // Civitai knows nothing; the archive indexes the file by hash, which is
      // the case it exists for — a model Civitai has deleted.
      models: {},
      archiveSearch: {
        [FILENAME]: [{
          kind: "file",
          name: FILENAME,
          url: `/sha256/${h.hash}`,
          platform: "civitai",
          base_model: "SD 1.5",
        }],
      },
      archiveByHash: {
        [h.hash]: {
          files: [{
            filename: FILENAME,
            source: "civitai",
            model_id: "15003",
            model_version_id: "501240",
          }],
        },
      },
      archiveModels: {
        15003: {
          id: 15003,
          name: "CyberRealistic (archived)",
          type: "Checkpoint",
          version: {
            id: 501240,
            baseModel: "SD 1.5",
            files: [{ name: FILENAME, sha256: h.hash, is_primary: true }],
            images: [],
          },
        },
      },
    });

    const result = await runModels({
      ...base,
      filename: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals(result.batch?.model.display_name, "CyberRealistic (archived)");
    assert(h.fake.matching("/api/search").length > 0);
  }, { noLocalFile: true });
});

Deno.test("a hash the archive only mirrors says there is nothing to import", async () => {
  await withCli(async (h) => {
    h.fake.configure({
      models: {},
      archiveByHash: {
        // A HuggingFace copy: the bytes exist, but no model page stands
        // behind them, so there is no metadata to bring over.
        [h.hash]: {
          files: [{
            filename: FILENAME,
            source: "huggingface",
            model_id: null,
            model_version_id: null,
          }],
        },
      },
    });
    const error = await assertRejects(
      () =>
        runModels({
          ...base,
          sha256checksum: h.hash,
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
    );
    assertStringIncludes(error.message, "huggingface");
    assertStringIncludes(error.message, "no model page");
  }, { noLocalFile: true });
});

/**
 * The Civitai key (DESIGN-MODEL-IMPORT §8). It is a credential, so the tests
 * are mostly about where it must *not* go.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

function withToken(
  h: Harness,
  token: string | null = TOKEN,
): { config: Harness["config"]; client: CivitaiClient } {
  const config = {
    ...h.config,
    import: { ...h.config.import, civitai_token: token, civitai_cli: null },
  };
  // Built the way `runModels` builds it, so the token takes the same road.
  const client = new CivitaiClient({
    civitaiUrl: h.fake.url,
    archiveUrl: h.fake.url,
    browsingLevel: config.import.browsing_level,
    timeoutMs: 5000,
    token: civitaiToken(config, { get: () => undefined }),
    now: () => new Date("2026-09-25T10:00:00Z"),
  });
  return { config, client };
}

Deno.test("the token goes to Civitai and never to the archive", async () => {
  await withCli(async (h) => {
    const { config, client } = withToken(h);
    await runModels({
      ...base,
      filename: FILENAME,
      source: "auto",
      config,
      paths: h.paths,
      client,
      log: () => {},
    }).catch(() => {});

    const toCivitai = h.fake.requests.filter((r) =>
      r.path.startsWith("/api/v1/")
    );
    assert(toCivitai.length > 0, "Civitai should have been asked");
    for (const request of toCivitai) {
      assertEquals(request.authorization, `Bearer ${TOKEN}`, request.path);
    }
  });

  // Forced down the archive road, which is a different service and must
  // never see a Civitai key — both fakes are one server here, which is
  // exactly the case a host comparison would get wrong.
  await withCli(async (h) => {
    const { config, client } = withToken(h);
    await runModels({
      ...base,
      filename: FILENAME,
      source: "archive",
      config,
      paths: h.paths,
      client,
      log: () => {},
    }).catch(() => {});
    const toArchive = h.fake.requests.filter((r) =>
      r.path.startsWith("/api/search") || r.path.startsWith("/api/sha256") ||
      (r.path.startsWith("/api/models/") && !r.path.startsWith("/api/v1/"))
    );
    assert(toArchive.length > 0, "the archive should have been asked");
    for (const request of toArchive) {
      assertEquals(request.authorization, null, request.path);
    }
  });
});

Deno.test("sample images are fetched without the token", async () => {
  await withCli(async (h) => {
    const { config, client } = withToken(h);
    await runModels({
      ...base,
      localFile: FILENAME,
      downloadSamples: 2,
      config,
      paths: h.paths,
      client,
      log: () => {},
    });
    const images = h.fake.matching("/img/");
    assert(images.length > 0);
    // The CDN is public; nothing about it needs a key.
    for (const request of images) assertEquals(request.authorization, null);
  });
});

Deno.test("the token is sent with the model download", async () => {
  await withCli(async (h) => {
    const { config, client } = withToken(h);
    await runModels({
      ...base,
      sha256checksum: h.hash,
      downloadModel: true,
      config,
      paths: h.paths,
      client,
      log: () => {},
    });
    const [download] = h.fake.matching("/api/download/");
    assertEquals(download?.authorization, `Bearer ${TOKEN}`);
  }, { noLocalFile: true });
});

Deno.test("CIVITAI_TOKEN wins over config.yaml", () => {
  const config = {
    import: { civitai_token: "from-config" },
  } as unknown as Parameters<typeof civitaiToken>[0];
  assertEquals(civitaiToken(config, { get: () => "from-env" }), "from-env");
  assertEquals(civitaiToken(config, { get: () => undefined }), "from-config");
  // Blank means unset, in either place.
  assertEquals(civitaiToken(config, { get: () => "  " }), "from-config");
  const none = { import: { civitai_token: "" } } as unknown as Parameters<
    typeof civitaiToken
  >[0];
  assertEquals(civitaiToken(none, { get: () => undefined }), null);
});

Deno.test("a configured token wins over an installed civitai CLI", async () => {
  await withCli(async (h) => {
    // A stand-in `civitai` that answers --version, and records any attempt
    // to download. With a token configured it must never be asked: it keeps
    // its own login, and using it would silently ignore the key you set.
    const bin = await Deno.makeTempDir({ prefix: "forgeui-fake-civitai-cli-" });
    const marker = join(bin, "was-called");
    const script = join(bin, "civitai");
    await Deno.writeTextFile(
      script,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ntouch "${marker}"\nexit 1\n`,
    );
    await Deno.chmod(script, 0o755);
    try {
      const config = {
        ...h.config,
        import: {
          ...h.config.import,
          civitai_token: TOKEN,
          civitai_cli: script,
        },
      };
      await runModels({
        ...base,
        sha256checksum: h.hash,
        downloadModel: true,
        config,
        paths: h.paths,
        client: h.client,
        env: { get: () => undefined },
        log: () => {},
      });
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
      assert(h.fake.matching("/api/download/").length > 0);
    } finally {
      await Deno.remove(bin, { recursive: true });
    }
  }, { noLocalFile: true });
});

/**
 * Re-running (DESIGN-MODEL-IMPORT §3.2): a checksum anywhere in the import
 * folder is left alone without `--overwrite` — fetched, not found, imported
 * or refused — and found without a single request where that is possible.
 */

/** A directory's entries, not counting dot-names; none if it is absent. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(Deno.readDir(dir)))
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function runner(h: Harness) {
  return (
    extra: Record<string, unknown>,
    log: (line: string) => void = () => {},
  ) =>
    runModels({
      ...base,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log,
      ...extra,
    });
}

Deno.test("a second run for the same model asks nothing and writes nothing", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    const first = await run({ sha256checksum: h.hash });
    const written = await Deno.readTextFile(join(first.dir, "model.json"));

    // Every way of naming the same model, each found offline.
    for (
      const extra of [
        { sha256checksum: h.hash.toUpperCase() },
        { url: "https://civitai.red/models/15003?modelVersionId=501240" },
        // A bare model link is "the newest version", which only the network
        // knows; the one already fetched is taken to be it.
        { url: "https://civitai.com/models/15003/cyberrealistic" },
        { url: `https://civitaiarchive.com/sha256/${h.hash}` },
        { filename: FILENAME.toUpperCase() },
        { localFile: FILENAME },
      ]
    ) {
      const before = h.fake.requests.length;
      const lines: string[] = [];
      const again = await run(extra, (line) => lines.push(line));
      assertEquals(h.fake.requests.length, before, JSON.stringify(extra));
      assertEquals(again.batch, null);
      assertEquals(again.existing?.state, "fetched");
      assertEquals(again.existing?.hash, h.hash);
      const said = lines.join("\n");
      // The decision first, the earlier run's result after it, and the way
      // to change it last.
      assertStringIncludes(
        said,
        "skipped CyberRealistic · v9.0: an earlier run",
      );
      assertStringIncludes(
        said,
        "earlier result: fetched, waiting for the app",
      );
      assertStringIncludes(said, "to try again: forge models ");
      assertStringIncludes(said, "--overwrite");
    }
    // Untouched, not rewritten with the same content.
    assertEquals(
      await Deno.readTextFile(join(first.dir, "model.json")),
      written,
    );
  });
});

Deno.test("a hash nobody knows is recorded, and not asked about again", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    const unknown = "f".repeat(64);
    await assertRejects(
      () => run({ sha256checksum: unknown }),
      NotFoundError,
      "knows the hash",
    );
    const note = await Deno.readTextFile(
      join(h.paths.imports, "fetched", "failure", unknown, "error.txt"),
    );
    // When, what was asked, what kind of failure, and the answer.
    assertStringIncludes(
      note,
      `command: forge models --sha256checksum ${unknown}`,
    );
    assertStringIncludes(note, "failure: not-found\n");
    assertStringIncludes(note, "knows the hash");

    const before = h.fake.requests.length;
    const lines: string[] = [];
    const again = await run(
      { url: `https://civitaiarchive.com/sha256/${unknown}` },
      (line) => lines.push(line),
    );
    assertEquals(h.fake.requests.length, before);
    assertEquals(again.existing?.state, "fetch-failed");
    assertStringIncludes(
      lines.join("\n"),
      "earlier result: the lookup found nothing",
    );
    assertStringIncludes(lines.join("\n"), "knows the hash");

    // --overwrite asks again, and is told no again.
    await assertRejects(
      () => run({ sha256checksum: unknown, overwrite: true }),
      NotFoundError,
    );
    assert(h.fake.requests.length > before);
  }, { noLocalFile: true });
});

Deno.test("a failure to get an answer is recorded too, as what it was", async () => {
  await withCli(async (h) => {
    // Nothing listening. Not the model's fault — so it is recorded under
    // its own word, to be pruned by, not as a "no".
    const offline = new CivitaiClient({
      civitaiUrl: "http://127.0.0.1:9",
      archiveUrl: "http://127.0.0.1:9",
      browsingLevel: 31,
      timeoutMs: 2000,
    });
    const error = await runModels({
      ...base,
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: offline,
      log: () => {},
    }).catch((cause) => cause);
    assert(error instanceof LookupError && !(error instanceof NotFoundError));
    assertStringIncludes(
      await Deno.readTextFile(
        join(h.paths.imports, "fetched", "failure", h.hash, "error.txt"),
      ),
      "failure: unreachable",
    );
  }, { noLocalFile: true });
});

Deno.test("a rate limit is recorded as one, and said as one next time", async () => {
  await withCli(async (h) => {
    const model = civitaiModel(h.hash, h.fake.url);
    h.fake.configure({
      models: { 15003: model },
      // Civitai does not know it, and the archive is over its budget.
      failWith: {
        "/api/sha256/": {
          status: 429,
          body: JSON.stringify({
            status: "error",
            message:
              "You've hit our hourly API limit. Try again in about 44 minutes",
          }),
          headers: { "retry-after": "2640" },
        },
      },
    });
    const error = await runner(h)({ sha256checksum: h.hash }).catch((
      cause,
    ) => cause);
    assert(error instanceof LookupError);
    assertEquals(error.kind, "rate-limited");
    assertStringIncludes(error.message, "answered 429");

    const note = await Deno.readTextFile(
      join(h.paths.imports, "fetched", "failure", h.hash, "error.txt"),
    );
    // The header a person prunes by, and the answer as it came.
    assertStringIncludes(note, "failure: rate-limited\n");
    assertStringIncludes(
      note,
      `command: forge models --sha256checksum ${h.hash}`,
    );
    assertStringIncludes(note, "hourly API limit");
    assertStringIncludes(note, "retry after 2640");

    const lines: string[] = [];
    const again = await runner(h)(
      { sha256checksum: h.hash },
      (line) => lines.push(line),
    );
    assertEquals(again.existing?.failure, "rate-limited");
    assertStringIncludes(
      lines.join("\n"),
      "earlier result: it failed (rate-limited)",
    );
    // A limit lifts: the message says nothing was retried, not that it failed.
    assertStringIncludes(lines.join("\n"), "has not been tried yet");
  }, { noLocalFile: true });
});

/**
 * The report this is about: a download that needed a Civitai login, then a
 * re-run — token set, or only asking for samples — that printed the old
 * login error as if it were this run's. It is the earlier run's, and the
 * message has to say so before it says anything else.
 */
Deno.test("an earlier failure is reported as history, not as this run's error", async () => {
  await withCli(async (h) => {
    const dir = join(h.paths.imports, "fetched", "failure", h.hash);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "error.txt"),
      "when: 2026-09-20T09:30:00Z\n" +
        `command: forge models --sha256checksum ${h.hash}\n` +
        "failure: needs-login\n\n" +
        "this model needs a Civitai login to download. Put a key from " +
        "civitai.com/user/account in config.yaml as import.civitai_token, or " +
        "set CIVITAI_TOKEN.\n",
    );

    const before = h.fake.requests.length;
    const lines: string[] = [];
    const again = await runner(h)(
      { sha256checksum: h.hash, downloadSamples: 3 },
      (line) => lines.push(line),
    );
    assertEquals(h.fake.requests.length, before, "nothing was asked");
    assertEquals(again.existing?.state, "fetch-failed");

    const [first, ...rest] = lines;
    // Leads with the decision, dated, and without the old error in it.
    assertStringIncludes(first!, "skipped");
    assertStringIncludes(first!, "an earlier run on 2026-09-20 09:30:00 UTC");
    assertStringIncludes(first!, "without --overwrite");
    assertEquals(first!.includes("login"), false, first);
    const said = rest.join("\n");
    assertStringIncludes(said, "earlier result: it failed (needs-login)");
    assertStringIncludes(said, "its error: this model needs a Civitai login");
    assertStringIncludes(said, "has not been tried yet");
    // What this run asked for is named as not done, and the retry is the
    // run's own command with --overwrite added.
    assertStringIncludes(said, "not fetched this time: up to 3 samples");
    assertStringIncludes(
      said,
      `to try again: forge models --sha256checksum ${h.hash} ` +
        "--download-samples 3 --overwrite",
    );
  }, { noLocalFile: true });
});

Deno.test("a fetch that succeeds after a no clears the no", async () => {
  await withCli(async (h) => {
    const failure = join(h.paths.imports, "fetched", "failure", h.hash);
    await Deno.mkdir(failure, { recursive: true });
    await Deno.writeTextFile(join(failure, "error.txt"), "then\nnot found\n");
    const result = await runner(h)({ sha256checksum: h.hash, overwrite: true });
    assert(result.batch !== null);
    assert(!(await exists(failure)), "the old no should be gone");
  });
});

Deno.test("what the app imported, and what it refused, are left alone", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    const first = await run({ sha256checksum: h.hash });

    // What ingest leaves behind (§7.2): the model.json in imported/success.
    const imported = join(h.paths.imports, "imported", "success", h.hash);
    await Deno.mkdir(imported, { recursive: true });
    await Deno.rename(
      join(first.dir, "model.json"),
      join(imported, "model.json"),
    );
    await Deno.remove(first.dir, { recursive: true });

    let before = h.fake.requests.length;
    const again = await run({
      url: "https://civitai.red/models/15003?modelVersionId=501240",
    });
    assertEquals(h.fake.requests.length, before);
    assertEquals(again.existing?.state, "imported");

    // Refused instead: the batch in imported/failure, with its reason.
    const refused = join(h.paths.imports, "imported", "failure", h.hash);
    await Deno.mkdir(join(refused, ".."), { recursive: true });
    await Deno.rename(imported, refused);
    await Deno.writeTextFile(
      join(refused, "error.txt"),
      "when: 2026-09-30T00:00:00.000Z\nfailure: refused\n\nsamples/0001.png: hashes to 00, but the batch says 11\n",
    );
    const lines: string[] = [];
    before = h.fake.requests.length;
    const refusedAgain = await run(
      { filename: FILENAME },
      (line) => lines.push(line),
    );
    assertEquals(h.fake.requests.length, before);
    assertEquals(refusedAgain.existing?.state, "import-failed");
    assertStringIncludes(lines.join("\n"), "the app refused to import it");
    assertStringIncludes(lines.join("\n"), "but the batch says 11");

    // --overwrite fetches it again, into fetched/success, for another try.
    const retried = await run({ sha256checksum: h.hash, overwrite: true });
    assert(h.fake.requests.length > before);
    assertEquals(retried.existing, undefined);
    assertEquals((await readBatch(retried.dir)).overwrite, true);
  });
});

/** Move a waiting batch to where ingest leaves it: imported/success. */
async function markImported(h: Harness, dir: string): Promise<string> {
  const imported = join(h.paths.imports, "imported", "success", h.hash);
  await Deno.mkdir(imported, { recursive: true });
  await Deno.rename(join(dir, "model.json"), join(imported, "model.json"));
  await Deno.remove(dir, { recursive: true });
  return imported;
}

async function editBatch(
  dir: string,
  edit: (batch: ImportBatch) => void,
): Promise<void> {
  const batch = await readBatch(dir);
  edit(batch);
  await Deno.writeTextFile(join(dir, "model.json"), JSON.stringify(batch));
}

Deno.test("--overwrite naming one place leaves the other's results alone", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    const imported = await markImported(
      h,
      (await run({ sha256checksum: h.hash })).dir,
    );
    await editBatch(imported, (batch) => {
      batch.model.display_name = "As imported";
    });

    // A scope reaching only fetched/ does not touch what the app imported,
    // and asks nothing to find that out.
    const lines: string[] = [];
    const before = h.fake.requests.length;
    const skipped = await run({
      sha256checksum: h.hash,
      downloadSamples: 1,
      overwrite: parseOverwrite("fetched,samples"),
    }, (line) => lines.push(line));
    assertEquals(h.fake.requests.length, before);
    assertEquals(skipped.existing?.state, "imported");
    const said = lines.join("\n");
    assertStringIncludes(
      said,
      "--overwrite=fetched,samples does not reach imported/, where it is.",
    );
    assertStringIncludes(said, "--download-samples 1 --overwrite=samples");

    // Naming imported samples fetches the samples, marks them to replace
    // what the app has, and keeps the metadata the app applied.
    const result = await run({
      sha256checksum: h.hash,
      downloadSamples: 1,
      overwrite: parseOverwrite("imported,samples"),
    });
    const batch = await readBatch(result.dir);
    assertEquals(batch.samples?.length, 1);
    assertEquals(batch.overwrite_samples, true);
    assertEquals(batch.overwrite, false);
    assertEquals(batch.model.display_name, "As imported");
    assertEquals(result.kept, ["metadata"]);
  });
});

Deno.test("a waiting batch keeps the parts --overwrite does not name", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    const first = await run({ sha256checksum: h.hash, downloadSamples: 1 });
    // The weights a --download-model run would have left, and a hand edit.
    await Deno.mkdir(join(first.dir, "model"));
    await Deno.writeTextFile(join(first.dir, "model", FILENAME), "weights");
    await editBatch(first.dir, (batch) => {
      batch.model.display_name = "Hand-written";
      batch.files = [{ file: `model/${FILENAME}`, kind: "checkpoints" }];
    });

    // Samples only: three now, from the page and its gallery; the weights
    // are not downloaded again and the edited metadata stays.
    const lines: string[] = [];
    const samples = await run({
      sha256checksum: h.hash,
      downloadSamples: 3,
      downloadModel: true,
      overwrite: parseOverwrite("samples"),
    }, (line) => lines.push(line));
    assertEquals(h.fake.matching("/api/download/").length, 0);
    let batch = await readBatch(samples.dir);
    assertEquals(batch.samples?.length, 3);
    assertEquals(batch.model.display_name, "Hand-written");
    assertEquals(batch.files, [{
      file: `model/${FILENAME}`,
      kind: "checkpoints",
    }]);
    assertEquals(
      await Deno.readTextFile(join(samples.dir, "model", FILENAME)),
      "weights",
    );
    assertEquals(samples.kept, ["metadata", "models"]);
    assertStringIncludes(
      lines.join("\n"),
      "not fetched: models, which --overwrite=samples does not name",
    );

    // Metadata only: the lookup's answer again, and the samples and weights
    // carried over as they were.
    const sampleFiles = await namesIn(join(samples.dir, "samples"));
    const metadata = await run({
      sha256checksum: h.hash,
      downloadSamples: 1,
      overwrite: parseOverwrite("metadata"),
    });
    batch = await readBatch(metadata.dir);
    assertEquals(batch.model.display_name, "CyberRealistic");
    assertEquals(batch.samples?.length, 3);
    assertEquals(await namesIn(join(metadata.dir, "samples")), sampleFiles);
    assert(await exists(join(metadata.dir, "model", FILENAME)));
    assertEquals(metadata.kept, ["samples", "models"]);
  }, { gallery: galleryOf });
});

Deno.test("another version of the same model is another file", async () => {
  await withCli(async (h) => {
    const run = runner(h);
    await run({ sha256checksum: h.hash });
    const other = await run({
      url: "https://civitai.red/models/15003?modelVersionId=999999",
    }).catch((cause) => cause);
    assert(
      other instanceof LookupError,
      "it should have asked, and been told no",
    );
  });
});

Deno.test("a link nothing here recorded is still stopped before anything is written", async () => {
  await withCli(async (h) => {
    // Another machine sharing this folder imported it; nothing here says
    // which link it was. The lookup runs — and then nothing is downloaded.
    const elsewhere = join(h.paths.imports, "imported", "success", h.hash);
    await Deno.mkdir(elsewhere, { recursive: true });
    const result = await runner(h)({
      url: "https://civitai.red/models/15003?modelVersionId=501240",
      downloadSamples: 4,
    });
    assertEquals(result.existing?.state, "imported");
    assertEquals(result.batch, null);
    assertEquals(h.fake.matching("/img/"), [], "no sample was downloaded");
    assertEquals(
      await namesIn(join(h.paths.imports, "fetched", "success")),
      [],
    );
  }, { noLocalFile: true });
});
