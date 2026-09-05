import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  hashFileStreaming,
  ModelHasher,
  unchanged,
} from "../../src/models/hasher.ts";
import { decodePathId, pathId } from "../../src/models/library.ts";
import { ModelScanner, type ScannedModel } from "../../src/models/scan.ts";
import type { ModelRow } from "../../src/db/queries.ts";
import { openDatabase } from "../../src/db/db.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { sha256Of, writeFakeSafetensors } from "../fixtures/models.ts";

/** A model folder with two checkpoints and a LoRA in a subdirectory. */
async function modelFolders(): Promise<
  { dir: string; checkpoints: string; loras: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-models-" });
  const checkpoints = join(dir, "checkpoints");
  const loras = join(dir, "loras");
  await writeFakeSafetensors(join(checkpoints, "sd15.safetensors"), {
    name: "sd15",
  });
  await writeFakeSafetensors(join(checkpoints, "anima.ckpt"), {
    name: "anima",
    bytes: 2048,
  });
  await writeFakeSafetensors(join(loras, "film", "grain-35mm.safetensors"), {
    name: "grain",
  });
  return { dir, checkpoints, loras };
}

function scannerFor(folders: Record<string, string[]>): ModelScanner {
  const config = defaultConfig();
  config.model_folders = folders;
  return new ModelScanner(() => config, 0);
}

Deno.test("the streaming hash matches the whole file's sha256", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-hash-" });
  try {
    const path = join(dir, "big.safetensors");
    // Two megabytes: more than one read, so the chunk loop is exercised.
    const bytes = await writeFakeSafetensors(path, {
      name: "big",
      bytes: 2 * 1024 * 1024,
    });
    const seen: number[] = [];
    const hash = await hashFileStreaming(path, (read) => seen.push(read));
    assertEquals(hash, await sha256Of(bytes));
    assert(seen.length > 1, `expected several reads, saw ${seen.length}`);
    assertEquals(seen.at(-1), bytes.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a scan registers every kind by path, and reports progress", async () => {
  const { dir, checkpoints, loras } = await modelFolders();
  try {
    const scanner = scannerFor({
      checkpoints: [checkpoints],
      loras: [loras],
      vae: [join(dir, "missing")],
    });
    const progress: number[] = [];
    const result = await scanner.rescan((p) => progress.push(p.models));

    assertEquals(result.models.length, 3);
    assertEquals(scanner.registry.size, 3);
    assertEquals(
      [...scanner.registry.values()].map((model) => model.name).sort(),
      ["anima.ckpt", "film/grain-35mm.safetensors", "sd15.safetensors"],
    );
    // A folder that is not there is empty, not an error (§11.2).
    assertEquals(
      [...scanner.registry.values()].filter((m) => m.kind === "vae"),
      [],
    );
    assertEquals(scanner.progress.running, false);
    assertEquals(scanner.progress.models, 3);
    assertEquals(scanner.progress.folders_total, 3);
    assertEquals(progress.at(-1), 3);

    // Rescanning after a deletion drops the model from the registry.
    await Deno.remove(join(checkpoints, "anima.ckpt"));
    await scanner.rescan();
    assertEquals(scanner.registry.size, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("re-hashing is skipped unless path, size or mtime changed", async () => {
  const { dir, checkpoints } = await modelFolders();
  const dbDir = await Deno.makeTempDir({ prefix: "forgeui-hasher-" });
  const db = openDatabase(join(dbDir, "app.db"));
  try {
    const scanner = scannerFor({ checkpoints: [checkpoints] });
    const hashed: { name: string; fresh: boolean }[] = [];
    const hasher = new ModelHasher({
      db,
      onHashed: ({ model, fresh }) => {
        hashed.push({ name: model.name, fresh });
      },
    });

    hasher.enqueue((await scanner.rescan()).models);
    hasher.start();
    await hasher.idle();
    assertEquals(hashed.filter((entry) => entry.fresh).length, 2);
    assertEquals(hasher.progress.done, 2);
    assertEquals(hasher.progress.running, false);

    // Nothing changed: the second pass reads no bytes at all.
    hashed.length = 0;
    hasher.enqueue((await scanner.rescan()).models);
    hasher.start();
    await hasher.idle();
    assertEquals(hashed.map((entry) => entry.fresh), [false, false]);
    assertEquals(hasher.progress.done, 2, "no new work was queued");

    // A rewritten file has a new mtime, and is hashed again.
    await writeFakeSafetensors(join(checkpoints, "sd15.safetensors"), {
      name: "sd15-v2",
      bytes: 4096,
    });
    hashed.length = 0;
    hasher.enqueue((await scanner.rescan()).models);
    hasher.start();
    await hasher.idle();
    assertEquals(
      hashed.filter((entry) => entry.fresh).map((entry) => entry.name),
      ["sd15.safetensors"],
    );

    // One row per path, even though the hash changed.
    assertEquals(
      db.prepare("SELECT count(*) FROM models").value<[number]>()?.[0],
      2,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(dbDir, { recursive: true });
  }
});

Deno.test("a file that cannot be read is recorded, not fatal", async () => {
  const { dir, checkpoints } = await modelFolders();
  const dbDir = await Deno.makeTempDir({ prefix: "forgeui-hasher-" });
  const db = openDatabase(join(dbDir, "app.db"));
  try {
    const scanner = scannerFor({ checkpoints: [checkpoints] });
    const models = (await scanner.rescan()).models;
    const hasher = new ModelHasher({
      db,
      hashFile: (path) =>
        path.endsWith("anima.ckpt")
          ? Promise.reject(new Error("permission denied"))
          : Promise.resolve("a".repeat(64)),
    });
    hasher.enqueue(models);
    hasher.start();
    await hasher.idle();

    assertEquals(hasher.progress.done, 2);
    assertEquals([...hasher.failures.values()], ["permission denied"]);
    assertEquals(
      db.prepare("SELECT count(*) FROM models").value<[number]>()?.[0],
      1,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(dbDir, { recursive: true });
  }
});

Deno.test("an unhashed model is addressed by its path", () => {
  const path = "/models/checkpoints/a model (v2).safetensors";
  const id = pathId(path);
  assert(id.startsWith("path:"));
  assert(!id.includes("/"), "the id has to survive a URL path segment");
  assertEquals(decodePathId(id), path);
  assertEquals(decodePathId("sha256hash"), null);
});

Deno.test("the re-hash decision compares path, size and mtime", () => {
  const row: ModelRow = {
    hash: "abc",
    path: "/m/a.safetensors",
    kind: "checkpoints",
    size: 100,
    mtime: 42,
    display_name: null,
    family: null,
    notes: null,
    tags: [],
    thumb_path: null,
    output_count: 0,
    last_used_at: null,
    last_seen_at: 0,
  };
  const model: ScannedModel = {
    path: "/m/a.safetensors",
    name: "a.safetensors",
    filename: "a.safetensors",
    display_name: "a",
    family: "unset",
    kind: "checkpoints",
    size: 100,
    mtime: 42,
  };
  assert(unchanged(row, model));
  assert(!unchanged(row, { ...model, size: 101 }));
  assert(!unchanged(row, { ...model, mtime: 43 }));
  assert(!unchanged(row, { ...model, path: "/m/b.safetensors" }));
  // A file the scanner could not stat is not the file that was hashed.
  assert(!unchanged(row, { ...model, mtime: null }));
});
