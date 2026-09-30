import type { ModelEntry, RescanResult } from "../types.ts";

/** The first of each group wins, so the caller's sort decides which. */
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * One row per choice a picker can make.
 *
 * A picker writes a model's `name` into the workflow, and a name is a path
 * relative to whichever folder the file was found in — so one file reachable
 * through two configured folders (`checkpoints` and `Stable-Diffusion`
 * pointing at one directory is the usual way) offers the same string twice.
 * Two rows, one choice, and picking either does the same thing.
 */
export function byChoice(models: ModelEntry[]): ModelEntry[] {
  return uniqueBy(models, (model) => model.name);
}

/**
 * One row per model, for a list whose rows mean a model rather than a name:
 * the gallery's filter is a hash, so two copies of one file are one filter.
 * A file nobody has hashed yet has only its path to be itself by (§8.1).
 */
export function byModel(models: ModelEntry[]): ModelEntry[] {
  return uniqueBy(models, (model) => model.hash ?? model.path);
}

/**
 * The toast a Rescan ends with: the files, what is left to hash, and what
 * `forge models` left in the import folder for this pass to apply
 * (DESIGN-MODEL-IMPORT §7.1).
 */
export function rescanSummary(result: RescanResult): string {
  const hashing =
    result.queued > 0
      ? `${result.models} models · hashing ${result.queued}`
      : `${result.models} models, nothing new to hash`;
  const { batches, samples } = result.imports;
  if (batches === 0) return hashing;
  const extra = samples > 0 ? `, ${samples} ${samples === 1 ? "sample" : "samples"}` : "";
  return `${hashing} · importing ${batches} metadata${extra}`;
}
