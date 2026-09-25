import { assertEquals } from "@std/assert";
import {
  exifUserComment,
  type InfotextFields,
  parseA1111,
  parseCivitaiMeta,
  readInfotext,
} from "../../src/media/infotext.ts";
import { buildSidecar, serializeSidecarAscii } from "../../src/jobs/sidecar.ts";
import { withTextChunk } from "../../src/jobs/png.ts";
import { tinyPng } from "../fixtures/png.ts";

const blank = () => tinyPng({ width: 1, height: 1 });

/**
 * DESIGN-MODEL-IMPORT §6. The A1111 grammar is the fiddly one — its settings
 * line is only the last line, its values contain commas, and a prompt that
 * ends in a colon must not be eaten as settings.
 */

Deno.test("A1111: prompt, negative prompt and settings", () => {
  const text = [
    "a photograph of an astronaut riding a horse",
    "Negative prompt: blurry, watermark",
    "Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 2870305590, Size: 768x512, Model hash: 6ce0161689, Model: v1-5-pruned-emaonly",
  ].join("\n");
  const { format, fields } = parseA1111(text);
  assertEquals(format, "a1111-infotext");
  assertEquals(
    fields,
    {
      prompt: "a photograph of an astronaut riding a horse",
      negative_prompt: "blurry, watermark",
      steps: 30,
      cfg: 7,
      seed: 2870305590,
      sampler: "DPM++ 2M Karras",
      model: "v1-5-pruned-emaonly",
      model_hash: "6ce0161689",
      width: 768,
      height: 512,
    } satisfies InfotextFields,
  );
});

Deno.test("A1111: no negative prompt, and a multi-line prompt", () => {
  const text = "line one\nline two\nSteps: 20, Seed: 5";
  const { fields } = parseA1111(text);
  assertEquals(fields.prompt, "line one\nline two");
  assertEquals(fields.negative_prompt, undefined);
  assertEquals(fields.steps, 20);
});

Deno.test("A1111: a quoted value holding commas stays whole", () => {
  const text =
    'a cat\nSteps: 30, Hashes: {"model":"abc","lora:x":"def"}, Seed: 1, Sampler: Euler a';
  const { fields } = parseA1111(text);
  assertEquals(fields.seed, 1);
  assertEquals(fields.sampler, "Euler a");
  assertEquals(fields.steps, 30);
});

Deno.test("A1111: a prompt whose last line merely contains a colon", () => {
  // No settings line at all. Eating this as settings would lose the prompt,
  // which is the whole content of the file.
  const text = "a portrait\nlighting: dramatic and warm";
  const { fields } = parseA1111(text);
  assertEquals(fields.prompt, "a portrait\nlighting: dramatic and warm");
  assertEquals(fields.steps, undefined);
});

Deno.test("A1111: nothing parseable still yields the prompt", () => {
  const { fields } = parseA1111("just some words");
  assertEquals(fields.prompt, "just some words");
});

Deno.test("civitai meta: camelCase keys, hashes and lora resources", () => {
  const meta = {
    prompt: "a fox",
    negativePrompt: "blurry",
    steps: 28,
    cfgScale: 4.5,
    seed: 12345,
    sampler: "Euler",
    Size: "1024x1024",
    Model: "dreamshaper",
    hashes: { model: "abc123" },
    resources: [
      { type: "lora", name: "detail", weight: 0.8 },
      { type: "checkpoint", name: "dreamshaper" },
      { type: "lora", name: "style" },
    ],
  };
  const { format, fields } = parseCivitaiMeta(meta);
  assertEquals(format, "civitai-meta");
  assertEquals(fields.prompt, "a fox");
  assertEquals(fields.negative_prompt, "blurry");
  assertEquals(fields.cfg, 4.5);
  assertEquals(fields.width, 1024);
  assertEquals(fields.height, 1024);
  assertEquals(fields.model_hash, "abc123");
  assertEquals(fields.loras, [
    { name: "detail", weight: 0.8 },
    { name: "style" },
  ]);
});

Deno.test("civitai meta: an empty object is not an error", () => {
  const { format, fields } = parseCivitaiMeta({});
  assertEquals(format, "civitai-meta");
  assertEquals(fields, {});
});

Deno.test("readInfotext: a PNG carrying A1111 text under `parameters`", () => {
  const png = withTextChunk(
    blank(),
    "parameters",
    "a cat\nNegative prompt: dog\nSteps: 12, Seed: 7",
  );
  const { format, fields } = readInfotext(png);
  assertEquals(format, "a1111-infotext");
  assertEquals(fields.prompt, "a cat");
  assertEquals(fields.negative_prompt, "dog");
  assertEquals(fields.steps, 12);
});

Deno.test("readInfotext: SwarmUI's JSON under the same keyword", () => {
  const png = withTextChunk(
    blank(),
    "parameters",
    JSON.stringify({
      sui_image_params: {
        prompt: "a swarm cat",
        negativeprompt: "blurry",
        steps: 20,
        cfgscale: 7,
        seed: 99,
        model: "flux-dev",
        width: 1024,
        height: 768,
      },
    }),
  );
  const { format, fields } = readInfotext(png);
  assertEquals(format, "a1111-infotext");
  assertEquals(fields.prompt, "a swarm cat");
  assertEquals(fields.cfg, 7);
  assertEquals(fields.width, 1024);
  assertEquals(fields.model, "flux-dev");
});

