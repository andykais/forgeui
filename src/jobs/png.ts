/**
 * The little bit of PNG we need: read dimensions, and carry a copy of the
 * sidecar in a `tEXt` chunk (§5 step 7). The sidecar file stays canonical.
 */

export const PNG_SIGNATURE: Uint8Array = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

/** Keyword used for the embedded sidecar copy. */
export const SIDECAR_KEYWORD = "forgeui";

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export class PngError extends Error {
  override readonly name = "PngError";
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function hasSignature(png: Uint8Array): boolean {
  if (png.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, i) => png[i] === byte);
}

export function readChunks(png: Uint8Array): PngChunk[] {
  if (!hasSignature(png)) throw new PngError("not a PNG file");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder("latin1").decode(
      png.subarray(offset + 4, offset + 8),
    );
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new PngError(`truncated ${type} chunk`);
    chunks.push({ type, data: png.subarray(start, end) });
    offset = end + 4;
    if (type === "IEND") break;
  }
  if (chunks.length === 0 || chunks[0]?.type !== "IHDR") {
    throw new PngError("missing IHDR chunk");
  }
  return chunks;
}

export function serializeChunks(chunks: PngChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.length + 12, 0);
  const out = new Uint8Array(PNG_SIGNATURE.length + total);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  const encoder = new TextEncoder();
  for (const chunk of chunks) {
    const type = encoder.encode(chunk.type);
    if (type.length !== 4) {
      throw new PngError(`bad chunk type "${chunk.type}"`);
    }
    view.setUint32(offset, chunk.data.length);
    out.set(type, offset + 4);
    out.set(chunk.data, offset + 8);
    const crc = crc32(out.subarray(offset + 4, offset + 8 + chunk.data.length));
    view.setUint32(offset + 8 + chunk.data.length, crc);
    offset += chunk.data.length + 12;
  }
  return out;
}

export interface PngSize {
  width: number;
  height: number;
}

export function readPngSize(png: Uint8Array): PngSize {
  const ihdr = readChunks(png)[0]!;
  if (ihdr.data.length < 8) throw new PngError("short IHDR chunk");
  const view = new DataView(
    ihdr.data.buffer,
    ihdr.data.byteOffset,
    ihdr.data.byteLength,
  );
  return { width: view.getUint32(0), height: view.getUint32(4) };
}

/** `tEXt` is Latin-1 by the PNG spec; anything wider needs escaping first. */
function toLatin1(text: string, what: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new PngError(
        `${what} must be Latin-1 for a tEXt chunk; escape it first ` +
          `(found U+${code.toString(16).toUpperCase().padStart(4, "0")})`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

export function readTextChunks(png: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder("latin1");
  const out: Record<string, string> = {};
  for (const chunk of readChunks(png)) {
    if (chunk.type !== "tEXt") continue;
    const split = chunk.data.indexOf(0);
    if (split < 0) continue;
    const keyword = decoder.decode(chunk.data.subarray(0, split));
    out[keyword] = decoder.decode(chunk.data.subarray(split + 1));
  }
  return out;
}

/** Add or replace a `tEXt` chunk, keeping it directly after `IHDR`. */
export function withTextChunk(
  png: Uint8Array,
  keyword: string,
  text: string,
): Uint8Array {
  if (keyword.length === 0 || keyword.length > 79) {
    throw new PngError("tEXt keyword must be 1–79 characters");
  }
  const keywordBytes = toLatin1(keyword, "tEXt keyword");
  const textBytes = toLatin1(text, "tEXt text");
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data.set(textBytes, keywordBytes.length + 1);

  const chunks = readChunks(png).filter((chunk) => {
    if (chunk.type !== "tEXt") return true;
    const split = chunk.data.indexOf(0);
    if (split < 0) return true;
    return new TextDecoder("latin1").decode(chunk.data.subarray(0, split)) !==
      keyword;
  });
  chunks.splice(1, 0, { type: "tEXt", data });
  return serializeChunks(chunks);
}
