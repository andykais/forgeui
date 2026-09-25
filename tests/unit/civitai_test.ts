import { assertEquals, assertThrows } from "@std/assert";
import {
  CivitaiUrlError,
  familyOf,
  kindOf,
  normalizeTriggerWords,
  originalImageUrl,
  parseModelUrl,
  sourceRecordFromArchive,
  sourceRecordFromCivitai,
  visibilityParams,
} from "../../src/models/civitai.ts";
import { htmlToText, sanitizeHtml } from "../../src/models/html.ts";

/** DESIGN-MODEL-IMPORT §4.1: every URL form, and a few that are not. */

Deno.test("urls: the forms §4.1 lists", () => {
  assertEquals(
    parseModelUrl("https://civitai.red/models/4384?modelVersionId=128713"),
    {
      site: "civitai",
      model_id: 4384,
      model_version_id: 128713,
      image_id: null,
      sha256: null,
    },
  );
  assertEquals(parseModelUrl("https://civitai.com/models/4384").model_id, 4384);
  assertEquals(
    parseModelUrl("https://civitai.com/models/4384").site,
    "civitai",
  );
  assertEquals(
    parseModelUrl("https://civitai.red/images/26534668").image_id,
    26534668,
  );
  assertEquals(
    parseModelUrl(
      "https://civitaiarchive.com/models/62437?modelVersionId=66991",
    ),
    {
      site: "archive",
      model_id: 62437,
      model_version_id: 66991,
      image_id: null,
      sha256: null,
    },
  );
  assertEquals(
    parseModelUrl(
      "https://civitaiarchive.com/sha256/6CE0161689B3853ACAA03779EC93EAFE75A02F4CED659BEE03F50797806FA2FA",
    ).sha256,
    "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
  );
  assertEquals(
    parseModelUrl("https://civitai.com/api/download/models/66991")
      .model_version_id,
    66991,
  );
});

Deno.test("urls: a `.com` link is honoured, and reads as civitai", () => {
  // .com and .red are the same database; the site only picks who is asked
  // first (§4.0).
  assertEquals(
    parseModelUrl("https://www.civitai.com/models/1").site,
    "civitai",
  );
});

Deno.test("urls: what is refused", () => {
  for (
    const bad of [
      "not a url",
      "https://example.com/models/4384",
      "https://civitai.red/user/Lykon",
      "https://civitai.red/models/not-a-number",
    ]
  ) {
    assertThrows(() => parseModelUrl(bad), CivitaiUrlError);
  }
});

Deno.test("family: baseModel onto §8.1's list, and no guess otherwise", () => {
  assertEquals(familyOf("SD 1.5"), "sd15");
  assertEquals(familyOf("SDXL 1.0"), "sdxl");
  assertEquals(familyOf("Pony"), "sdxl");
  assertEquals(familyOf("Illustrious"), "sdxl");
  assertEquals(familyOf("NoobAI"), "sdxl");
  assertEquals(familyOf("Flux.1 D"), "flux");
  assertEquals(familyOf("Flux.2"), "flux2");
  assertEquals(familyOf("Wan Video 14B t2v"), "wan2");
  assertEquals(familyOf("Qwen"), "qwen-image");
  assertEquals(familyOf("LTXV 2"), "ltx-2");
  // Unmapped leaves the family alone rather than inventing one.
  assertEquals(familyOf("Some New Thing"), null);
  assertEquals(familyOf(null), null);
  assertEquals(familyOf(""), null);
});

Deno.test("kind: civitai type onto a folder, unmapped to `other`", () => {
  assertEquals(kindOf("Checkpoint"), "checkpoints");
  assertEquals(kindOf("LORA"), "loras");
  assertEquals(kindOf("LoCon"), "loras");
  assertEquals(kindOf("TextualInversion"), "embeddings");
  assertEquals(kindOf("VAE"), "vae");
  assertEquals(kindOf("Controlnet"), "controlnet");
  assertEquals(kindOf("Upscaler"), "upscale_models");
  assertEquals(kindOf("Workflows"), "other");
  assertEquals(kindOf(null), "other");
});

Deno.test("trigger words: the three shapes seen in the wild", () => {
  assertEquals(
    normalizeTriggerWords(["shuimobysim", "wuchangshuo", "bonian"]),
    ["shuimobysim", "wuchangshuo", "bonian"],
  );
  // One string holding a comma-separated list, with a trailing comma.
  assertEquals(
    normalizeTriggerWords([
      "abstractionism, brush stroke, traditional media, ",
    ]),
    ["abstractionism", "brush stroke", "traditional media"],
  );
  assertEquals(normalizeTriggerWords([]), []);
  assertEquals(normalizeTriggerWords(null), []);
  assertEquals(normalizeTriggerWords(undefined), []);
  // Duplicates differing only in case collapse.
  assertEquals(normalizeTriggerWords(["Cat", "cat", " CAT "]), ["Cat"]);
});

