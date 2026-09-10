import { dirname } from "@std/path";

/**
 * Fake model files: a valid safetensors header (8-byte little-endian length,
 * then JSON) and a few bytes of tensor data, so the scanner and the hasher run
 * for real on kilobyte-sized files (§14.1).
 */
export interface FakeModelOptions {
  /** Recorded in the header's `__metadata__`, to vary the bytes. */
  name?: string;
  /** Tensor bytes after the header; the fill byte is derived from the name. */
  bytes?: number;
  mtime?: Date;
  /**
   * Tensor names, and optionally shapes, for the header. Given one, the file
   * probes as a real architecture would (§6); left out, it holds a single
   * anonymous `weight` and probes as nothing.
   */
  tensors?: Record<string, number[]> | string[];
}

export async function writeFakeSafetensors(
  path: string,
  options: FakeModelOptions = {},
): Promise<Uint8Array> {
  const name = options.name ?? "fixture";
  const entries: Record<string, unknown> = { __metadata__: { name } };
  const tensors = options.tensors ?? { weight: [1] };
  const named = Array.isArray(tensors)
    ? Object.fromEntries(tensors.map((key) => [key, [1]]))
    : tensors;
  let offset = 0;
  for (const [key, shape] of Object.entries(named)) {
    entries[key] = {
      dtype: "F32",
      shape,
      data_offsets: [offset, offset + 4],
    };
    offset += 4;
  }
  const header = new TextEncoder().encode(JSON.stringify(entries));
  const tensor = new Uint8Array(options.bytes ?? 1024);
  tensor.fill(name.charCodeAt(0) & 0xff);
  const file = new Uint8Array(8 + header.length + tensor.length);
  new DataView(file.buffer).setBigUint64(0, BigInt(header.length), true);
  file.set(header, 8);
  file.set(tensor, 8 + header.length);

  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, file);
  if (options.mtime) await Deno.utime(path, options.mtime, options.mtime);
  return file;
}

/** The sha256 the hasher should arrive at, for the same bytes. */
export async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
