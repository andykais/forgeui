import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { startFakeCivitai } from "../fake-civitai/server.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { effectiveConfig } from "../../src/config/config.ts";
import { dataPaths, ensureDataDirs } from "../../src/config/paths.ts";
import { sha256Hex } from "../../src/workflows/hash.ts";
import { CivitaiClient } from "../../src/cli/civitai_client.ts";
import { HuggingFaceClient } from "../../src/cli/huggingface_client.ts";
import {
  huggingFaceToken,
  LookupError,
  parseImportSource,
  runModels,
  UsageError,
} from "../../src/cli/models.ts";
import type { ImportBatch } from "../../src/models/import.ts";

/**
 * `forge models` against Hugging Face (DESIGN-MODEL-IMPORT §4.5), through the
 * same fake that plays Civitai and the archive. The real Hub is never called.
 */

const REPO = "XLabs-AI/flux-RealismLora";
const FILE = "lora.safetensors";

const README = [
  "---",
  "license: other",
  "base_model: black-forest-labs/FLUX.1-dev",
  "---",
  '<h1 align="center">Realism LoRA</h1>',
  "",
  '<img src="assets/grid.png" alt="grid">',
  "",
  "Use it at strength **0.8**.",
].join("\n");

function repoInfo(name: string, likes: number, files: string[]) {
  return {
    _id: `id-${name}`,
    id: name,
    author: name.split("/")[0],
    private: false,
    gated: false,
    pipeline_tag: "text-to-image",
    library_name: "diffusers",
    tags: ["lora", "Flux", "base_model:black-forest-labs/FLUX.1-dev"],
    cardData: {
      license: "other",
      base_model: "black-forest-labs/FLUX.1-dev",
      instance_prompt: "realism",
    },
    downloads: likes * 10,
    likes,
    lastModified: "2024-08-06T00:00:00.000Z",
    sha: "abc123",
    siblings: files.map((rfilename) => ({ rfilename })),
  };
}

interface Harness {
  fake: ReturnType<typeof startFakeCivitai>;
  bytes: Uint8Array;
  hash: string;
  config: ReturnType<typeof effectiveConfig>;
  paths: ReturnType<typeof dataPaths>;
  client: CivitaiClient;
  said: string[];
}

