/**
 * Fetching the weights themselves (DESIGN-MODEL-IMPORT §4, amended).
 *
 * The design gave this job to the official Civitai CLI, on the grounds that
 * device login, token storage and resumable verified transfers are the hard
 * part and not worth reimplementing. That was right about the hard part and
 * wrong about the common case: the CLI is a separate install almost nobody
 * has, and `civitai.com/api/download/models/<id>` answers an anonymous GET
 * with a 307 to a signed URL for any public model. Requiring the binary made
 * `--download-model` fail out of the box, which is the one thing that flag
 * must not do.
 *
 * So: download directly, stream it, hash it on the way past, and use
 * `CIVITAI_TOKEN` when there is one. The official CLI is still used when it
 * is installed and configured, because it does handle the gated and paid
 * models this cannot.
 */

import { basename, join } from "@std/path";
import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

export class DownloadError extends Error {
  override readonly name = "DownloadError";
}

export interface DownloadedFile {
  /** Absolute path of what landed on disk. */
  path: string;
  filename: string;
  sha256: string;
  size: number;
}

export interface DownloadOptions {
  url: string;
  into: string;
  /** Used as the name when the server does not suggest one. */
  fallbackName: string;
  token?: string | null;
  timeoutMs: number;
  say?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
}

/**
 * Stream a model to disk, hashing as it goes. One pass, constant memory: a
 * checkpoint is several gigabytes and must never be held whole.
 */
export async function downloadFile(
  options: DownloadOptions,
): Promise<DownloadedFile> {
  const say = options.say ?? (() => {});
  const doFetch = options.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = {};
  // Only gated and paid models need this; a public one answers without it.
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await doFetch(options.url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "follow",
    });
  } catch (cause) {
    throw new DownloadError(
      `GET ${options.url} failed: ${
        cause instanceof Error ? cause.message : cause
      }`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new DownloadError(
      `${options.url} needs an account (${response.status}). Set CIVITAI_TOKEN ` +
        `to a key from civitai.com/user/account, or install the official CLI ` +
        `and run \`civitai login\`.`,
    );
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new DownloadError(`GET ${options.url} answered ${response.status}`);
  }

  const filename = suggestedName(response) ?? basename(options.fallbackName);
  const path = join(options.into, filename);
  const expected = Number(response.headers.get("content-length") ?? "0");

  await Deno.mkdir(options.into, { recursive: true });
  const file = await Deno.open(path, {
    write: true,
    create: true,
    truncate: true,
  });
  let written = 0;
  let announced = 0;
  try {
    const digest = await stdCrypto.subtle.digest(
      "SHA-256",
      writeThrough(response.body, file, (chunk) => {
        written += chunk;
        // A line every 64 MB: enough to show it is alive, few enough that a
        // 6 GB download does not scroll the terminal away.
        if (written - announced < 64 << 20) return;
        announced = written;
        say(`  ${progress(written, expected)}`);
      }),
    );
    say(`  ${progress(written, written)} — ${filename}`);
    return {
      path,
      filename,
      sha256: encodeHex(new Uint8Array(digest)),
      size: written,
    };
  } catch (cause) {
    // A half-written model is worse than none: the batch would carry a file
    // whose hash cannot match, and ingest would refuse the whole thing.
    await Deno.remove(path).catch(() => {});
    throw new DownloadError(
      `${filename}: ${cause instanceof Error ? cause.message : cause}`,
    );
  } finally {
    file.close();
  }
}

/** Write each chunk, then hand it on to the digest. One read, two uses. */
async function* writeThrough(
  body: ReadableStream<Uint8Array>,
  file: Deno.FsFile,
  onBytes: (count: number) => void,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for await (const chunk of body) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      offset += await file.write(chunk.subarray(offset));
    }
    onBytes(chunk.byteLength);
    yield chunk as Uint8Array<ArrayBuffer>;
  }
}

/**
 * Civitai puts the real name in `content-disposition`; the URL path holds an
 * opaque storage key, so the header is the only place a usable name lives.
 */
function suggestedName(response: Response): string | null {
  const disposition = response.headers.get("content-disposition");
  if (!disposition) return null;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return sanitize(decodeURIComponent(star[1]!));
    } catch {
      // A name we cannot decode is a name we do not use.
    }
  }
  const plain = disposition.match(/filename="([^"]+)"/i) ??
    disposition.match(/filename=([^;]+)/i);
  return plain ? sanitize(plain[1]!.trim()) : null;
}

/** Their name, our directory: nothing here may climb out of it. */
function sanitize(name: string): string {
  const flat = basename(name.replaceAll("\\", "/")).trim();
  return flat.length === 0 || flat === "." || flat === ".." ? "model" : flat;
}

function progress(done: number, total: number): string {
  const mib = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  if (total <= 0) return mib(done);
  return `${mib(done)} of ${mib(total)} (${Math.round((done / total) * 100)}%)`;
}
