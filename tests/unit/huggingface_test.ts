import { assertEquals, assertThrows } from "@std/assert";
import {
  familyFromHuggingFace,
  HuggingFaceUrlError,
  kindFromHuggingFace,
  parseHuggingFaceUrl,
  readmeMarkdown,
  sourceRecordFromHuggingFace,
} from "../../src/models/huggingface.ts";
import { markdownWithoutHtml } from "../../src/models/html.ts";

/** DESIGN-MODEL-IMPORT §4.5: what Hugging Face's answers mean. */

Deno.test("hf urls: a repo, a file in it, and the forms around them", () => {
  assertEquals(
    parseHuggingFaceUrl("https://huggingface.co/stabilityai/sdxl-turbo"),
    { repo: "stabilityai/sdxl-turbo", revision: null, path: null },
  );
  assertEquals(
    parseHuggingFaceUrl(
      "https://huggingface.co/stabilityai/sdxl-turbo/blob/main/sd_xl_turbo_1.0_fp16.safetensors",
    ),
    {
      repo: "stabilityai/sdxl-turbo",
      revision: "main",
      path: "sd_xl_turbo_1.0_fp16.safetensors",
    },
  );
  // What the archive hands back, and what a download button copies.
  assertEquals(
    parseHuggingFaceUrl(
      "https://huggingface.co/fofr/comfyui/resolve/main/checkpoints/x.safetensors?download=true",
    ),
    {
      repo: "fofr/comfyui",
      revision: "main",
      path: "checkpoints/x.safetensors",
    },
  );
  assertEquals(
    parseHuggingFaceUrl("https://hf.co/a/b/tree/v2"),
    { repo: "a/b", revision: "v2", path: null },
  );
  // Not Hugging Face at all: the caller tries Civitai's forms.
  assertEquals(parseHuggingFaceUrl("https://civitai.com/models/4384"), null);
  assertEquals(parseHuggingFaceUrl("not a url"), null);
});

Deno.test("hf urls: Hugging Face, but not a model", () => {
  for (
    const url of [
      "https://huggingface.co/datasets/a/b",
      "https://huggingface.co/spaces/a/b",
      "https://huggingface.co/models",
      "https://huggingface.co/stabilityai",
      "https://huggingface.co/a/b/blob/main",
    ]
  ) {
    assertThrows(() => parseHuggingFaceUrl(url), HuggingFaceUrlError);
  }
});

Deno.test("hf kind: from tags and the path, `other` otherwise", () => {
  assertEquals(
    kindFromHuggingFace("lora.safetensors", ["lora"], null),
    "loras",
  );
  assertEquals(
    kindFromHuggingFace("flux-realism-lora.safetensors", [], "text-to-image"),
    "loras",
  );
  assertEquals(
    kindFromHuggingFace("vae/diffusion_pytorch_model.safetensors", [], null),
    "vae",
  );
  assertEquals(kindFromHuggingFace("ae.safetensors", [], null), "other");
  assertEquals(kindFromHuggingFace("sdxl_vae.safetensors", [], null), "vae");
  assertEquals(
    kindFromHuggingFace("text_encoder_2/model.safetensors", [], null),
    "text_encoders",
  );
  assertEquals(
    kindFromHuggingFace("RealESRGAN_x4.pth", [], null),
    "upscale_models",
  );
  assertEquals(
    kindFromHuggingFace(
      "sd_xl_turbo_1.0_fp16.safetensors",
      [],
      "text-to-image",
    ),
    "checkpoints",
  );
  assertEquals(
    kindFromHuggingFace("model.gguf", [], "text-generation"),
    "other",
  );
});

Deno.test("hf family: the declared base first, the repo when there is none", () => {
  assertEquals(
    familyFromHuggingFace("XLabs-AI/flux-RealismLora", [
      "black-forest-labs/FLUX.1-dev",
    ]),
    "flux",
  );
  assertEquals(familyFromHuggingFace("stabilityai/sdxl-turbo", []), "sdxl");
  assertEquals(
    familyFromHuggingFace("x/y", [
      "stable-diffusion-v1-5/stable-diffusion-v1-5",
    ]),
    "sd15",
  );
  // A declared base the table does not know is not overruled by the name.
  assertEquals(
    familyFromHuggingFace("x/sdxl-thing", ["someone/unknown"]),
    null,
  );
  assertEquals(familyFromHuggingFace("x/y", []), null);
});

