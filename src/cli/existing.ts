/**
 * Whether a run of `forge models` would fetch something already fetched
 * (DESIGN-MODEL-IMPORT §3.2).
 *
 * **`<imports>/imported_checksums.txt` decides.** Every batch this command
 * writes appends its sha256 there, and without `--overwrite` a model listed
 * there is left alone. It is a plain file on purpose: delete a line and that
 * model can be fetched again; add one and it will not be.
 *
 * Finding the checksum is the other half, and should not need the network,
 * since re-running a list of commands ought to cost nothing for the ones
 * already done. A hash is its own answer. A link or a filename is not —
 * finding out what they point at is the lookup itself — so they are matched
 * against what earlier batches recorded, in two places, both files:
 *
 *   <imports>/<sha256>/model.json                  waiting for the app
 *   <appdata>/models-meta/<sha256>/civitai.json    the app ingested it (§7.2)
 *
 * The second is a file ingest writes, not the database: nothing here opens
 * `app.db` (§3.1). Where neither says, the lookup runs, and the list is
 * checked again before anything is downloaded or written.
 *
 * The first time the list is needed and does not exist, it is seeded from
 * those same two places, so nothing fetched before it existed is fetched
 * again because of it.
 */

import { basename, join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import { normalizeHash, parseModelUrl } from "../models/civitai.ts";
import { parseHuggingFaceUrl } from "../models/huggingface.ts";

export interface Existing {
  hash: string;
  /**
   * `pending`: a batch waits in the import folder. `imported`: the app has
   * ingested it. `listed`: only the checksum list knows of it — another
   * machine fetched it, or a line was added by hand.
   */
  state: "pending" | "imported" | "listed";
  /** The batch or record that says what it is, or the list itself. */
  path: string;
  name: string | null;
  version: string | null;
}

/** The checksum list, as read: sha256 → whatever note follows it. */
export interface Ledger {
  path: string;
  hashes: Map<string, string>;
  /** False until the first append writes it, seed and all. */
  onDisk: boolean;
}

export const LEDGER_FILE = "imported_checksums.txt";

const LEDGER_HEADER = [
  "# Checksums `forge models` has fetched. A model listed here is not fetched",
  "# again unless --overwrite is passed: delete its line to let it be, or add",
  "# one to keep a model out. One sha256 per line; the rest is a note.",
  "",
].join("\n");

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

/**
 * The list, read — or, before it exists, seeded in memory from the batches
 * waiting and the models already ingested. It reaches the disk with the first
 * batch written, so a run that writes nothing leaves nothing behind.
 */
export async function readLedger(paths: DataPaths): Promise<Ledger> {
  const path = join(paths.imports, LEDGER_FILE);
  let text: string | null = null;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (text !== null) return { path, hashes: parseLedger(text), onDisk: true };

  const hashes = new Map<string, string>();
  for await (const recorded of everything(paths)) {
    if (!hashes.has(recorded.hash)) {
      hashes.set(recorded.hash, label(existing(recorded)));
    }
  }
  return { path, hashes, onDisk: false };
}

export function parseLedger(text: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const [first, ...rest] = trimmed.split(/\s+/);
    const hash = normalizeHash(first ?? "");
    // A line that is not a checksum is somebody's note, not an error.
    if (hash !== null) hashes.set(hash, rest.join(" "));
  }
  return hashes;
}

/** One more line, unless the list already has it: the list is a set. */
export async function appendToLedger(
  ledger: Ledger,
  hash: string,
  note: string,
): Promise<boolean> {
  if (ledger.onDisk && ledger.hashes.has(hash)) return false;
  if (!ledger.hashes.has(hash)) ledger.hashes.set(hash, note);
  if (ledger.onDisk) {
    await Deno.writeTextFile(ledger.path, ledgerLine(hash, note), {
      append: true,
    });
  } else {
    // The first write carries the seed with it.
    await Deno.writeTextFile(
      ledger.path,
      LEDGER_HEADER +
        [...ledger.hashes].map(([entry, text]) => ledgerLine(entry, text))
          .join(""),
    );
    ledger.onDisk = true;
  }
  return true;
}

/**
 * Whether a checksum counts as fetched: on the list, unless all that is left
 * of it is a batch the app refused. That one is the most worth fetching
 * again, and making someone edit the list after every failure would be a
 * chore the folder already answers.
 */
export async function isFetched(
  paths: DataPaths,
  ledger: Ledger,
  hash: string,
): Promise<boolean> {
  if (!ledger.hashes.has(hash)) return false;
  if (!await exists(join(paths.imports, ".failed", hash))) return true;
  return await pending(paths, hash) !== null ||
    await imported(paths, hash) !== null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function ledgerLine(hash: string, note: string): string {
  // `sha256sum`'s layout, so the usual tools read it.
  const flat = note.replace(/\s+/g, " ").trim();
  return flat.length > 0 ? `${hash}  ${flat}\n` : `${hash}\n`;
}

export function label(
  entry: { name: string | null; version: string | null },
): string {
  return [entry.name, entry.version].filter((part) => part !== null).join(
    " · ",
  );
}

/**
 * The model a run asks for, if it is already on the list — found offline.
 * A hash is looked up directly; a link or filename through the batches that
 * recorded it. Null means "not known to be fetched": the lookup runs.
 */
export async function findExisting(
  paths: DataPaths,
  wanted: Wanted,
  ledger: Ledger,
): Promise<Existing | null> {
  if ("hash" in wanted) {
    const hash = normalizeHash(wanted.hash);
    if (hash === null || !await isFetched(paths, ledger, hash)) return null;
    // Straight to the two files, without listing either folder, for a name
    // to print. The list is the answer either way.
    const recorded = await pending(paths, hash) ?? await imported(paths, hash);
    return recorded === null ? listed(ledger, hash) : existing(recorded);
  }

  // A bare model link can match several versions fetched over time; any one
  // on the list is the answer.
  for await (const recorded of everything(paths)) {
    if (!matches(recorded, wanted)) continue;
    if (await isFetched(paths, ledger, recorded.hash)) {
      return existing(recorded);
    }
  }
  return null;
}

/** What the list alone says about a checksum. */
export function listed(ledger: Ledger, hash: string): Existing {
  const note = ledger.hashes.get(hash) ?? "";
  return {
    hash,
    state: "listed",
    path: ledger.path,
    name: note.length > 0 ? note : null,
    version: null,
  };
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
