/**
 * `--overwrite[=<scope>,…]` (DESIGN-MODEL-IMPORT §3.2): what a run may
 * replace of what earlier runs left.
 *
 * The words are of two kinds. **Places** say whose record may be replaced:
 * `fetched` — a batch waiting in `fetched/` (or a failure recorded there) —
 * and `imported`, what the app has already applied. **Parts** say what of it:
 * `metadata` (`model.json`'s model, source and Civitai record), `samples` and
 * `models` (the weights). Naming no place means both; naming no part means
 * all three; a bare `--overwrite` is everything. A part is replaced only in a
 * place that is named, so `imported,samples` is the samples of an imported
 * model and nothing in `fetched/`.
 */

import type { ImportState } from "../models/import_layout.ts";

export type OverwritePlace = "fetched" | "imported";
export type OverwritePart = "metadata" | "samples" | "models";

export interface Overwrite {
  places: ReadonlySet<OverwritePlace>;
  parts: ReadonlySet<OverwritePart>;
}

const PLACES: readonly OverwritePlace[] = ["fetched", "imported"];
const PARTS: readonly OverwritePart[] = ["metadata", "samples", "models"];

export const OVERWRITE_WORDS: readonly string[] = [...PLACES, ...PARTS];

/** A bare `--overwrite`. */
export const OVERWRITE_ALL: Overwrite = {
  places: new Set(PLACES),
  parts: new Set(PARTS),
};

export class OverwriteError extends Error {
  override readonly name = "OverwriteError";
}

/**
 * What cliffy hands over — `true` for a bare flag, the text after `=`
 * otherwise, nothing without it — as a scope, or null for none at all.
 */
export function parseOverwrite(
  value: boolean | string | undefined,
): Overwrite | null {
  if (value === undefined || value === false) return null;
  if (value === true) return OVERWRITE_ALL;
  const words = value.split(",").map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
  if (words.length === 0) return OVERWRITE_ALL;
  const places = new Set<OverwritePlace>();
  const parts = new Set<OverwritePart>();
  for (const word of words) {
    if ((PLACES as readonly string[]).includes(word)) {
      places.add(word as OverwritePlace);
    } else if ((PARTS as readonly string[]).includes(word)) {
      parts.add(word as OverwritePart);
    } else {
      throw new OverwriteError(
        `--overwrite does not know "${word}"; it takes a comma-separated ` +
          `list of ${OVERWRITE_WORDS.join(", ")}, or nothing for all of them`,
      );
    }
  }
  return {
    places: places.size > 0 ? places : OVERWRITE_ALL.places,
    parts: parts.size > 0 ? parts : OVERWRITE_ALL.parts,
  };
}

/** `true` is a bare `--overwrite`, `false` none; tests and callers use both. */
export function toOverwrite(
  value: boolean | Overwrite | null,
): Overwrite | null {
  if (value === true) return OVERWRITE_ALL;
  if (value === false) return null;
  return value;
}

/** Which place an earlier result is in. */
export function placeOf(state: ImportState): OverwritePlace {
  return state === "fetched" || state === "fetch-failed"
    ? "fetched"
    : "imported";
}

export function allows(
  overwrite: Overwrite | null,
  place: OverwritePlace,
  part?: OverwritePart,
): boolean {
  if (overwrite === null || !overwrite.places.has(place)) return false;
  return part === undefined || overwrite.parts.has(part);
}

/** The flag as it would be typed: `--overwrite` or `--overwrite=a,b`. */
export function overwriteFlag(overwrite: Overwrite): string {
  const words = [
    ...(overwrite.places.size === PLACES.length
      ? []
      : PLACES.filter((place) => overwrite.places.has(place))),
    ...(overwrite.parts.size === PARTS.length
      ? []
      : PARTS.filter((part) => overwrite.parts.has(part))),
  ];
  return words.length === 0 ? "--overwrite" : `--overwrite=${words.join(",")}`;
}
