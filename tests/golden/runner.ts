import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Golden files are compared, never regenerated on the fly: a diff fails the
 * test, and updating one is a deliberate `UPDATE_GOLDEN=1 deno task test`
 * (§14.2).
 */
export const GOLDEN_ROOT: string = dirname(fromFileUrl(import.meta.url));

export function updatingGolden(): boolean {
  return (Deno.env.get("UPDATE_GOLDEN") ?? "") !== "";
}

function format(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * Compare `actual` against the JSON in `path`. With `UPDATE_GOLDEN=1` the file
 * is written instead, creating it if missing.
 */
export async function assertGoldenJson(
  path: string,
  actual: unknown,
): Promise<void> {
  const rendered = format(actual);
  const existing = await readIfPresent(path);

  if (updatingGolden()) {
    if (existing !== rendered) {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, rendered);
    }
    return;
  }

  if (existing === null) {
    throw new Error(
      `missing golden file ${path}; create it with UPDATE_GOLDEN=1 deno task test`,
    );
  }
  if (existing === rendered) return;

  // Compare parsed values so the failure reads as a data diff.
  assertEquals(
    actual,
    JSON.parse(existing),
    `golden mismatch for ${path}; run UPDATE_GOLDEN=1 deno task test to accept`,
  );
  // Same data, different formatting: normalise the file when asked to.
  assertEquals(
    rendered,
    existing,
    `golden file ${path} is formatted differently; run UPDATE_GOLDEN=1 deno task test`,
  );
}

export interface GoldenCase {
  name: string;
  dir: string;
  file(name: string): string;
  json<T = unknown>(name: string): Promise<T>;
}

/**
 * Every directory under `tests/golden/<group>/` is one case, so adding a case
 * is adding a directory.
 */
export async function goldenCases(group: string): Promise<GoldenCase[]> {
  const root = join(GOLDEN_ROOT, group);
  const cases: GoldenCase[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    const dir = join(root, entry.name);
    cases.push({
      name: entry.name,
      dir,
      file: (name: string) => join(dir, name),
      json: async <T>(name: string) =>
        JSON.parse(await Deno.readTextFile(join(dir, name))) as T,
    });
  }
  cases.sort((a, b) => a.name.localeCompare(b.name));
  if (cases.length === 0) {
    throw new Error(`no golden cases under tests/golden/${group}`);
  }
  return cases;
}