Deno.test("visibility: the parameter differs per endpoint (§4.0)", () => {
  // /models rejects browsingLevel with a ZodError; nsfw is what widens it.
  assertEquals(visibilityParams("models", 31), { nsfw: "true" });
  assertEquals(visibilityParams("models", 1), {});
  assertEquals(visibilityParams("images", 31), { browsingLevel: "31" });
  assertEquals(visibilityParams("by-hash", 31), {});
});

Deno.test("cdn: the card transform becomes the original", () => {
  assertEquals(
    originalImageUrl(
      "https://image.civitai.com/abc/def/anim=false,width=450,optimized=true/26534668.jpeg",
    ),
    "https://image.civitai.com/abc/def/original=true/26534668.jpeg",
  );
  // A URL with no transform segment is left alone.
  assertEquals(
    originalImageUrl("https://image.civitai.com/abc/def/26534668.jpeg"),
    "https://image.civitai.com/abc/def/26534668.jpeg",
  );
});

Deno.test("source record: a civitai model and version", () => {
  const result = sourceRecordFromCivitai({
    model: {
      id: 4384,
      name: "DreamShaper",
      type: "Checkpoint",
      description: "<h1>DreamShaper</h1><p>Hello <strong>there</strong></p>",
      creator: { username: "Lykon" },
      tags: ["photorealistic", "base model"],
      allowCommercialUse: ["Image"],
      allowNoCredit: true,
      stats: { downloadCount: 1207233 },
      modelVersions: [],
    },
    version: {
      id: 128713,
      name: "8",
      baseModel: "SD 1.5",
      publishedAt: "2023-10-30T00:00:00.000Z",
      trainedWords: ["dreamy, soft light, "],
      description: "<ul><li>Better at LoRA</li></ul>",
      files: [{
        name: "dreamshaper_8.safetensors",
        sizeKB: 2082590.0,
        primary: true,
        downloadUrl: "https://civitai.com/api/download/models/128713",
        hashes: { SHA256: "ABC123" },
      }],
      images: [{
        id: 5629399,
        url: "https://image.civitai.com/x/y/width=450/5629399.jpeg",
        width: 768,
        height: 512,
        type: "image",
        nsfwLevel: 1,
        meta: { prompt: "a fox", seed: 3 },
      }],
    },
    baseUrl: "https://civitai.red",
    fetchedAt: new Date("2026-09-23T09:12:44.500Z"),
  });

  assertEquals(result.sha256, "abc123");
  assertEquals(result.filename, "dreamshaper_8.safetensors");
  assertEquals(result.kind, "checkpoints");
  assertEquals(result.family, "sd15");
  assertEquals(result.display_name, "DreamShaper");
  assertEquals(result.trigger_words, ["dreamy", "soft light"]);
  assertEquals(result.files[0]?.size, 2132572160);
  assertEquals(
    result.images[0]?.page_url,
    "https://civitai.red/images/5629399",
  );

  const { record } = result;
  assertEquals(record.format, 1);
  assertEquals(record.source.kind, "civitai");
  assertEquals(
    record.source.url,
    "https://civitai.red/models/4384?modelVersionId=128713",
  );
  assertEquals(record.source.fetched_at, "2026-09-23T09:12:44Z");
  assertEquals(record.creator, {
    username: "Lykon",
    url: "https://civitai.red/user/Lykon",
  });
  assertEquals(
    record.model.description_text,
    "# DreamShaper\n\nHello **there**",
  );
  assertEquals(record.version.description_text, "- Better at LoRA");
  assertEquals(record.version.base_model, "SD 1.5");
  assertEquals(record.license, {
    allowCommercialUse: ["Image"],
    allowNoCredit: true,
  });
});

Deno.test("source record: the archive's shape, and its missing meta", () => {
  const result = sourceRecordFromArchive({
    model: {
      id: 62437,
      name: "v1-5-pruned-emaonly",
      type: "Checkpoint",
      description: "<p>Stable Diffusion</p>",
      creator_username: "faye",
      creator_url: "/users/faye",
      tags: ["base model"],
      version: {
        id: 66991,
        name: "v1.5",
        baseModel: "SD 1.5",
        trigger: [],
        files: [{
          name: "v15PrunedEmaonly.safetensors",
          sha256:
            "6CE0161689B3853ACAA03779EC93EAFE75A02F4CED659BEE03F50797806FA2FA",
          sizeKB: 4165181.9375,
          is_primary: true,
        }],
        images: [{
          id: 26534668,
          image_url: "https://image.civitai.com/a/b/width=450/26534668.jpeg",
          width: 768,
          height: 768,
          type: "image",
          link: "https://genur.art/posts/26534668",
        }],
      },
    },
    baseUrl: "https://civitaiarchive.com",
    fetchedAt: new Date("2026-09-23T09:12:44Z"),
  });

  assertEquals(result.record.source.kind, "civitai-archive");
  assertEquals(result.record.source.label, "CivArchive");
  assertEquals(
    result.sha256,
    "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
  );
  assertEquals(result.family, "sd15");
  // The archive has no image endpoint, so a sample from it has no meta.
  assertEquals(result.images[0]?.meta, null);
  assertEquals(result.images[0]?.page_url, "https://genur.art/posts/26534668");
});