Deno.test("readme: HTML becomes Markdown, code does not", () => {
  const out = markdownWithoutHtml(
    [
      '<h1 align="center">SDXL <b>Turbo</b></h1>',
      '<p align="center"><img src="https://x.example/a.png" alt="badge"></p>',
      "<script>alert(1)</script>",
      'Line one<br>line two, see <a href="https://x.example">the paper</a>.',
      "",
      "```html",
      "<think>kept</think>",
      "```",
      "",
      "Inline `<tag>` stays, and <https://auto.example> is a link.",
    ].join("\n"),
  );
  assertEquals(
    out,
    [
      "# SDXL **Turbo**",
      "",
      "![badge](https://x.example/a.png)",
      "",
      "Line one",
      "line two, see [the paper](https://x.example).",
      "",
      "```html",
      "<think>kept</think>",
      "```",
      "",
      "Inline `<tag>` stays, and <https://auto.example> is a link.",
    ].join("\n"),
  );
});

Deno.test("readme: front matter goes, relative links point into the repo", () => {
  const out = readmeMarkdown({
    readme: [
      "---",
      "license: other",
      "tags: [lora]",
      "---",
      "# Card",
      "",
      "![sample](./images/a%20b.png) and [the license](LICENSE.md),",
      '<img src="grid.jpg">, [a section](#usage), ',
      "[escape](../../etc/passwd) and [absolute](https://x.example).",
    ].join("\n"),
    repo: "o/r",
    revision: "main",
    baseUrl: "https://huggingface.co",
  });
  assertEquals(
    out,
    [
      "# Card",
      "",
      "![sample](https://huggingface.co/o/r/resolve/main/images/a%20b.png) and " +
      "[the license](https://huggingface.co/o/r/blob/main/LICENSE.md),",
      "![image](https://huggingface.co/o/r/resolve/main/grid.jpg), [a section](#usage), ",
      "[escape](../../etc/passwd) and [absolute](https://x.example).",
    ].join("\n"),
  );
});

Deno.test("source record: a Hugging Face file, in §5.5's shape", () => {
  const hash =
    "e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26";
  const found = sourceRecordFromHuggingFace({
    info: {
      name: "XLabs-AI/flux-RealismLora",
      author: "XLabs-AI",
      task: "text-to-image",
      tags: [
        "lora",
        "Flux",
        "base_model:black-forest-labs/FLUX.1-dev",
        "license:other",
        "LoRA",
      ],
      cardData: {
        license: "other",
        license_name: "flux-1-dev-non-commercial-license",
        base_model: "black-forest-labs/FLUX.1-dev",
        instance_prompt: "realism, photo",
      },
      downloads: 10,
      likes: 3,
      updatedAt: "2024-08-06T00:00:00.000Z",
      sha: "abc123",
    },
    readme: "---\nlicense: other\n---\n# Realism LoRA\n\nUse it.",
    file: { path: "lora.safetensors", sha256: hash, size: 22 },
    revision: "main",
    baseUrl: "https://huggingface.co",
    fetchedAt: new Date("2026-09-29T10:00:00Z"),
  });

  assertEquals(found.sha256, hash);
  assertEquals(found.filename, "lora.safetensors");
  assertEquals(found.kind, "loras");
  assertEquals(found.family, "flux");
  assertEquals(found.display_name, "flux-RealismLora");
  assertEquals(found.trigger_words, ["realism", "photo"]);
  assertEquals(found.images, []);
  assertEquals(found.files, [{
    name: "lora.safetensors",
    sha256: hash,
    size: 22,
    download_url:
      "https://huggingface.co/XLabs-AI/flux-RealismLora/resolve/main/lora.safetensors",
    primary: true,
  }]);

  const { record } = found;
  assertEquals(record.source, {
    kind: "huggingface",
    label: "Hugging Face",
    url: "https://huggingface.co/XLabs-AI/flux-RealismLora",
    model_id: null,
    model_version_id: null,
    fetched_at: "2026-09-29T10:00:00Z",
    repo: "XLabs-AI/flux-RealismLora",
    revision: "abc123",
    path: "lora.safetensors",
  });
  assertEquals(record.creator, {
    username: "XLabs-AI",
    url: "https://huggingface.co/XLabs-AI",
  });
  // Index keys go, and so does the same tag twice in different case.
  assertEquals(record.model.tags, ["lora", "Flux"]);
  assertEquals(record.model.description_text, "# Realism LoRA\n\nUse it.");
  assertEquals(record.model.description_html, null);
  assertEquals(record.version.base_model, "black-forest-labs/FLUX.1-dev");
  assertEquals(record.license, {
    license: "other",
    license_name: "flux-1-dev-non-commercial-license",
  });
  assertEquals(record.stats, { downloads: 10, likes: 3 });
});
