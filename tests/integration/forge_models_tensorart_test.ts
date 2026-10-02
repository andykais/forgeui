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
import {
  LookupError,
  parseImportSource,
  runModels,
  UsageError,
} from "../../src/cli/models.ts";
import type { ImportBatch } from "../../src/models/import.ts";

/**
 * `forge models` against Tensor.Art (DESIGN-MODEL-IMPORT §4.6) — which is to
 * say against the archive's mirror of it, the only thing a script can ask.
 * The fake plays the archive; nothing here reaches tensor.art.
 */

// 18 digits: past what a JavaScript number holds, so any path through a
// number would change it.
const MODEL = "765307161749456877";
const FILE = "flux_dev.safetensors";

interface Harness {
  fake: ReturnType<typeof startFakeCivitai>;
  bytes: Uint8Array;
  hash: string;
  config: ReturnType<typeof effectiveConfig>;
  paths: ReturnType<typeof dataPaths>;
  client: CivitaiClient;
  model: Record<string, unknown>;
}

function tensorModel(
  hash: string,
  base: string,
  options: { mirrors?: unknown[] } = {},
) {
  return {
    id: MODEL,
    name: "FLUX",
    type: "CHECKPOINT",
    description: "<p>FLUX.1 [dev] is a <b>12 billion</b> parameter model.</p>",
    download_count: 1835241,
    favorite_count: 3,
    is_nsfw: false,
    username: "miaomiao",
    creator_id: "694618803287382241",
    creator_name: "miaomiao",
    tags: ["flux"],
    versions: [{ id: MODEL, name: "Dev fp32" }],
    platform: "tensorart",
    platform_name: "TensorArt",
    version: {
      id: MODEL,
      name: "Dev fp32",
      base_model: "FLUX.1",
      description: null,
      trigger: ["cinematic, film"],
      allow_download: false,
      download_url: `https://tensor.art/models/${MODEL}`,
      platform_url: `https://tensor.art/models/${MODEL}`,
      created_at: "2024-08-10T04:47:27.000Z",
      files: [{
        id: MODEL,
        name: FILE,
        size_kb: 4,
        sha256: hash,
        mirrors: options.mirrors ?? [
          {
            source: "civitai",
            url: `${base}/api/download/models/691639`,
            deleted_at: null,
            is_gated: false,
            is_paid: false,
          },
        ],
      }],
      images: [
        { id: 1, url: `${base}/img/model_showcase/0/a.jpeg`, type: "image" },
        { id: 2, url: `${base}/img/model_showcase/0/b.jpeg`, type: "image" },
      ],
    },
  };
}

