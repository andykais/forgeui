import type { Manifest, Param } from "../types.ts";

/**
 * Which params apply, given what the panel holds (§4.3). The mirror of
 * `src/workflows/visibility.ts`, which the server validates with — the two
 * have to answer the same, or the panel hides a required field the server
 * then refuses the job over.
 */

export function paramApplies(
  param: Param,
  values: Record<string, unknown>,
): boolean {
  const when = param.when;
  if (!when) return true;
  return values[when.param] === when.is;
}

export function applicableParams(
  manifest: Manifest,
  values: Record<string, unknown>,
): Param[] {
  return manifest.params.filter((param) => paramApplies(param, values));
}
