import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  assertGoldenJson,
  goldenCases,
  updatingGolden,
} from "../golden/runner.ts";

async function withUpdateGolden(body: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("UPDATE_GOLDEN");
  Deno.env.set("UPDATE_GOLDEN", "1");
  try {
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete("UPDATE_GOLDEN");
    else Deno.env.set("UPDATE_GOLDEN", previous);
  }
}

async function withoutUpdateGolden(body: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("UPDATE_GOLDEN");
  Deno.env.delete("UPDATE_GOLDEN");
  try {
    await body();
  } finally {
    if (previous !== undefined) Deno.env.set("UPDATE_GOLDEN", previous);
  }
}

async function withTempDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-golden-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a missing golden file fails instead of being created", async () => {
  await withoutUpdateGolden(async () => {
    assertEquals(updatingGolden(), false);
    await withTempDir(async (dir) => {
      const path = join(dir, "expected.json");
      await assertRejects(
        () => assertGoldenJson(path, { a: 1 }),
        Error,
        "missing golden file",
      );
      await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    });
  });
});

Deno.test("UPDATE_GOLDEN=1 writes the file, then it compares clean", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "expected.json");
    await withUpdateGolden(async () => {
      assert(updatingGolden());
      await assertGoldenJson(path, { b: [1, 2], a: "x" });
    });
    assertEquals(
      await Deno.readTextFile(path),
      '{\n  "b": [\n    1,\n    2\n  ],\n  "a": "x"\n}\n',
    );
    await withoutUpdateGolden(async () => {
      await assertGoldenJson(path, { b: [1, 2], a: "x" });
    });
  });
});

Deno.test("a changed value fails the comparison", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "expected.json");
    await withUpdateGolden(() => assertGoldenJson(path, { seed: 1 }));
    await withoutUpdateGolden(async () => {
      await assertRejects(
        () => assertGoldenJson(path, { seed: 2 }),
        Error,
        "golden mismatch",
      );
    });
  });
});

Deno.test("cases are discovered from directories, sorted", async () => {
  const cases = await goldenCases("sidecar");
  assertEquals(cases.map((c) => c.name), ["image-output", "imported-sample"]);
  assert(cases[0]!.file("init.json").endsWith("image-output/init.json"));
  await assertRejects(() => goldenCases("nope"), Deno.errors.NotFound);
});