async function withTensor(
  body: (h: Harness) => Promise<void>,
  options: { civitaiToken?: string; mirrors?: unknown[] } = {},
): Promise<void> {
  const scratch = await Deno.makeTempDir({ prefix: "forgeui-ta-src-" });
  const bytes = await writeFakeSafetensors(join(scratch, "m.safetensors"), {
    name: "flux",
  });
  await Deno.remove(scratch, { recursive: true });
  const hash = await sha256Hex(bytes);
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-ta-" });

  const fake = startFakeCivitai();
  const model = tensorModel(hash, fake.url, { mirrors: options.mirrors });
  fake.configure({
    tensorArtModels: { [MODEL]: model },
    imageBytes: tinyPng({ width: 8, height: 8, color: [9, 8, 7] }),
    download: { bytes, filename: FILE },
  });
  const config = effectiveConfig({
    import: {
      civitai_url: fake.url,
      archive_url: fake.url,
      civitai_cli: null,
    },
  });
  const paths = dataPaths(dataDir, config.import);
  await ensureDataDirs(paths);
  const client = new CivitaiClient({
    civitaiUrl: fake.url,
    archiveUrl: fake.url,
    timeoutMs: 5000,
    token: options.civitaiToken ?? null,
    now: () => new Date("2026-09-30T10:00:00Z"),
  });
  try {
    await body({ fake, bytes, hash, config, paths, client, model });
  } finally {
    await fake.close();
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
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

function run(h: Harness, extra: Record<string, unknown> = {}) {
  return runModels({
    ...base,
    config: h.config,
    paths: h.paths,
    client: h.client,
    log: () => {},
    ...extra,
  });
}

async function readBatch(dir: string): Promise<ImportBatch> {
  return JSON.parse(await Deno.readTextFile(join(dir, "model.json")));
}

Deno.test("--import-source tensor.art is a spelling of tensorart", () => {
  assertEquals(parseImportSource("tensor.art").source, "tensorart");
  assertEquals(parseImportSource("tensorart").source, "tensorart");
});

Deno.test("a tensor.art link imports what the archive's copy of it says", async () => {
  await withTensor(async (h) => {
    const result = await run(h, {
      url: `https://tensor.art/models/${MODEL}`,
    });
    assertEquals(
      result.dir,
      join(h.paths.imports, "fetched", "success", h.hash),
    );
    const batch = await readBatch(result.dir);
    assertEquals(batch.model.sha256, h.hash);
    assertEquals(batch.model.filename, FILE);
    assertEquals(batch.model.kind, "checkpoints");
    assertEquals(batch.model.family, "flux");
    assertEquals(batch.model.display_name, "FLUX");
    assertEquals(batch.model.trigger_words, ["cinematic", "film"]);

    const record = batch.civitai as {
      source: Record<string, unknown>;
      model: { description_text: string };
      creator: { username: string; url: string };
    };
    assertEquals(record.source.kind, "tensorart");
    assertEquals(record.source.label, "Tensor.Art");
    assertEquals(record.source.url, `https://tensor.art/models/${MODEL}`);
    // The id is intact: as a number it would have become …900.
    assertEquals(record.source.tensorart_model_id, MODEL);
    assertEquals(record.source.tensorart_version_id, MODEL);
    assertEquals(
      record.model.description_text,
      "FLUX.1 [dev] is a **12 billion** parameter model.",
    );
    assertEquals(record.creator, {
      username: "miaomiao",
      url: "https://tensor.art/u/694618803287382241",
    });
    // The model-only link followed the archive's redirect to its version.
    assertEquals(
      h.fake.matching("/tensorart/models/").map((request) => request.path),
      [
        `/tensorart/models/${MODEL}`,
        `/tensorart/models/${MODEL}/versions/${MODEL}`,
      ],
    );
  });
});

Deno.test("the showcase images are its samples, linked to its page", async () => {
  await withTensor(async (h) => {
    const result = await run(h, {
      url: `https://tensor.art/models/${MODEL}`,
      downloadSamples: 4,
    });
    assertEquals(result.samples, 2);
    const batch = await readBatch(result.dir);
    assertEquals(batch.samples!.length, 2);
    assertEquals(
      (batch.samples![0]!.source as { kind: string; label: string }).kind,
      "tensorart",
    );
    assertEquals(h.fake.matching("/img/model_showcase/").length, 2);
  });
});

Deno.test("--download-model fetches a public copy of the same bytes", async () => {
  await withTensor(async (h) => {
    const result = await run(h, {
      url: `https://tensor.art/models/${MODEL}`,
      downloadModel: true,
      env: {
        get: (key: string) =>
          key === "CIVITAI_TOKEN"
            ? "civitai-key"
            : key === "HF_TOKEN"
            ? "hf-key"
            : undefined,
      },
    });
    const batch = await readBatch(result.dir);
    assertEquals(batch.files![0]!.sha256, h.hash);
    assertEquals(
      await Deno.readFile(join(result.dir, batch.files![0]!.file)),
      h.bytes,
    );
    // From the copy on Civitai, with Civitai's key — the site it is on —
    // and never Hugging Face's.
    const [download] = h.fake.matching("/api/download/");
    assertEquals(download!.path, "/api/download/models/691639");
    assertEquals(download!.authorization, "Bearer civitai-key");
  });
});

Deno.test("with no public copy, it says where to get it and records why", async () => {
  await withTensor(async (h) => {
    const error = await assertRejects(
      () =>
        run(h, {
          url: `https://tensor.art/models/${MODEL}`,
          downloadModel: true,
        }),
      LookupError,
      "logged-in browser",
    );
    assertEquals(error.kind, "needs-login");
    assertStringIncludes(error.message, `https://tensor.art/models/${MODEL}`);
    assertStringIncludes(
      await Deno.readTextFile(
        join(h.paths.imports, "fetched", "failure", h.hash, "error.txt"),
      ),
      "failure: needs-login",
    );
    // Without --download-model the metadata still imports — once the "no"
    // is cleared, as any other checksum's would be.
    await Deno.remove(join(h.paths.imports, "fetched", "failure", h.hash), {
      recursive: true,
    });
    const result = await run(h, { url: `https://tensor.art/models/${MODEL}` });
    assert(result.batch !== null);
  }, { mirrors: [] });
});

Deno.test("a hash only Tensor.Art has is found through the archive", async () => {
  await withTensor(async (h) => {
    h.fake.configure({
      tensorArtModels: { [MODEL]: h.model },
      archiveByHash: {
        [h.hash]: {
          files: [{
            filename: FILE,
            url: `/tensorart/models/${MODEL}/versions/${MODEL}`,
            source: "tensorart",
            model_id: MODEL,
            model_version_id: MODEL,
          }, {
            filename: FILE,
            url: `https://huggingface.co/x/y/resolve/main/${FILE}`,
            source: "huggingface",
            model_id: null,
          }],
        },
      },
    });
    const result = await run(h, { sha256checksum: h.hash });
    const batch = await readBatch(result.dir);
    assertEquals(
      (batch.civitai as { source: { kind: string } }).source.kind,
      "tensorart",
    );
    // Civitai was asked first, as `auto` says. And the Tensor.Art copy's
    // model_id — a Tensor.Art id — was never read as a Civitai one.
    assertEquals(h.fake.matching("/by-hash/").length, 1);
    assertEquals(h.fake.matching("/api/models/"), []);
  });
});

Deno.test("--import-source tensorart skips Civitai and its archive", async () => {
  await withTensor(async (h) => {
    h.fake.configure({
      tensorArtModels: { [MODEL]: h.model },
      versionsByHash: { [h.hash]: { id: 1, modelId: 2, files: [] } },
      archiveByHash: {
        [h.hash]: {
          files: [
            { source: "civitai", model_id: "2", model_version_id: "1" },
            {
              source: "tensorart",
              model_id: MODEL,
              model_version_id: MODEL,
              url: `/tensorart/models/${MODEL}/versions/${MODEL}`,
            },
          ],
        },
      },
      archiveModels: { 2: { id: 2, name: "from Civitai", version: {} } },
    });
    const result = await run(h, {
      sha256checksum: h.hash,
      source: "tensorart",
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      (batch.civitai as { source: { kind: string } }).source.kind,
      "tensorart",
    );
    assertEquals(h.fake.matching("/by-hash/"), []);
    assertEquals(h.fake.matching("/api/models/"), []);
  });
});

Deno.test("--filename and --search go through the archive's Tensor.Art rows", async () => {
  await withTensor(async (h) => {
    h.fake.configure({
      tensorArtModels: { [MODEL]: h.model },
      archiveSearch: {
        [FILE]: [{
          kind: "file",
          name: FILE,
          platform: "tensorart",
          url: `/tensorart/models/${MODEL}/versions/${MODEL}`,
        }],
        flux: [{
          kind: "version",
          name: "FLUX Dev fp32",
          platform: "tensorart",
          type: "CHECKPOINT",
          base_model: "FLUX.1",
          url: `/tensorart/models/${MODEL}/versions/${MODEL}`,
        }, {
          kind: "version",
          name: "Something on Civitai",
          platform: "civitai",
          url: "/models/1",
        }],
      },
    });
    const byName = await run(h, { filename: FILE, source: "tensorart" });
    assertEquals((await readBatch(byName.dir)).model.sha256, h.hash);

    const lines: string[] = [];
    const listed = await runModels({
      ...base,
      search: "flux",
      source: "tensorart",
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    assertEquals(listed.batch, null);
    const said = lines.join("\n");
    assertStringIncludes(said, `https://tensor.art/models/${MODEL}`);
    assert(!said.includes("Something on Civitai"), said);
  });
});

Deno.test("a tensor.art link already fetched is not asked about again", async () => {
  await withTensor(async (h) => {
    await run(h, { url: `https://tensor.art/models/${MODEL}` });
    const before = h.fake.requests.length;
    const again = await run(h, {
      url: `https://tensor.art/models/${MODEL}/${MODEL}`,
    });
    assertEquals(h.fake.requests.length, before);
    assertEquals(again.existing?.state, "fetched");
  });
});

Deno.test("a link and a source that disagree are refused", async () => {
  await withTensor(async (h) => {
    await assertRejects(
      () =>
        run(h, {
          url: `https://tensor.art/models/${MODEL}`,
          source: "civitai",
        }),
      UsageError,
      "Tensor.Art model",
    );
    await assertRejects(
      () =>
        run(h, { url: "https://civitai.com/models/4384", source: "tensorart" }),
      UsageError,
      "Civitai model",
    );
    assertEquals(h.fake.requests, []);
  });
});

Deno.test("the archive not having it says Tensor.Art cannot be asked", async () => {
  await withTensor(async (h) => {
    h.fake.configure({ tensorArtModels: {} });
    await assertRejects(
      () => run(h, { url: "https://tensor.art/models/123456789012345678" }),
      LookupError,
      "Tensor.Art itself cannot be asked",
    );
  });
});

Deno.test("of several Tensor.Art copies of a file, the most downloaded is used", async () => {
  await withTensor(async (h) => {
    const REUPLOAD = "799721029590237346";
    const version = h.model.version as Record<string, unknown>;
    const reupload = {
      ...h.model,
      id: REUPLOAD,
      name: "FLUX.1.2-dev2pro-full",
      version: { ...version, id: REUPLOAD, download_count: 12 },
    };
    const original = {
      ...h.model,
      version: { ...version, download_count: 1835241 },
    };
    const copy = (id: string) => ({
      source: "tensorart",
      model_id: id,
      model_version_id: id,
      url: `/tensorart/models/${id}/versions/${id}`,
    });
    h.fake.configure({
      tensorArtModels: { [MODEL]: original, [REUPLOAD]: reupload },
      // Listed first, as the archive happened to list the real one.
      archiveByHash: { [h.hash]: { files: [copy(REUPLOAD), copy(MODEL)] } },
    });
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: new CivitaiClient({
        civitaiUrl: h.fake.url,
        archiveUrl: h.fake.url,
        timeoutMs: 5000,
        say: (line) => lines.push(line),
      }),
      log: () => {},
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      (batch.civitai as { source: { tensorart_model_id: string } }).source
        .tensorart_model_id,
      MODEL,
    );
    assertStringIncludes(lines.join("\n"), "1,835,241 downloads");
    assertStringIncludes(lines.join("\n"), "--url");
  });
});
