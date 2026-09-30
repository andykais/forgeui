import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  archivePagePath,
  pageModel,
  parseTensorArtUrl,
  publicCopy,
  sourceRecordFromTensorArt,
  TensorArtUrlError,
} from "../../src/models/tensorart.ts";

/**
 * DESIGN-MODEL-IMPORT §4.6: what CivArchive's mirror of Tensor.Art says.
 * The fixture is a real page's `__NEXT_DATA__` model, trimmed.
 */

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/tensorart_model.json", import.meta.url),
  ),
) as Record<string, unknown>;

function page(model: unknown): string {
  return `<!DOCTYPE html><html><body><div id="__next"></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${
      JSON.stringify({ props: { pageProps: { model } }, buildId: "x" })
    }</script></body></html>`;
}

Deno.test("tensorart urls: the site's forms and the archive's", () => {
  assertEquals(
    parseTensorArtUrl("https://tensor.art/models/765307161749456877"),
    { model_id: "765307161749456877", version_id: null },
  );
  assertEquals(
    parseTensorArtUrl(
      "https://tensor.art/models/757279507095956705/758377756002093254",
    ),
    { model_id: "757279507095956705", version_id: "758377756002093254" },
  );
  // A slug after the id is not a version.
  assertEquals(
    parseTensorArtUrl("https://tensor.art/models/757279507095956705/FLUX-dev"),
    { model_id: "757279507095956705", version_id: null },
  );
  assertEquals(
    parseTensorArtUrl(
      "https://civitaiarchive.com/tensorart/models/1234567/versions/7654321",
    ),
    { model_id: "1234567", version_id: "7654321" },
  );
  // Somebody else's link: the caller tries the other forms.
  assertEquals(parseTensorArtUrl("https://civitai.com/models/4384"), null);
  assertEquals(
    parseTensorArtUrl("https://civitaiarchive.com/models/4384"),
    null,
  );
  assertThrows(
    () => parseTensorArtUrl("https://tensor.art/u/694618803287382241"),
    TensorArtUrlError,
  );
  assertEquals(
    archivePagePath({ model_id: "1", version_id: null }),
    "/tensorart/models/1",
  );
});

Deno.test("tensorart ids survive as strings, never through a number", () => {
  // 18 digits: as a number this is 765307161749456900.
  const model = pageModel(page(fixture))!;
  assertEquals(model.id, "765307161749456877");
  const found = sourceRecordFromTensorArt({
    model,
    fetchedAt: new Date("2026-09-30T10:00:00Z"),
  });
  assertEquals(found.record.source.tensorart_model_id, "765307161749456877");
  assertEquals(found.record.source.tensorart_version_id, "765307161749456877");
});

Deno.test("tensorart page: not the archive's Tensor.Art model, no answer", () => {
  assertEquals(pageModel("<html>Error 404</html>"), null);
  assertEquals(pageModel(page({ ...fixture, platform: "civitai" })), null);
});

Deno.test("tensorart record: a real page, in §5.5's shape", () => {
  const found = sourceRecordFromTensorArt({
    model: fixture,
    fetchedAt: new Date("2026-09-30T10:00:00Z"),
  });
  assertEquals(
    found.sha256,
    "4610115bb0c89560703c892c59ac2742fa821e60ef5871b33493ba544683abd7",
  );
  assertEquals(found.filename, "flux_dev.safetensors");
  assertEquals(found.kind, "checkpoints");
  assertEquals(found.family, "flux");
  assertEquals(found.display_name, "FLUX");
  assertEquals(found.tags, ["flux"]);

  const { record } = found;
  assertEquals(record.source.kind, "tensorart");
  assertEquals(record.source.label, "Tensor.Art");
  assertEquals(
    record.source.url,
    "https://tensor.art/models/765307161749456877",
  );
  assertEquals(record.creator, {
    username: "miaomiao",
    url: "https://tensor.art/u/694618803287382241",
  });
  assertEquals(record.version.name, "Dev fp32");
  assertEquals(record.version.base_model, "FLUX.1");
  assert(record.model.description_text?.startsWith("FLUX.1 [dev]"));

  // Samples are the showcase images, linked back to the model's page.
  assertEquals(found.images.length, 2);
  assert(found.images[0]!.url.startsWith("https://image.tensorartassets.com/"));
  assertEquals(found.images[0]!.page_url, record.source.url);

  // The download is a public copy of the same bytes, not Tensor.Art's own:
  // the deleted Civitai copy is passed over for the live one.
  assertEquals(
    found.files[0]!.download_url,
    "https://civitai.com/api/download/models/691639?type=Model&format=SafeTensor&size=full&fp=fp32",
  );
  assertEquals(found.files[0]!.download_via, "civitai");
});

Deno.test("tensorart record: a hash picks its file among several", () => {
  const version = fixture.version as Record<string, unknown>;
  const other = "a".repeat(64);
  const found = sourceRecordFromTensorArt({
    model: {
      ...fixture,
      version: {
        ...version,
        files: [
          ...(version.files as unknown[]),
          {
            name: "other.safetensors",
            sha256: other.toUpperCase(),
            size_kb: 4,
          },
        ],
      },
    },
    hash: other,
    fetchedAt: new Date(),
  });
  assertEquals(found.sha256, other);
  assertEquals(found.filename, "other.safetensors");
  assertEquals(found.files.filter((file) => file.primary).length, 1);
});

Deno.test("tensorart copies: public, live, and absolute links only", () => {
  const copy = (mirrors: unknown[]) => publicCopy({ mirrors });
  assertEquals(copy([]), null);
  assertEquals(
    copy([
      {
        source: "civitai",
        url: "https://civitai.com/api/download/models/1",
        is_gated: true,
      },
      {
        source: "civitai",
        url: "https://civitai.com/api/download/models/2",
        is_paid: true,
      },
      {
        source: "huggingface",
        url: "https://huggingface.co/a/b/resolve/main/m.safetensors",
      },
    ]),
    {
      url: "https://huggingface.co/a/b/resolve/main/m.safetensors",
      via: "huggingface",
    },
  );
  // A mirror that is not a file link is not a download.
  assertEquals(
    copy([{ source: "huggingface", url: "https://huggingface.co/a/b" }]),
    null,
  );
  assertEquals(
    copy([{ source: "tensorart", url: "/tensorart/models/1/versions/1" }]),
    null,
  );
});