// ------------------------------------------------------------------- html

Deno.test("sanitize: the measured tag set survives, attributes do not", () => {
  const html =
    '<h1 id="heading-133">Title</h1><p><strong>bold</strong> and <em>it</em></p><ul><li>one</li></ul>';
  assertEquals(
    sanitizeHtml(html),
    "<h1>Title</h1><p><strong>bold</strong> and <em>it</em></p><ul><li>one</li></ul>",
  );
});

Deno.test("sanitize: scripts go with their content, unknown tags unwrap", () => {
  assertEquals(
    sanitizeHtml("<script>alert(1)</script><p>safe</p>"),
    "<p>safe</p>",
  );
  assertEquals(sanitizeHtml("<iframe src='x'>fallback</iframe>ok"), "ok");
  // A tag that is merely not allowed keeps its text.
  assertEquals(sanitizeHtml("<span>kept</span>"), "kept");
});

Deno.test("sanitize: links are forced open-in-new-tab, and only http(s)", () => {
  assertEquals(
    sanitizeHtml('<a href="https://x.test/a" onclick="evil()">go</a>'),
    '<a href="https://x.test/a" target="_blank" rel="noopener noreferrer nofollow">go</a>',
  );
  // javascript: is not a link; the text survives, the anchor does not.
  assertEquals(sanitizeHtml('<a href="javascript:evil()">go</a>'), "go");
});

Deno.test("sanitize: images become links, never requests", () => {
  // Rendering these would make a model page call image.civitai.com on open.
  assertEquals(
    sanitizeHtml('<img src="https://image.civitai.com/a.png" alt="a fox" />'),
    '<a href="https://image.civitai.com/a.png" target="_blank" rel="noopener noreferrer nofollow">a fox</a>',
  );
  assertEquals(sanitizeHtml('<img src="javascript:x" />'), "");
});

Deno.test("sanitize: text is escaped, entities decoded first", () => {
  assertEquals(
    sanitizeHtml("<p>a &lt; b &amp;&amp; c</p>"),
    "<p>a &lt; b &amp;&amp; c</p>",
  );
  assertEquals(sanitizeHtml("5 < 6"), "5 &lt; 6");
});

Deno.test("sanitize: an unclosed tag is closed for us", () => {
  assertEquals(sanitizeHtml("<p>open"), "<p>open</p>");
  assertEquals(sanitizeHtml("</p>stray"), "stray");
});

Deno.test("text: headings, lists, links and code", () => {
  const html = [
    "<h1>Title</h1>",
    "<p>Some <strong>bold</strong> text with a ",
    '<a href="https://x.test">link</a>.</p>',
    "<ul><li>one</li><li>two</li></ul>",
    "<ol><li>first</li><li>second</li></ol>",
    "<pre>code here</pre>",
  ].join("");
  assertEquals(
    htmlToText(html),
    [
      "# Title",
      "",
      "Some **bold** text with a [link](https://x.test).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "```",
      "code here",
      "```",
    ].join("\n"),
  );
});

Deno.test("text: images vanish and br breaks the line", () => {
  assertEquals(
    htmlToText('a<br /><img src="https://x.test/a.png" />b'),
    "a\nb",
  );
});

Deno.test("text: input that is not HTML at all comes back as itself", () => {
  assertEquals(htmlToText("just words"), "just words");
  // A `<` that cannot begin a tag is text, which is the common malformed case.
  assertEquals(htmlToText("5 < 6 and 7 > 6"), "5 < 6 and 7 > 6");
  assertEquals(htmlToText("trailing <"), "trailing <");
});

Deno.test("text: `<b and c >` is read as a tag, as a browser would", () => {
  // Not a quirk worth fixing: under-recognising tags is the dangerous
  // direction for the sanitiser that shares this tokeniser, and a browser
  // parses this the same way. Real editor output escapes `<` as `&lt;`.
  assertEquals(htmlToText("a < b and c > d"), "a ** d");
});

Deno.test("text: entities and collapsed whitespace", () => {
  assertEquals(htmlToText("<p>a &amp; b &hellip;  c</p>"), "a & b … c");
});
