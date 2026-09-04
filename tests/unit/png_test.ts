import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  PngError,
  readChunks,
  readPngSize,
  readTextChunks,
  SIDECAR_KEYWORD,
  withTextChunk,
} from "../../src/jobs/png.ts";
import { tinyPng } from "../fixtures/png.ts";
import { fixtureSidecar } from "../fixtures/sidecar.ts";
import { parseSidecar, serializeSidecarAscii } from "../../src/jobs/sidecar.ts";

Deno.test("fixture PNGs carry the dimensions they claim", () => {
  for (const [width, height] of [[1, 1], [64, 64], [1216, 704]]) {
    const png = tinyPng({ width: width!, height: height! });
    assertEquals(readPngSize(png), { width, height });
  }
});

Deno.test("fixture PNGs are deterministic", () => {
  assertEquals(
    tinyPng({ width: 32, height: 8 }),
    tinyPng({ width: 32, height: 8 }),
  );
});

Deno.test("fixture PNGs are minimal and well-formed", () => {
  const chunks = readChunks(tinyPng({ width: 4, height: 4 }));
  assertEquals(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
});

Deno.test("garbage is rejected instead of misread", () => {
  assertThrows(() => readPngSize(new Uint8Array(8)), PngError, "not a PNG");
  assertThrows(
    () => readTextChunks(new TextEncoder().encode("not a png at all")),
    PngError,
  );
});

Deno.test("a tEXt chunk round-trips its bytes untouched", () => {
  const png = tinyPng({ width: 8, height: 8 });
  const text = 'quotes " backslash \\ literal \\n braces {} caf\xe9';
  const stamped = withTextChunk(png, "comment", text);
  assertEquals(readTextChunks(stamped).comment, text);
  assertEquals(readPngSize(stamped), { width: 8, height: 8 });
});

Deno.test("text too wide for tEXt is refused rather than mangled", () => {
  assertThrows(
    () => withTextChunk(tinyPng({ width: 2, height: 2 }), "comment", "花瓶"),
    PngError,
    "escape it first",
  );
});

Deno.test("the sidecar copy sits right after IHDR and replaces an older one", () => {
  const sidecar = fixtureSidecar({
    params: { prompt: '花瓶 with 🌿 and "quotes"', seed: 7 },
  });
  const png = withTextChunk(
    withTextChunk(tinyPng({ width: 8, height: 8 }), "prompt", "{}"),
    SIDECAR_KEYWORD,
    serializeSidecarAscii(sidecar),
  );
  const chunks = readChunks(png);
  assertEquals(chunks[0]?.type, "IHDR");
  assertEquals(chunks[1]?.type, "tEXt");

  const embedded = readTextChunks(png);
  assert(SIDECAR_KEYWORD in embedded);
  assertEquals(parseSidecar(embedded[SIDECAR_KEYWORD]!), sidecar);

  const replaced = withTextChunk(png, SIDECAR_KEYWORD, "{}");
  assertEquals(
    readChunks(replaced).filter((chunk) => chunk.type === "tEXt").length,
    2,
  );
  assertEquals(readTextChunks(replaced)[SIDECAR_KEYWORD], "{}");
  // The unrelated chunk written by ComfyUI survives.
  assertEquals(readTextChunks(replaced).prompt, "{}");
});

Deno.test("tEXt keywords are length-checked", () => {
  const png = tinyPng({ width: 2, height: 2 });
  assertThrows(() => withTextChunk(png, "", "x"), PngError, "1–79");
  assertThrows(() => withTextChunk(png, "k".repeat(80), "x"), PngError);
});
