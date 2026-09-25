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
import { LookupError, runModels, UsageError } from "../../src/cli/models.ts";
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
      images: [
        {
          id: 900001,
          url: `${base}/img/anim=false,width=450,optimized=true/900001.jpeg`,
          width: 768,
          height: 512,
          type: "image",
          nsfwLevel: 1,
        },
        {
          id: 900002,
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
  config: ReturnType<typeof effectiveConfig>;
  paths: ReturnType<typeof dataPaths>;
  client: CivitaiClient;
  hash: string;
}

async function withCli(
  body: (h: Harness) => Promise<void>,
  options: { archiveOnly?: boolean; nsfwLevel?: number } = {},
): Promise<void> {
  const { bytes, hash } = await fixture();
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-cli-" });
  const modelsDir = await Deno.makeTempDir({ prefix: "forgeui-cli-models-" });
  await Deno.mkdir(join(modelsDir, "checkpoints"), { recursive: true });
  await Deno.writeFile(join(modelsDir, "checkpoints", FILENAME), bytes);

  // One fake plays both sites, which is enough: what the test is about is
  // which one is asked, and in what order.
  const fake = startFakeCivitai();
  const model = civitaiModel(hash, fake.url);
  // What `/api/v1/images` really answers with: ids, already-original URLs,
  // dimensions and `meta`. The version object's own images carry no id, which
  // is why this endpoint is what samples are built from (§4.3).
  const meta = {
    501240: [
      {
        id: 900001,
        url: `${fake.url}/img/original=true/900001.jpeg`,
        width: 768,
        height: 512,
        type: "image",
        nsfwLevel: 1,
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
        meta: {},
      },
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
    await body({ fake, config, paths, client, hash });
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

Deno.test("--filename hashes the local file and writes a batch", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      filename: FILENAME,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });

    assertEquals(result.dir, join(h.paths.imports, h.hash));
    const batch = await readBatch(result.dir);
    assertEquals(batch.format, 1);
    assertEquals(batch.model.sha256, h.hash);
    assertEquals(batch.model.family, "sd15");
    assertEquals(batch.model.kind, "checkpoints");
    assertEquals(batch.model.display_name, "CyberRealistic");
    // The comma-separated single string is split, trimmed and de-duplicated.
    assertEquals(batch.model.trigger_words, ["cyberrealistic", "photo"]);
    // Notes get the trigger words and not eight kilobytes of HTML.
    assertEquals(batch.model.notes, "Trigger words: cyberrealistic, photo");

    const record = batch.civitai as {
      model: { description_text: string; description_html: string };
    };
    assertStringIncludes(record.model.description_text, "# CyberRealistic");
    assertStringIncludes(record.model.description_html, "<h1>");

    // It was found by hash, which means the local file decided it.
    assert(h.fake.matching("/model-versions/by-hash/").length > 0);
  });
});

Deno.test("the lookup sends the visibility parameter §4.0's table names", async () => {
  await withCli(async (h) => {
    await runModels({
      ...base,
      filename: FILENAME,
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
      filename: FILENAME,
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

Deno.test("the batch is renamed into place, never written in halves", async () => {
  await withCli(async (h) => {
    const result = await runModels({
      ...base,
      filename: FILENAME,
      downloadSamples: 1,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    // Staging is empty afterwards: the finished directory was renamed, so the
    // app never sees a partial batch.
    const staged: string[] = [];
    for await (const entry of Deno.readDir(join(h.paths.imports, ".staging"))) {
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
      filename: FILENAME,
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
          filename: FILENAME,
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
      filename: FILENAME,
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
      filename: FILENAME,
      downloadSamples: 2,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    await assertRejects(() => Deno.stat(h.paths.db), Deno.errors.NotFound);
  });
});
