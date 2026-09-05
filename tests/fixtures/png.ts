import {
  crc32,
  PNG_SIGNATURE,
  type PngChunk,
  serializeChunks,
} from "../../src/jobs/png.ts";

/**
 * Tiny truecolor PNGs with known dimensions, used wherever a test needs real
 * image bytes. Compression uses stored deflate blocks, so the output is
 * byte-for-byte deterministic across platforms.
 */
export interface TinyPngOptions {
  width: number;
  height: number;
  /** Solid fill, default a mid grey. */
  color?: [number, number, number];
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStore(data: Uint8Array): Uint8Array {
  const maxBlock = 0xffff;
  const blocks = Math.max(1, Math.ceil(data.length / maxBlock));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * maxBlock;
    const chunk = data.subarray(start, Math.min(start + maxBlock, data.length));
    out[offset++] = i === blocks - 1 ? 1 : 0;
    out[offset++] = chunk.length & 0xff;
    out[offset++] = (chunk.length >> 8) & 0xff;
    out[offset++] = ~chunk.length & 0xff;
    out[offset++] = (~chunk.length >> 8) & 0xff;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  const sum = adler32(data);
  out[offset++] = (sum >>> 24) & 0xff;
  out[offset++] = (sum >>> 16) & 0xff;
  out[offset++] = (sum >>> 8) & 0xff;
  out[offset++] = sum & 0xff;
  return out;
}

export function tinyPng(options: TinyPngOptions): Uint8Array {
  const { width, height } = options;
  if (width < 1 || height < 1) {
    throw new Error("tinyPng: width and height must be positive");
  }
  const [r, g, b] = options.color ?? [0x3d, 0x3d, 0x3d];

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3;
  const rawScanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    rawScanlines[rowStart] = 0; // filter type "none"
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      rawScanlines[p] = r;
      rawScanlines[p + 1] = g;
      rawScanlines[p + 2] = b;
    }
  }

  const chunks: PngChunk[] = [
    { type: "IHDR", data: ihdr },
    { type: "IDAT", data: zlibStore(rawScanlines) },
    { type: "IEND", data: new Uint8Array(0) },
  ];
  return serializeChunks(chunks);
}

export async function writeTinyPng(
  path: string,
  options: TinyPngOptions,
): Promise<Uint8Array> {
  const bytes = tinyPng(options);
  await Deno.writeFile(path, bytes);
  return bytes;
}

export { crc32, PNG_SIGNATURE };
