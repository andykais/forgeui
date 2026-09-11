/**
 * The search boxes in the pickers (§11.3). A query is a plain case-insensitive
 * substring, unless it reads like a pattern — anything carrying a regular
 * expression metacharacter — in which case it is compiled as a JavaScript
 * regular expression, so `krea.*lighting` finds `krea/lighting.safetensors`.
 *
 * A half-typed or invalid pattern falls back to the substring rather than
 * emptying the list under the user's fingers.
 */
const META = /[\\^$.*+?()[\]{}|]/;

export function matcher(
  query: string,
): (...fields: (string | null | undefined)[]) => boolean {
  const needle = query.trim();
  if (needle.length === 0) return () => true;

  let pattern: RegExp | null = null;
  if (META.test(needle)) {
    try {
      pattern = new RegExp(needle, "i");
    } catch {
      pattern = null;
    }
  }
  const lower = needle.toLowerCase();

  return (...fields) =>
    fields.some((field) =>
      typeof field === "string" && field.length > 0
        ? pattern
          ? pattern.test(field)
          : field.toLowerCase().includes(lower)
        : false,
    );
}