Deno.test("readInfotext: ComfyUI keeps the graph and guesses no fields", () => {
  const png = withTextChunk(
    blank(),
    "prompt",
    JSON.stringify({ "3": { class_type: "KSampler", inputs: { seed: 1 } } }),
  );
  const { format, fields, source } = readInfotext(png);
  assertEquals(format, "comfyui-workflow");
  assertEquals(fields, {});
  const graph = source as { prompt: Record<string, unknown> };
  assertEquals(Object.keys(graph.prompt), ["3"]);
});

Deno.test("readInfotext: our own sidecar wins over everything else", () => {
  const sidecar = buildSidecar({
    job_id: "01JOB",
    created_at: new Date(0),
    workflow: {
      id: "sd15",
      name: "SD 1.5",
      hash: "h",
      family: "sd15",
      kind: "image",
    },
    params: { prompt: "ours", seed: 42, steps: 8 },
    models: [{ role: "checkpoint", name: "sd15.safetensors", hash: "abc" }],
    api_graph: null,
    outputs: [{ file: "a.png", kind: "image" }],
  });
  const png = withTextChunk(
    withTextChunk(blank(), "parameters", "theirs\nSteps: 99"),
    "forgeui",
    serializeSidecarAscii(sidecar),
  );
  const { format, fields } = readInfotext(png);
  assertEquals(format, "forgeui-sidecar");
  assertEquals(fields.prompt, "ours");
  assertEquals(fields.seed, 42);
  assertEquals(fields.model, "sd15.safetensors");
  assertEquals(fields.model_hash, "abc");
});

Deno.test("readInfotext: a PNG with nothing in it", () => {
  assertEquals(readInfotext(blank()).format, "unknown");
});

Deno.test("readInfotext: bytes that are not an image at all", () => {
  assertEquals(
    readInfotext(new TextEncoder().encode("hello")).format,
    "unknown",
  );
});

Deno.test("exifUserComment: UTF-16 behind the UNICODE prefix", () => {
  const text = "a jpeg cat\nSteps: 4, Seed: 3";
  const jpeg = jpegWithUserComment(text);
  assertEquals(exifUserComment(jpeg), text);
  const { format, fields } = readInfotext(jpeg);
  assertEquals(format, "a1111-infotext");
  assertEquals(fields.prompt, "a jpeg cat");
  assertEquals(fields.seed, 3);
});

Deno.test("exifUserComment: absent where there is no EXIF", () => {
  assertEquals(exifUserComment(blank()), null);
});

/**
 * A minimal big-endian JPEG: SOI, an APP1 holding a TIFF header with one IFD
 * entry for UserComment, then EOI. Enough to exercise the walk; not a file any
 * decoder would render.
 */
function jpegWithUserComment(text: string): Uint8Array {
  const prefix = new TextEncoder().encode("UNICODE\0");
  const body = new Uint8Array(text.length * 2);
  const bodyView = new DataView(body.buffer);
  for (let i = 0; i < text.length; i++) {
    bodyView.setUint16(i * 2, text.charCodeAt(i), false); // UTF-16BE
  }
  const comment = new Uint8Array(prefix.length + body.length);
  comment.set(prefix, 0);
  comment.set(body, prefix.length);

  // TIFF: header (8) + IFD count (2) + one entry (12) + next-IFD (4).
  const ifdAt = 8;
  const dataAt = ifdAt + 2 + 12 + 4;
  const tiff = new Uint8Array(dataAt + comment.length);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x4d;
  tiff[1] = 0x4d; // big endian
  view.setUint16(2, 0x2a, false);
  view.setUint32(4, ifdAt, false);
  view.setUint16(ifdAt, 1, false); // one entry
  view.setUint16(ifdAt + 2, 0x9286, false); // UserComment
  view.setUint16(ifdAt + 4, 7, false); // UNDEFINED
  view.setUint32(ifdAt + 6, comment.length, false);
  view.setUint32(ifdAt + 10, dataAt, false);
  view.setUint32(ifdAt + 14, 0, false); // no next IFD
  tiff.set(comment, dataAt);

  const header = new TextEncoder().encode("Exif\0\0");
  // SOI + APP1 marker + the segment (which counts its own length word) + EOI.
  const app1 = new Uint8Array(2 + 2 + (2 + header.length + tiff.length) + 2);
  const appView = new DataView(app1.buffer);
  app1[0] = 0xff;
  app1[1] = 0xd8; // SOI
  app1[2] = 0xff;
  app1[3] = 0xe1; // APP1
  const segment = new Uint8Array(2 + header.length + tiff.length);
  new DataView(segment.buffer).setUint16(0, segment.length, false);
  segment.set(header, 2);
  segment.set(tiff, 2 + header.length);
  app1.set(segment, 4);
  appView.setUint16(app1.length - 2, 0xffd9, false); // EOI
  return app1;
}