async function withHub(
  body: (h: Harness) => Promise<void>,
  options: { hfToken?: string; civitaiToken?: string } = {},
): Promise<void> {
  const scratch = await Deno.makeTempDir({ prefix: "forgeui-hf-src-" });
  const bytes = await writeFakeSafetensors(join(scratch, "m.safetensors"), {
    name: "realism",
  });
  await Deno.remove(scratch, { recursive: true });
  const hash = await sha256Hex(bytes);
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-hf-" });

  const fake = startFakeCivitai();
  fake.configure({
    hubRepos: {
      [REPO]: {
        info: repoInfo(REPO, 500, [".gitattributes", "README.md", FILE]),
        files: {
          "README.md": { text: README },
          [FILE]: { sha256: hash, size: bytes.byteLength, bytes },
        },
      },
    },
  });

  const config = effectiveConfig({
    import: {
      civitai_url: fake.url,
      archive_url: fake.url,
      huggingface_url: fake.url,
      civitai_cli: null,
    },
  });
  const paths = dataPaths(dataDir, config.import);
  await ensureDataDirs(paths);
  const said: string[] = [];
  const client = new CivitaiClient({
    civitaiUrl: fake.url,
    archiveUrl: fake.url,
    timeoutMs: 5000,
    token: options.civitaiToken ?? null,
    now: () => new Date("2026-09-29T10:00:00Z"),
    huggingface: new HuggingFaceClient({
      hubUrl: fake.url,
      token: options.hfToken ?? null,
      timeoutMs: 5000,
      now: () => new Date("2026-09-29T10:00:00Z"),
      say: (line) => said.push(line),
    }),
  });

  try {
    await body({ fake, bytes, hash, config, paths, client, said });
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

async function readBatch(dir: string): Promise<ImportBatch> {
  return JSON.parse(await Deno.readTextFile(join(dir, "model.json")));
}

Deno.test("--import-source: spelled as the sites are", () => {
  assertEquals(parseImportSource("auto"), { source: "auto", civitaiUrl: null });
  assertEquals(parseImportSource("civitai.red"), {
    source: "civitai",
    civitaiUrl: "https://civitai.red",
  });
  assertEquals(parseImportSource("civitai.com"), {
    source: "civitai",
    civitaiUrl: "https://civitai.com",
  });
  assertEquals(parseImportSource("civitaiarchive").source, "archive");
  assertEquals(parseImportSource("HuggingFace").source, "huggingface");
  assertThrows(() => parseImportSource("red"), UsageError, "civitai.red");
});

Deno.test("a huggingface.co file link imports its title and README", async () => {
  await withHub(async (h) => {
    const result = await runModels({
      ...base,
      url: `https://huggingface.co/${REPO}/blob/main/${FILE}`,
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
    assertEquals(batch.model.filename, FILE);
    assertEquals(batch.model.display_name, "flux-RealismLora");
    assertEquals(batch.model.kind, "loras");
    assertEquals(batch.model.family, "flux");
    assertEquals(batch.model.trigger_words, ["realism"]);

    const record = batch.civitai as {
      source: { kind: string; url: string; repo: string };
      model: { description_text: string };
    };
    assertEquals(record.source.kind, "huggingface");
    assertEquals(record.source.url, `${h.fake.url}/${REPO}`);
    // Front matter gone, the HTML heading a heading, the relative image a
    // link into the repo.
    assertEquals(
      record.model.description_text,
      [
        "# Realism LoRA",
        "",
        `![grid](${h.fake.url}/${REPO}/resolve/main/assets/grid.png)`,
        "",
        "Use it at strength **0.8**.",
      ].join("\n"),
    );
  });
});

Deno.test("a repo link means its one weight file, or says which to pick", async () => {
  await withHub(async (h) => {
    // One weight file: that is the one.
    const one = await runModels({
      ...base,
      url: `https://huggingface.co/${REPO}`,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals((await readBatch(one.dir)).model.sha256, h.hash);

    // Two precisions at the root: a list of links, not a guess.
    h.fake.configure({
      hubRepos: {
        "o/two": {
          info: repoInfo("o/two", 1, [
            "m_fp16.safetensors",
            "m_fp32.safetensors",
            "unet/diffusion_pytorch_model.safetensors",
          ]),
          files: {},
        },
      },
    });
    const error = await assertRejects(
      () =>
        runModels({
          ...base,
          url: "https://huggingface.co/o/two",
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
      "holds 3 weight files",
    );
    assertStringIncludes(
      error.message,
      `${h.fake.url}/o/two/blob/abc123/m_fp16.safetensors`,
    );
  });
});

Deno.test("a hash only the archive knows reads the most-liked Hugging Face copy", async () => {
  await withHub(async (h) => {
    const copy = (repo: string, path = FILE) => ({
      filename: path.split("/").pop(),
      url: `https://huggingface.co/${repo}/resolve/main/${path}`,
      source: "huggingface",
      model_id: null,
      model_version_id: null,
    });
    const mirror = (name: string, likes: number) => ({
      info: repoInfo(name, likes, [FILE]),
      files: { [FILE]: { sha256: h.hash, size: h.bytes.byteLength } },
    });
    h.fake.configure({
      archiveByHash: {
        [h.hash]: {
          files: [
            copy("someone/reupload"),
            copy("gone/deleted"),
            copy(REPO),
            copy("other/pack", `loras/${FILE}`),
          ],
        },
      },
      hubRepos: {
        "someone/reupload": mirror("someone/reupload", 2),
        "other/pack": mirror("other/pack", 40),
        [REPO]: {
          info: repoInfo(REPO, 500, ["README.md", FILE]),
          files: {
            "README.md": { text: README },
            [FILE]: { sha256: h.hash, size: h.bytes.byteLength },
          },
        },
      },
    });

    const result = await runModels({
      ...base,
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      (batch.civitai as { source: { repo: string } }).source.repo,
      REPO,
    );
    // Civitai was asked first, as `auto` says, and did not know it.
    assertEquals(h.fake.matching("/by-hash/").length, 1);
    // The choice is said, with how to make another.
    assert(
      h.said.some((line) => line.includes(`using ${REPO} (500 likes)`)),
      h.said.join("\n"),
    );
    assert(h.said.some((line) => line.includes("--url")));
  });
});

Deno.test("--import-source huggingface asks neither Civitai nor the archive's model", async () => {
  await withHub(async (h) => {
    h.fake.configure({
      // Civitai would know it — and is not asked.
      versionsByHash: { [h.hash]: { id: 1, modelId: 2, files: [] } },
      archiveByHash: {
        [h.hash]: {
          files: [
            {
              source: "civitai",
              model_id: "2",
              model_version_id: "1",
              url: "https://civitai.com/api/download/models/1",
            },
            {
              source: "huggingface",
              model_id: null,
              url: `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
            },
          ],
        },
      },
      archiveModels: { 2: { id: 2, name: "from the archive", version: {} } },
      hubRepos: {
        [REPO]: {
          info: repoInfo(REPO, 5, [FILE]),
          files: { [FILE]: { sha256: h.hash, size: 1 } },
        },
      },
    });
    const result = await runModels({
      ...base,
      source: "huggingface",
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    const batch = await readBatch(result.dir);
    assertEquals(
      (batch.civitai as { source: { kind: string } }).source.kind,
      "huggingface",
    );
    assertEquals(h.fake.matching("/by-hash/"), []);
    assertEquals(h.fake.matching("/api/models/2"), []);
  });
});

Deno.test("--import-source archive names the Hugging Face copies it will not read", async () => {
  await withHub(async (h) => {
    h.fake.configure({
      archiveByHash: {
        [h.hash]: {
          files: [{
            source: "huggingface",
            model_id: null,
            url: `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
          }],
        },
      },
    });
    await assertRejects(
      () =>
        runModels({
          ...base,
          source: "archive",
          sha256checksum: h.hash,
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
      "--import-source huggingface",
    );
  });
});

Deno.test("a link and a source that disagree are refused, not reinterpreted", async () => {
  await withHub(async (h) => {
    const run = (url: string, source: "civitai" | "huggingface") =>
      runModels({
        ...base,
        source,
        url,
        config: h.config,
        paths: h.paths,
        client: h.client,
        log: () => {},
      });
    await assertRejects(
      () => run(`https://huggingface.co/${REPO}`, "civitai"),
      UsageError,
      "Hugging Face repo",
    );
    await assertRejects(
      () => run("https://civitai.com/models/4384", "huggingface"),
      UsageError,
      "Civitai model",
    );
    assertEquals(h.fake.requests, []);
  });
});

Deno.test("--download-model fetches from the Hub, and samples say there are none", async () => {
  await withHub(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      url: `https://huggingface.co/${REPO}/blob/main/${FILE}`,
      downloadModel: true,
      downloadSamples: 4,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    assertEquals(result.samples, 0);
    assert(lines.some((line) => line.includes("no sample images")));
    const batch = await readBatch(result.dir);
    assertEquals(batch.files![0]!.sha256, h.hash);
    assertEquals(
      await Deno.readFile(join(result.dir, batch.files![0]!.file)),
      h.bytes,
    );
    assertEquals(h.fake.matching(`/${REPO}/resolve/`).length, 2);
  });
});

Deno.test("each site gets its own token, and never the other's", async () => {
  await withHub(async (h) => {
    await runModels({
      ...base,
      url: `https://huggingface.co/${REPO}/blob/main/${FILE}`,
      downloadModel: true,
      config: h.config,
      paths: h.paths,
      client: h.client,
      env: { get: (key) => key === "HF_TOKEN" ? "hf_secret" : undefined },
      log: () => {},
    });
    assert(h.fake.requests.length > 0);
    for (const request of h.fake.requests) {
      // Every request here went to the Hub, which gets its token and only
      // its token.
      assertEquals(request.authorization, "Bearer hf_secret", request.path);
    }
  }, { hfToken: "hf_secret", civitaiToken: "civitai_secret" });
});

Deno.test("HF_TOKEN wins over the config's token", () => {
  const config = effectiveConfig({
    import: { huggingface_token: "from-file" },
  });
  assertEquals(
    huggingFaceToken(config, { get: () => "from-env" }),
    "from-env",
  );
  assertEquals(huggingFaceToken(config, { get: () => undefined }), "from-file");
  assertEquals(
    huggingFaceToken(effectiveConfig({}), { get: () => undefined }),
    null,
  );
});

Deno.test("a gated repo says where a Hugging Face token goes", async () => {
  await withHub(async (h) => {
    h.fake.configure({
      hubRepos: {
        [REPO]: { info: repoInfo(REPO, 1, [FILE]), files: {} },
      },
      hubStatus: { [REPO]: 401 },
    });
    const error = await assertRejects(
      () =>
        runModels({
          ...base,
          url: `https://huggingface.co/${REPO}`,
          config: h.config,
          paths: h.paths,
          client: h.client,
          log: () => {},
        }),
      LookupError,
      "HF_TOKEN",
    );
    assertStringIncludes(error.message, "import.huggingface_token");
  });
});

Deno.test("--filename with huggingface goes through the archive's index", async () => {
  await withHub(async (h) => {
    h.fake.configure({
      archiveSearch: {
        [FILE]: [
          // A Civitai file of the same name, which this source must ignore.
          {
            kind: "file",
            name: FILE,
            url: `/sha256/${"c".repeat(64)}`,
            platform: "civitai",
          },
          {
            kind: "file",
            name: FILE,
            url: `/sha256/${h.hash}`,
            platform: "huggingface",
          },
        ],
      },
      archiveByHash: {
        [h.hash]: {
          files: [{
            source: "huggingface",
            model_id: null,
            url: `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
          }],
        },
      },
      hubRepos: {
        [REPO]: {
          info: repoInfo(REPO, 1, [FILE]),
          files: { [FILE]: { sha256: h.hash, size: 1 } },
        },
      },
    });
    const result = await runModels({
      ...base,
      source: "huggingface",
      filename: FILE,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    });
    assertEquals((await readBatch(result.dir)).model.sha256, h.hash);
    // Civitai's own name search was not asked.
    assertEquals(h.fake.matching("/api/v1/models"), []);
  });
});

Deno.test("--search with huggingface lists repos and writes nothing", async () => {
  await withHub(async (h) => {
    const lines: string[] = [];
    const result = await runModels({
      ...base,
      source: "huggingface",
      search: "realism",
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: (line) => lines.push(line),
    });
    assertEquals(result.batch, null);
    assert(
      lines.some((line) => line.includes(`${h.fake.url}/${REPO}`)),
      lines.join("\n"),
    );
    assertEquals(h.fake.matching("/api/v1/models"), []);
  });
});

Deno.test("a Hugging Face link already fetched is not asked about again", async () => {
  await withHub(async (h) => {
    const run = (url: string) =>
      runModels({
        ...base,
        url,
        config: h.config,
        paths: h.paths,
        client: h.client,
        log: () => {},
      });
    await run(`https://huggingface.co/${REPO}/blob/main/${FILE}`);
    for (
      const url of [
        `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
        // The repo alone: it holds the one file already fetched.
        `https://huggingface.co/${REPO}`,
      ]
    ) {
      const before = h.fake.requests.length;
      const again = await run(url);
      assertEquals(h.fake.requests.length, before, url);
      assertEquals(again.existing?.hash, h.hash);
    }
  });
});

Deno.test("a hash nothing knows says why Hugging Face was not asked", async () => {
  await withHub(async (h) => {
    const unknown = "e".repeat(64);
    const error = await runModels({
      ...base,
      sha256checksum: unknown,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    }).catch((cause) => cause);
    assert(error instanceof LookupError);
    assertStringIncludes(error.message, "Hugging Face was not asked");
    assertStringIncludes(error.message, "cannot be searched by hash");
  });
});

Deno.test("an archive rate limit says Hugging Face could not be checked either", async () => {
  await withHub(async (h) => {
    h.fake.configure({
      failWith: { "/api/sha256/": { status: 429, body: "slow down" } },
    });
    const error = await runModels({
      ...base,
      sha256checksum: h.hash,
      config: h.config,
      paths: h.paths,
      client: h.client,
      log: () => {},
    }).catch((cause) => cause);
    assert(error instanceof LookupError);
    assertEquals(error.kind, "rate-limited");
    assertStringIncludes(error.message, "answered 429");
    assertStringIncludes(error.message, "had no match first");
    assertStringIncludes(
      error.message,
      "Hugging Face could not be checked either",
    );
  });
});
