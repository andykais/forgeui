import { assertEquals, assertThrows } from "@std/assert";
import {
  allows,
  type Overwrite,
  OverwriteError,
  overwriteFlag,
  parseOverwrite,
} from "../../src/cli/overwrite.ts";

/** Every (place, part) a scope lets a run replace, as `place:part`. */
function reach(scope: Overwrite | null): string[] {
  const out: string[] = [];
  for (const place of ["fetched", "imported"] as const) {
    for (const part of ["metadata", "samples", "models"] as const) {
      if (allows(scope, place, part)) out.push(`${place}:${part}`);
    }
  }
  return out;
}

Deno.test("--overwrite scopes: places times parts (DESIGN-MODEL-IMPORT §3.2)", () => {
  const all = [
    "fetched:metadata",
    "fetched:samples",
    "fetched:models",
    "imported:metadata",
    "imported:samples",
    "imported:models",
  ];
  assertEquals(reach(parseOverwrite(undefined)), []);
  assertEquals(reach(parseOverwrite(true)), all);
  assertEquals(reach(parseOverwrite("imported")), [
    "imported:metadata",
    "imported:samples",
    "imported:models",
  ]);
  assertEquals(reach(parseOverwrite("fetched")), [
    "fetched:metadata",
    "fetched:samples",
    "fetched:models",
  ]);
  assertEquals(reach(parseOverwrite("samples")), [
    "fetched:samples",
    "imported:samples",
  ]);
  assertEquals(reach(parseOverwrite("metadata")), [
    "fetched:metadata",
    "imported:metadata",
  ]);
  assertEquals(reach(parseOverwrite("imported,samples")), ["imported:samples"]);
  assertEquals(reach(parseOverwrite("models")), [
    "fetched:models",
    "imported:models",
  ]);
  assertEquals(reach(parseOverwrite("fetched,models,samples")), [
    "fetched:samples",
    "fetched:models",
  ]);
  // Case and spaces are forgiven; an empty list is a bare flag.
  assertEquals(reach(parseOverwrite(" Imported , SAMPLES ")), [
    "imported:samples",
  ]);
  assertEquals(reach(parseOverwrite("")), all);
});

Deno.test("--overwrite refuses a word it does not know, and says which it does", () => {
  const error = assertThrows(
    () => parseOverwrite("imported,sample"),
    OverwriteError,
  );
  assertEquals(
    error.message.includes("fetched, imported, metadata, samples, models"),
    true,
  );
});

Deno.test("--overwrite is said back as it would be typed", () => {
  assertEquals(overwriteFlag(parseOverwrite(true)!), "--overwrite");
  assertEquals(
    overwriteFlag(parseOverwrite("samples,imported")!),
    "--overwrite=imported,samples",
  );
  assertEquals(
    overwriteFlag(parseOverwrite("fetched,imported,samples")!),
    "--overwrite=samples",
  );
});
