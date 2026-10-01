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
import type { PaidAccess } from "../models/civitai.ts";

export const CIVITAI_AUTH_HINT =
  "Put a key from civitai.com/user/account in config.yaml as " +
  "import.civitai_token, or set CIVITAI_TOKEN.";

export const HUGGINGFACE_AUTH_HINT =
  "Put a token from huggingface.co/settings/tokens in config.yaml as " +
  "import.huggingface_token, or set HF_TOKEN; a gated repo also needs its " +
  "terms accepted on its page.";

export class DownloadError extends Error {
  override readonly name = "DownloadError";
  /** As `LookupError.kind`: what `fetched/failure/…/error.txt` records. */
  readonly kind:
    | "needs-login"
    | "paid"
    | "rate-limited"
    | "server-error"
    | "unreachable"
    | "download-failed";
  constructor(
    message: string,
    kind: DownloadError["kind"] = "download-failed",
  ) {
    super(message);
    this.kind = kind;
  }
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
  /** What to do about a 401 or 403: where this site's key goes. */
  authHint?: string;
  /**
   * What the lookup said about paying for it (Civitai's `paidAccess`), and
   * the page it is bought on: a refusal of a paid file is about Buzz, not
   * about a missing key.
   */
  paid?: { access: PaidAccess | null; page: string | null };
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
      "unreachable",
    );
  }

  if (response.status === 401 || response.status === 403) {
    const refusal = await readRefusal(response);
    const paid = paidRefusal(refusal, options.paid?.access ?? null);
    if (paid !== null) {
      throw new DownloadError(
        describePaid({
          paid,
          status: response.status,
          url: options.url,
          name: basename(options.fallbackName),
          page: options.paid?.page ?? null,
          token: Boolean(options.token),
          said: refusal.message,
        }),
        "paid",
      );
    }
    throw new DownloadError(
      `${options.url} needs an account (${response.status}${
        refusal.message ? `: "${refusal.message}"` : ""
      }). ${options.authHint ?? CIVITAI_AUTH_HINT}${
        options.token
          ? " A key was sent and refused, so check that it is current."
          : ""
      }`,
      "needs-login",
    );
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new DownloadError(
      `GET ${options.url} answered ${response.status}`,
      response.status === 429
        ? "rate-limited"
        : response.status >= 500
        ? "server-error"
        : "download-failed",
    );
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

/** What a refusal said about itself: Civitai answers with a small JSON. */
interface Refusal {
  error: string | null;
  message: string | null;
  deadline: string | null;
}

async function readRefusal(response: Response): Promise<Refusal> {
  const none = { error: null, message: null, deadline: null };
  let body: string;
  try {
    body = await response.text();
  } catch {
    return none;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const field = (key: string) =>
      typeof parsed[key] === "string" && parsed[key].trim() !== ""
        ? (parsed[key] as string).trim()
        : null;
    return {
      error: field("error"),
      message: field("message"),
      deadline: field("deadline"),
    };
  } catch {
    // Not JSON: a short plain-text answer is still worth repeating.
    const text = body.trim();
    return { ...none, message: text && text.length <= 300 ? text : null };
  }
}

/**
 * Whether a refusal is about paying rather than about a key. Civitai says so
 * for early access — `{"error":"Early Access","deadline":…,"message":"…
 * Buzz…"}` with a 403 — and the lookup knows it for any version whose
 * creator charges for it, which is the only word there is for a permanently
 * paid file refused to a key that has not bought it.
 */
function paidRefusal(
  refusal: Refusal,
  access: PaidAccess | null,
): PaidAccess | null {
  const said = `${refusal.error ?? ""} ${refusal.message ?? ""}`;
  const early = /early access/i.test(said);
  if (early || /\bbuzz\b|purchase|\bbuy\b/i.test(said)) {
    return {
      permanent: access?.permanent ?? !early,
      ends_at: refusal.deadline ?? access?.ends_at ?? null,
    };
  }
  return access;
}

/**
 * The refusal of a paid download, as something to act on. The first line is
 * the whole story, because it is the line a later skip repeats from
 * `error.txt` (§3.2); the rest is what to do.
 */
function describePaid(input: {
  paid: PaidAccess;
  status: number;
  url: string;
  name: string;
  page: string | null;
  token: boolean;
  said: string | null;
}): string {
  const { paid } = input;
  const until = paid.ends_at === null ? null : readableDate(paid.ends_at);
  const early = !paid.permanent && until !== null;
  const where = input.page ?? "its page on Civitai";
  return [
    early
      ? `${input.name} is in Early Access on Civitai until ${until}: its ` +
        `creator charges Buzz to download it before then.`
      : `${input.name} is paid on Civitai: its creator charges Buzz to ` +
        `download it.`,
    `  Civitai answered ${input.status} to ${input.url}${
      input.said ? `: "${input.said}"` : ""
    }`,
    input.token
      ? `  A key was sent and refused. A key alone does not unlock a paid ` +
        `download: either its account has not bought this one, or the key is ` +
        `not current.`
      : `  No key was sent, and a key alone would not unlock it either.`,
    `  To download it now: buy access with Buzz on ${where}, logged in as ` +
    `the account your key belongs to, then run this again with --overwrite${
      input.token ? "" : ` and that key (${CIVITAI_AUTH_HINT})`
    }.`,
    ...(early
      ? [
        `  Or wait until ${until}, when it is free, and run this again with ` +
        `--overwrite.`,
      ]
      : []),
    `  The metadata and samples import on their own: the same command ` +
    `without --download-model, with --overwrite.`,
  ].join("\n");
}

function readableDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
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
