import type { Manifest, Param } from "./types.ts";

/**
 * Which params apply, given what the panel currently holds (§4.3).
 *
 * A `when` clause is display *and* validation: a field the workflow is
 * ignoring should not be shown, and a `required` field nobody can see is a
 * submit button that refuses with no way to find out why. The panel and the
 * server therefore have to agree on this exactly, which is why it is one
 * function rather than a rule written out twice.
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

/**
 * The keys a `when` chain would have to read to answer for this one, in the
 * order it reads them. Used at load to refuse a manifest whose conditions
 * depend on each other in a circle — there is no value either could hold
 * that would settle it, so the panel would have to guess.
 */
export function whenChain(
  params: readonly Param[],
  from: Param,
): string[] | null {
  const byKey = new Map(params.map((param) => [param.key, param]));
  const seen = new Set<string>([from.key]);
  const chain: string[] = [];
  let current: Param | undefined = from;
  while (current?.when) {
    const next: string = current.when.param;
    chain.push(next);
    if (seen.has(next)) return null;
    seen.add(next);
    current = byKey.get(next);
  }
  return chain;
}
