/**
 * The import folder's layout (DESIGN-MODEL-IMPORT §5.1): who writes where,
 * in one place, so the CLI and the app cannot disagree about it.
 *
 *   <import>/
 *     fetched/                         written by `forge models`
 *       success/<sha256>/model.json    a batch, waiting for the app
 *       failure/<sha256>/error.txt     a lookup whose answer was "no"
 *       .staging/                      batches being written
 *     imported/                        written by the app
 *       success/<sha256>/model.json    applied — kept as history
 *       failure/<sha256>/model.json    refused, with error.txt beside it
 *
 * A checksum anywhere in these four is one `forge models` leaves alone
 * without `--overwrite` (§3.2). Pure paths: nothing here touches the disk or
 * the database, so both sides may import it.
 */

import { join } from "@std/path";

export interface ImportLayout {
  root: string;
  fetched: { success: string; failure: string };
  imported: { success: string; failure: string };
  /** Batches are written here and renamed into `fetched/success/`. */
  staging: string;
}

export function importLayout(root: string): ImportLayout {
  return {
    root,
    fetched: {
      success: join(root, "fetched", "success"),
      failure: join(root, "fetched", "failure"),
    },
    imported: {
      success: join(root, "imported", "success"),
      failure: join(root, "imported", "failure"),
    },
    staging: join(root, "fetched", ".staging"),
  };
}

/** Where a checksum can be, and what each place means. */
export type ImportState =
  | "fetched"
  | "fetch-failed"
  | "imported"
  | "import-failed";

export function stateDirs(layout: ImportLayout): [ImportState, string][] {
  return [
    ["fetched", layout.fetched.success],
    ["fetch-failed", layout.fetched.failure],
    ["imported", layout.imported.success],
    ["import-failed", layout.imported.failure],
  ];
}

/**
 * `error.txt`, as both sides write it: a few `key: value` lines, a blank
 * line, then the message as it was reported.
 *
 *   when: 2026-09-30T12:00:00Z
 *   command: forge models --sha256checksum 6ce0…
 *   failure: rate-limited
 *
 *   GET https://civitaiarchive.com/api/sha256/6ce0… answered 429: …
 *
 * `failure:` is the word to prune by — `not-found`, `rate-limited`,
 * `needs-login`, `server-error`, `unreachable`, `download-failed`, `error`
 * from `forge models`; `refused` from the app.
 */
export interface ErrorNote {
  when: string;
  command?: string;
  failure: string;
  message: string;
}

export function formatErrorNote(note: ErrorNote): string {
  const head = [
    `when: ${note.when}`,
    ...(note.command === undefined ? [] : [`command: ${note.command}`]),
    `failure: ${note.failure}`,
  ];
  return `${head.join("\n")}\n\n${note.message.trimEnd()}\n`;
}

export function parseErrorNote(text: string): Partial<ErrorNote> {
  const blank = text.indexOf("\n\n");
  const head = blank < 0 ? text : text.slice(0, blank);
  const note: Partial<ErrorNote> = {};
  for (const line of head.split("\n")) {
    const match = line.match(/^(when|command|failure):\s*(.*)$/);
    if (match) note[match[1] as "when" | "command" | "failure"] = match[2]!;
  }
  if (blank >= 0) note.message = text.slice(blank + 2).trim();
  return note;
}
