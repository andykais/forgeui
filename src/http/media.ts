import { contentType } from "@std/media-types";
import { extname, join, normalize, resolve } from "@std/path";
import type { DataPaths } from "../config/paths.ts";

/**
 * `GET /api/media/*` (§12) serves the three directories that hold media, and
 * only those: a request that resolves anywhere else is refused rather than
 * followed.
 */

const SERVABLE = ["outputs", "inputs", "samples"] as const;

export class MediaPathError extends Error {
  override readonly name = "MediaPathError";
}

/** `outputs/2026/09/05/01J-0.png` → an absolute path inside `<appdata>`. */
export function resolveMediaPath(paths: DataPaths, relative: string): string {
  const decoded = relative.split("/").map(decodeURIComponent).join("/");
  const normalized = normalize(decoded);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new MediaPathError("media path must be relative to the data dir");
  }
  const root = normalized.split("/")[0] ?? "";
  if (!(SERVABLE as readonly string[]).includes(root)) {
    throw new MediaPathError(
      `media path must start with ${SERVABLE.join(", ")}`,
    );
  }
  const absolute = resolve(join(paths.root, normalized));
  // Belt and braces against symlinks and clever encodings.
  if (!absolute.startsWith(resolve(paths.root) + "/")) {
    throw new MediaPathError("media path escapes the data dir");
  }
  return absolute;
}

function rangeOf(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return null;
  return { start, end };
}

export async function serveMedia(
  req: Request,
  paths: DataPaths,
  relative: string,
): Promise<Response> {
  const path = resolveMediaPath(paths, relative);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("not found", { status: 404 });
    }
    throw error;
  }
  if (!stat.isFile) return new Response("not found", { status: 404 });

  const modified = stat.mtime ?? new Date(0);
  const etag = `"${stat.size.toString(16)}-${modified.getTime().toString(16)}"`;
  const headers = new Headers({
    "content-type": contentType(extname(path)) ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "last-modified": modified.toUTCString(),
    etag,
    // Output files never change once written; the id is in the name.
    "cache-control": "private, max-age=31536000, immutable",
  });
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === "HEAD") {
    headers.set("content-length", String(stat.size));
    return new Response(null, { headers });
  }

  // Videos are seekable in Phase 3, and browsers ask with a range for those.
  const range = rangeOf(req.headers.get("range"), stat.size);
  if (range) {
    const file = await Deno.open(path, { read: true });
    await file.seek(range.start, Deno.SeekMode.Start);
    headers.set("content-length", String(range.end - range.start + 1));
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${stat.size}`,
    );
    return new Response(
      file.readable.pipeThrough(
        new TransformStream(new LimitedBytes(range.end - range.start + 1)),
      ),
      { status: 206, headers },
    );
  }

  const file = await Deno.open(path, { read: true });
  headers.set("content-length", String(stat.size));
  return new Response(file.readable, { headers });
}

/** Stops a ranged read at the requested length. */
class LimitedBytes implements Transformer<Uint8Array, Uint8Array> {
  #left: number;

  constructor(limit: number) {
    this.#left = limit;
  }

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    if (this.#left <= 0) return;
    if (chunk.length <= this.#left) {
      this.#left -= chunk.length;
      controller.enqueue(chunk);
    } else {
      controller.enqueue(chunk.subarray(0, this.#left));
      this.#left = 0;
    }
    if (this.#left <= 0) controller.terminate();
  }
}
