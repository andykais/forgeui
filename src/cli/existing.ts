/**
 * Whether a run of `forge models` would fetch something already fetched
 * (DESIGN-MODEL-IMPORT §3.2).
 *
 * Without `--overwrite`, a model that has a batch waiting in the import
 * folder, or that the app has already ingested, is left alone — and found
 * **without asking the network**, which is the point: re-running a list of
 * commands should cost nothing for the ones already done.
 *
 * Two places say a model has been fetched, both files the CLI may read:
 *
 *   <imports>/<sha256>/model.json            waiting for the app
 *   <appdata>/models-meta/<sha256>/civitai.json   the app ingested it (§7.2)
 *
 * The second is a file ingest writes, not the database: nothing here opens
 * `app.db`, which this command never does (§3.1). On a machine that only
 * fetches for a library elsewhere it does not exist, and only the first
 * counts.
 *
 * A hash names a batch directly. A link or a filename does not — finding out
 * what they point at is the lookup itself — so those are matched against what
 * the batches recorded: the Civitai model and version ids, the Hugging Face
 * repo and path, the filename.
 */

import { basename, join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import { normalizeHash, parseModelUrl } from "../models/civitai.ts";
import { parseHuggingFaceUrl } from "../models/huggingface.ts";

export interface Existing {
  hash: string;
  /** `pending`: in the import folder. `imported`: the app has ingested it. */
  state: "pending" | "imported";
  /** The file that says so. */
  path: string;
  name: string | null;
  version: string | null;
}

/** What a run was asked for, reduced to what can be matched offline. */
export type Wanted =
  | { hash: string }
  | { civitai: { model_id: number | null; model_version_id: number | null } }
  | { huggingface: { repo: string; path: string | null } }
  | { filename: string };

interface Recorded {
  hash: string;
  state: Existing["state"];
  path: string;
  filename: string | null;
  source: Record<string, unknown>;
  record: Record<string, unknown>;
}

/**
 * The offline key for a `--url`, or null when the link can only be resolved
 * by asking (an image link names neither a model nor a version).
 */
export function wantedFromUrl(url: string): Wanted | null {
  let hub;
  try {
    hub = parseHuggingFaceUrl(url);
  } catch {
    return null;
  }
  if (hub !== null) {
    return { huggingface: { repo: hub.repo, path: hub.path } };
  }
  let ref;
  try {
    ref = parseModelUrl(url);
  } catch {
    // Not a link this command reads; the lookup says so, not this.
    return null;
  }
  if (ref.sha256 !== null) return { hash: ref.sha256 };
  if (ref.model_id === null && ref.model_version_id === null) return null;
  return {
    civitai: {
      model_id: ref.model_id,
      model_version_id: ref.model_version_id,
    },
  };
}

export async function findExisting(
  paths: DataPaths,
  wanted: Wanted,
): Promise<Existing | null> {
  if ("hash" in wanted) {
    const hash = normalizeHash(wanted.hash);
    if (hash === null) return null;
    // Straight to the two files, without listing either folder.
    for (const found of [pending(paths, hash), imported(paths, hash)]) {
      const recorded = await found;
      if (recorded !== null) return existing(recorded);
    }
    return null;
  }

  for await (const recorded of everything(paths)) {
    if (matches(recorded, wanted)) return existing(recorded);
  }
  return null;
}

function matches(recorded: Recorded, wanted: Wanted): boolean {
  const source = recorded.source;
  if ("civitai" in wanted) {
    if (source.kind !== "civitai" && source.kind !== "civitai-archive") {
      return false;
    }
    const { model_id, model_version_id } = wanted.civitai;
    // A version link means that version. A bare model link means "the
    // newest", which only the network knows; the model already fetched is
    // taken to be it, and the message says `--overwrite` checks.
    if (model_version_id !== null) {
      return source.model_version_id === model_version_id;
    }
    return source.model_id === model_id;
  }
  if ("huggingface" in wanted) {
    if (source.kind !== "huggingface") return false;
    const { repo, path } = wanted.huggingface;
    if (source.repo !== repo) return false;
    return path === null || source.path === path;
  }
  if ("filename" in wanted) {
    const want = wanted.filename.toLowerCase();
    const names = [
      recorded.filename,
      typeof source.path === "string" ? basename(source.path) : null,
    ];
    return names.some((name) => name?.toLowerCase() === want);
  }
  return false;
}

function existing(recorded: Recorded): Existing {
  const model = recorded.record.model as Record<string, unknown> | undefined;
  const version = recorded.record.version as
    | Record<string, unknown>
    | undefined;
  return {
    hash: recorded.hash,
    state: recorded.state,
    path: recorded.path,
    name: typeof model?.name === "string" ? model.name : null,
    version: typeof version?.name === "string" ? version.name : null,
  };
}

/** Every batch still waiting, then every one already ingested. */
async function* everything(paths: DataPaths): AsyncGenerator<Recorded> {
  for (
    const [dir, read] of [
      [paths.imports, pending],
      [paths.modelsMeta, imported],
    ] as const
  ) {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Named by hash; `.staging` and `.failed` are neither, and a failed
      // batch is exactly the one worth fetching again.
      if (!entry.isDirectory || normalizeHash(entry.name) === null) continue;
      const recorded = await read(paths, entry.name.toLowerCase());
      if (recorded !== null) yield recorded;
    }
  }
}

async function pending(
  paths: DataPaths,
  hash: string,
): Promise<Recorded | null> {
  const path = join(paths.imports, hash, "model.json");
  const batch = await readJson(path);
  if (batch === null) return null;
  const model = batch.model as Record<string, unknown> | undefined;
  return {
    hash,
    state: "pending",
    path,
    filename: typeof model?.filename === "string" ? model.filename : null,
    source: object(batch.source) ?? object(object(batch.civitai)?.source) ??
      {},
    record: object(batch.civitai) ?? {},
  };
}

async function imported(
  paths: DataPaths,
  hash: string,
): Promise<Recorded | null> {
  const path = join(paths.modelsMeta, hash, "civitai.json");
  const record = await readJson(path);
  if (record === null) return null;
  return {
    hash,
    state: "imported",
    path,
    filename: null,
    source: object(record.source) ?? {},
    record,
  };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return object(JSON.parse(await Deno.readTextFile(path)));
  } catch {
    // Missing, or not something a run of this command wrote: not a match.
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
