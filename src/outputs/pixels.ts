import { join } from "@std/path";
import type { Database } from "../db/sqlite.ts";
import {
  inputsWithoutPixelHash,
  orphanInputs,
  outputMatching,
  outputsWithoutPixelHash,
  setInputParent,
  setInputPixelHash,
  setOutputPixelHash,
} from "../db/queries.ts";
import { pixelHash } from "../jobs/png.ts";
import type { DataPaths } from "../config/paths.ts";

/**
 * Pixel hashes (§9): how a pasted picture finds the output it came from.
 * A paste is the browser's re-encoding of the picture, so its bytes match no
 * output's while its pixels match exactly one — or several, when a rerun made
 * the same picture again, in which case the earliest is the parent.
 *
 * The hash is a cache of the media, never a record: '' marks a file that has
 * none (not a PNG, or one the decoder will not read), so it is not tried
 * again on every boot.
 */

/** The pixel hash of a file on disk, or '' when it cannot have one. */
export async function pixelHashOf(path: string): Promise<string> {
  try {
    return (await pixelHash(await Deno.readFile(path))) ?? "";
  } catch {
    return "";
  }
}

/** Hash one output's file and keep it. */
export async function hashOutput(
  db: Database,
  paths: DataPaths,
  output: { id: string; path: string },
): Promise<void> {
  setOutputPixelHash(
    db,
    output.id,
    await pixelHashOf(join(paths.root, output.path)),
  );
}

/**
 * Everything made or attached before pixel hashes existed (migration 14):
 * every image output hashed, then every input, and then every input with no
 * parent yet matched against them — which is how the pastes that lost their
 * history get it back. Batched, and yielding between files, because it reads
 * a gallery's worth of pictures and the server is answering meanwhile.
 */
export async function backfillPixelHashes(
  { db, paths }: { db: Database; paths: DataPaths },
): Promise<{ outputs: number; inputs: number; parents: number }> {
  const done = { outputs: 0, inputs: 0, parents: 0 };
  for (;;) {
    const batch = outputsWithoutPixelHash(db, 50);
    if (batch.length === 0) break;
    for (const output of batch) {
      await hashOutput(db, paths, output);
      done.outputs++;
      await breathe();
    }
  }
  for (;;) {
    const batch = inputsWithoutPixelHash(db, 50);
    if (batch.length === 0) break;
    for (const input of batch) {
      setInputPixelHash(
        db,
        input.sha256,
        await pixelHashOf(join(paths.root, input.path)),
      );
      done.inputs++;
      await breathe();
    }
  }
  for (const input of orphanInputs(db)) {
    const parent = outputMatching(db, input);
    if (!parent) continue;
    setInputParent(db, input.sha256, parent);
    done.parents++;
  }
  return done;
}

function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
