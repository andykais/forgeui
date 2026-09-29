/**
 * Whether a run of `forge models` would fetch something already dealt with
 * (DESIGN-MODEL-IMPORT §3.2).
 *
 * **A checksum anywhere in the import folder is left alone** without
 * `--overwrite` — fetched and waiting, looked up and not found, imported, or
 * refused by the app (`import_layout.ts`). The folder is the history, and
 * the history is what decides: delete a checksum's directory and that model
 * can be fetched again.
 *
 * Finding the checksum should not need the network, since re-running a list
 * of commands ought to cost nothing for the ones already done. A hash is its
 * own answer. A link or a filename is not — finding out what they point at
 * is the lookup itself — so they are matched against what earlier batches
 * recorded in their `model.json`: the Civitai model and version ids, the
 * Hugging Face repo and path, the filename. Where nothing matches, the
 * lookup runs, and its answer is checked here before anything is downloaded
 * or written.
 *
 * Files only: nothing here opens `app.db` (§3.1).
 */

import { basename, join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import { normalizeHash, parseModelUrl } from "../models/civitai.ts";
import { parseHuggingFaceUrl } from "../models/huggingface.ts";
import {
  importLayout,
  type ImportState,
  parseErrorNote,
  stateDirs,
} from "../models/import_layout.ts";

export interface Existing {
  hash: string;
  state: ImportState;
  /** The checksum's directory. */
  dir: string;
  name: string | null;
  version: string | null;
  /** For a failure: the reason, from its `error.txt`. */
  reason: string | null;
  /** For a failure: its kind — `not-found`, `rate-limited`, `refused`, … */
  failure: string | null;
}

/** What a run was asked for, reduced to what can be matched offline. */
export type Wanted =
  | { hash: string }
  | { civitai: { model_id: number | null; model_version_id: number | null } }
  | { huggingface: { repo: string; path: string | null } }
  | { filename: string };

interface Recorded {
  hash: string;
  state: ImportState;
  dir: string;
  batch: Record<string, unknown> | null;
  reason: string | null;
  failure: string | null;
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

/**
 * The model a run asks for, if the import folder already has it — found
 * offline. Null means "not known here": the lookup runs.
 */
export async function findExisting(
  paths: DataPaths,
  wanted: Wanted,
): Promise<Existing | null> {
  if ("hash" in wanted) {
    const hash = normalizeHash(wanted.hash);
    if (hash === null) return null;
    // Straight to the four places, without listing any of them.
    for (const [state, dir] of stateDirs(importLayout(paths.imports))) {
      const recorded = await read(state, join(dir, hash), hash);
      if (recorded !== null) return existing(recorded);
    }
    return null;
  }
  for await (const recorded of everything(paths)) {
    if (recorded.batch !== null && matches(recorded.batch, wanted)) {
      return existing(recorded);
    }
  }
  return null;
}

function matches(batch: Record<string, unknown>, wanted: Wanted): boolean {
  const source = object(batch.source) ??
    object(object(batch.civitai)?.source) ??
    {};
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
    const model = object(batch.model);
    const names = [
      typeof model?.filename === "string" ? model.filename : null,
      typeof source.path === "string" ? basename(source.path) : null,
    ];
    return names.some((name) => name?.toLowerCase() === want);
  }
  return false;
}

export function label(
  entry: { name: string | null; version: string | null },
): string {
  return [entry.name, entry.version].filter((part) => part !== null).join(
    " · ",
  );
}

function existing(recorded: Recorded): Existing {
  const record = object(recorded.batch?.civitai);
  const model = object(record?.model);
  const version = object(record?.version);
  const batchModel = object(recorded.batch?.model);
  return {
    hash: recorded.hash,
    state: recorded.state,
    dir: recorded.dir,
    name: typeof model?.name === "string"
      ? model.name
      : typeof batchModel?.display_name === "string"
      ? batchModel.display_name
      : null,
    version: typeof version?.name === "string" ? version.name : null,
    reason: recorded.reason,
    failure: recorded.failure,
  };
}

/** Every checksum directory, in the order the states are listed. */
async function* everything(paths: DataPaths): AsyncGenerator<Recorded> {
  for (const [state, dir] of stateDirs(importLayout(paths.imports))) {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const hash = normalizeHash(entry.name);
      if (!entry.isDirectory || hash === null) continue;
      const recorded = await read(state, join(dir, entry.name), hash);
      if (recorded !== null) yield recorded;
    }
  }
}

async function read(
  state: ImportState,
  dir: string,
  hash: string,
): Promise<Recorded | null> {
  try {
    if (!(await Deno.stat(dir)).isDirectory) return null;
  } catch {
    return null;
  }
  const batch = await readJson(join(dir, "model.json"));
  let reason: string | null = null;
  let failure: string | null = null;
  if (state === "fetch-failed" || state === "import-failed") {
    try {
      const note = parseErrorNote(
        await Deno.readTextFile(join(dir, "error.txt")),
      );
      reason = note.message?.split("\n")[0]?.trim() || null;
      failure = note.failure ?? null;
    } catch {
      // A failure without its note is still a failure.
    }
  }
  return { hash, state, dir, batch, reason, failure };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return object(JSON.parse(await Deno.readTextFile(path)));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
