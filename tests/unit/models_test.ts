import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  hashFileStreaming,
  ModelHasher,
  unchanged,
} from "../../src/models/hasher.ts";
import { decodePathId, needsProbe, pathId } from "../../src/models/library.ts";
import { DETECTOR_VERSION } from "../../src/models/probe.ts";
import { ModelScanner, type ScannedModel } from "../../src/models/scan.ts";
import type { ModelRow } from "../../src/db/queries.ts";
import { openDatabase } from "../../src/db/db.ts";
import { classOf, DIFFUSION_KINDS } from "../../src/config/defaults.ts";
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
    // The counters describe the pass that just ran, not every pass ever: a
    // pass with nothing to do is 0 of 0. Carrying the last pass's totals over
    // is what made a second rescan report "74/86".
    assertEquals(hasher.progress.total, 0, "no new work was queued");
    assertEquals(hasher.progress.done, 0);

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
    // One file changed, so this pass is one of one — not three of three.
    assertEquals(hasher.progress.done, 1);
    assertEquals(hasher.progress.total, 1);

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

Deno.test("the queue is smallest first, so small files gain an identity", async () => {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-order-" });
  const dbDir = await Deno.makeTempDir({ prefix: "forgeui-hasher-" });
  const db = openDatabase(join(dbDir, "app.db"));
  try {
    // Folder order would hash the checkpoints first and leave the LoRAs
    // without an identity for as long as that took; size order does not.
    await writeFakeSafetensors(join(dir, "checkpoints", "big-a.safetensors"), {
      name: "big-a",
      bytes: 64 * 1024,
    });
    await writeFakeSafetensors(join(dir, "checkpoints", "big-b.safetensors"), {
      name: "big-b",
      bytes: 32 * 1024,
    });
    await writeFakeSafetensors(join(dir, "loras", "small-a.safetensors"), {
      name: "small-a",
      bytes: 1024,
    });
    await writeFakeSafetensors(join(dir, "loras", "small-b.safetensors"), {
      name: "small-b",
      bytes: 2048,
    });
    const scanner = scannerFor({
      checkpoints: [join(dir, "checkpoints")],
      loras: [join(dir, "loras")],
    });
    const order: string[] = [];
    const hasher = new ModelHasher({
      db,
      onHashed: ({ model }) => {
        order.push(model.name);
      },
    });
    hasher.enqueue((await scanner.rescan()).models);
    hasher.start();
    await hasher.idle();

    assertEquals(order, [
      "small-a.safetensors",
      "small-b.safetensors",
      "big-b.safetensors",
      "big-a.safetensors",
    ]);
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
    strength_min: null,
    strength_max: null,
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

Deno.test("every folder a diffusion model can live in is one class", () => {
  // The four folders SwarmUI treats as one "Model" (§1).
  for (
    const kind of [
      "checkpoints",
      "Stable-Diffusion",
      "diffusion_models",
      "unet",
    ]
  ) {
    assertEquals(classOf(kind), "diffusion", kind);
    assert(DIFFUSION_KINDS.includes(kind), `${kind} is not pooled`);
  }
  assertEquals(classOf("loras"), "lora");
  assertEquals(classOf("text_encoders"), "clip");
  assertEquals(classOf("clip"), "clip");
  assertEquals(classOf("latent_upscale_models"), "upscale");
  // An unknown kind is not an error: a folder may point anywhere.
  assertEquals(classOf("gligen"), "other");
  // The config override wins over the table.
  assertEquals(classOf("gligen", { gligen: "diffusion" }), "diffusion");
  assertEquals(classOf("checkpoints", { checkpoints: "other" }), "other");
});

Deno.test("a header is re-read when the file moves or the detector does", () => {
  const file = { size: 4096, mtime: 1_780_000_000_000 };
  const probed = {
    path: "/models/checkpoints/sd15.safetensors",
    size: file.size,
    mtime: file.mtime,
    arch: "sd15",
    detector: DETECTOR_VERSION,
    probed_at: 1_780_000_000_000,
  };

  // Nothing has moved: the cached answer stands, which is what keeps a
  // rescan of a full model folder cheap.
  assertEquals(needsProbe(probed, file), false);
  // Never read at all.
  assertEquals(needsProbe(undefined, file), true);
  // The file changed under us.
  assertEquals(needsProbe(probed, { ...file, size: 8192 }), true);
  assertEquals(needsProbe(probed, { ...file, mtime: 1 }), true);
  // The file is the same, but the answer came from a detector that had not
  // heard of the families this one knows. Without this a family added in a
  // later build never reached a model already on disk: the user rescanned,
  // and nothing changed.
  assertEquals(needsProbe({ ...probed, detector: 0 }, file), true);
  assertEquals(
    needsProbe({ ...probed, detector: DETECTOR_VERSION - 1 }, file),
    true,
  );
});
