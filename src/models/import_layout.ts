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
