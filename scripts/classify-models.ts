/**
 * Reads the header of every safetensors file under the given directories and
 * reports what each one actually contains: a diffusion model, a text encoder,
 * a VAE, or some combination.
 *
 * The question it answers: do you own both all-in-one checkpoints and
 * split-file diffusion models of the same architecture? That is the only
 * case that needs a workflow to change its loader nodes at generate time.
 *
 *   deno run --allow-read scripts/classify-models.ts ~/models
 *   deno run --allow-read scripts/classify-models.ts ~/models/checkpoints ~/models/unet
 *
 * Reads only each file's header — a few hundred kilobytes at most, never the
 * weights — so it is fast even over a folder of many multi-gigabyte files.
 */

import { basename, extname, join, relative, resolve } from "@std/path";

/** A safetensors file is: u64 LE header length, then that many bytes of JSON. */
async function readHeader(path: string): Promise<Record<string, unknown>> {
  const file = await Deno.open(path, { read: true });
  try {
    const lengthBytes = await readExactly(file, 8);
    const length = Number(
      new DataView(lengthBytes.buffer).getBigUint64(0, true),
    );
    // A header is JSON describing the tensors; anything gigantic is not one.
    if (length <= 0 || length > 400_000_000) {
      throw new Error(`implausible header length ${length}`);
    }
    const json = await readExactly(file, length);
    return JSON.parse(new TextDecoder().decode(json));
  } finally {
    file.close();
  }
}

async function readExactly(
  file: Deno.FsFile,
  count: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(count);
  let filled = 0;
  while (filled < count) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) throw new Error("file ended early");
    filled += read;
  }
  return buffer;
}

interface Parts {
  diffusion: boolean;
  clip: boolean;
  vae: boolean;
  lora: boolean;
}

/**
 * Which components the tensor names say are present. The prefixed forms are
 * what an all-in-one checkpoint uses; the bare forms are what a file holding
 * one component alone uses.
 */
function classify(keys: string[]): Parts {
  const any = (...prefixes: string[]) =>
    keys.some((key) => prefixes.some((prefix) => key.startsWith(prefix)));

  const lora = keys.some((key) =>
    key.includes("lora_up.") || key.includes("lora_down.") ||
    key.includes(".lora_A.") || key.includes(".lora_B.") ||
    key.startsWith("lora_unet_") || key.startsWith("lora_te")
  );

  const diffusion = any(
    "model.diffusion_model.", // sd1.5 / sdxl / ltx inside a checkpoint
    "diffusion_model.",
    "double_blocks.", // flux
    "single_blocks.",
    "input_blocks.", // a bare sd/sdxl unet
    "output_blocks.",
    "joint_blocks.", // sd3 / mmdit
    "transformer_blocks.",
  );

  const clip = any(
    "cond_stage_model.", // sd1.5 inside a checkpoint
    "conditioner.embedders.", // sdxl inside a checkpoint
    "text_model.", // a bare clip-l / clip-g
    "encoder.block.", // a bare t5 — note `encoder.down.` below is a vae
    "text_encoders.",
  ) ||
    // llama / gemma / qwen text encoders
    (any("model.layers.") && !any("model.diffusion_model."));

  const vae = any(
    "first_stage_model.", // inside a checkpoint
    "encoder.down.", // a bare AutoencoderKL
    "decoder.up.",
    "post_quant_conv.",
    "quant_conv.",
  );

  return { diffusion, clip, vae, lora };
}

type Verdict =
  | "ALL-IN-ONE"
  | "split-file"
  | "text encoder"
  | "vae"
  | "lora"
  | "partial"
  | "unknown";

function verdictOf(parts: Parts): Verdict {
  if (parts.lora) return "lora";
  if (parts.diffusion && parts.clip && parts.vae) return "ALL-IN-ONE";
  if (parts.diffusion && !parts.clip && !parts.vae) return "split-file";
  if (parts.diffusion) return "partial";
  if (parts.clip && !parts.vae) return "text encoder";
  if (parts.vae && !parts.clip) return "vae";
  return "unknown";
}

const SAFETENSORS = new Set([".safetensors", ".sft"]);

async function* walk(root: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch (error) {
    console.error(`  ! cannot read ${root}: ${(error as Error).message}`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (SAFETENSORS.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

function held(parts: Parts): string {
  const names = [
    parts.diffusion ? "MODEL" : null,
    parts.clip ? "CLIP" : null,
    parts.vae ? "VAE" : null,
  ].filter((name) => name !== null);
  return names.length === 0 ? "—" : names.join("+");
}

async function main() {
  const roots = Deno.args.length > 0 ? Deno.args : ["."];
  const counts = new Map<string, number>();
  const rows: { name: string; verdict: Verdict; parts: string }[] = [];
  let failed = 0;

  for (const root of roots) {
    const absolute = resolve(root);
    console.log(`\nscanning ${absolute}`);
    for await (const path of walk(absolute)) {
      const name = relative(absolute, path) || basename(path);
      try {
        const header = await readHeader(path);
        const keys = Object.keys(header).filter((key) =>
          key !== "__metadata__"
        );
        const parts = classify(keys);
        const verdict = verdictOf(parts);
        rows.push({ name, verdict, parts: held(parts) });
        counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
      } catch (error) {
        rows.push({
          name,
          verdict: "unknown",
          parts: (error as Error).message,
        });
        failed++;
      }
    }
  }

  if (rows.length === 0) {
    console.log("no .safetensors files found");
    return;
  }

  const width = Math.min(70, Math.max(...rows.map((row) => row.name.length)));
  console.log("");
  for (const row of rows) {
    const name = row.name.length > width
      ? "…" + row.name.slice(row.name.length - width + 1)
      : row.name.padEnd(width);
    console.log(`${name}  ${row.verdict.padEnd(12)}  ${row.parts}`);
  }

  console.log(`\n${rows.length} file(s)`);
  for (const [verdict, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${verdict}`);
  }
  if (failed > 0) console.log(`  ${String(failed).padStart(4)}  unreadable`);

  const allInOne = counts.get("ALL-IN-ONE") ?? 0;
  const split = counts.get("split-file") ?? 0;
  console.log("");
  if (allInOne > 0 && split > 0) {
    console.log(
      `You have both kinds: ${allInOne} all-in-one and ${split} split-file.`,
    );
    console.log(
      "Whether that matters depends on if any two are the same architecture —",
    );
    console.log(
      "swapping between those is the case that needs a loader change.",
    );
  } else if (split > 0) {
    console.log(
      `Every diffusion model here is split-file (${split}). One fixed`,
    );
    console.log(
      "UNETLoader + CLIPLoader + VAELoader shape covers all of them.",
    );
  } else if (allInOne > 0) {
    console.log(
      `Every diffusion model here is all-in-one (${allInOne}). One fixed`,
    );
    console.log("CheckpointLoaderSimple shape covers all of them.");
  }
}

if (import.meta.main) await main();
