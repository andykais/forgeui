/**
 * What architecture a model file holds, read from its safetensors header
 * (§6). A `.safetensors` file starts with a u64 little-endian header length
 * followed by that many bytes of JSON naming every tensor and its shape, so
 * this costs one open and one short read — nothing beside the full-file
 * sha256 the hasher does, and cheap enough to run at scan time.
 *
 * The discriminators are taken from ComfyUI's own `comfy/model_detection.py`
 * (v0.34.0, the version `scripts/setup-comfy.sh` pins), so the family this
 * reports and the model ComfyUI will actually build agree. When nothing
 * matches the answer is `null`: a wrong family is worse than none, and §6
 * makes detection an improvement to the picker's ordering rather than
 * something it depends on.
 */

/** Tensor names, and the shape of each, as the header records them. */
export interface Header {
  names: Set<string>;
  shape: (name: string) => number[] | null;
}

/** A header is JSON describing tensors; anything gigantic is not one. */
const MAX_HEADER_BYTES = 400_000_000;

export class ProbeError extends Error {
  override readonly name = "ProbeError";
}

async function readExactly(
  file: Deno.FsFile,
  count: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(count);
  let filled = 0;
  while (filled < count) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) throw new ProbeError("the file ended early");
    filled += read;
  }
  return buffer;
}

export async function readHeader(path: string): Promise<Header> {
  const file = await Deno.open(path, { read: true });
  try {
    const lengthBytes = await readExactly(file, 8);
    const length = Number(
      new DataView(lengthBytes.buffer).getBigUint64(0, true),
    );
    if (length <= 0 || length > MAX_HEADER_BYTES) {
      throw new ProbeError(`implausible header length ${length}`);
    }
    const json = await readExactly(file, length);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(json));
    } catch {
      throw new ProbeError("the header is not JSON");
    }
    return headerOf(parsed);
  } finally {
    file.close();
  }
}

export function headerOf(parsed: Record<string, unknown>): Header {
  const names = new Set<string>();
  for (const key of Object.keys(parsed)) {
    if (key !== "__metadata__") names.add(key);
  }
  return {
    names,
    shape: (name) => {
      const entry = parsed[name];
      if (typeof entry !== "object" || entry === null) return null;
      const shape = (entry as { shape?: unknown }).shape;
      if (!Array.isArray(shape)) return null;
      return shape.every((n) => typeof n === "number")
        ? shape as number[]
        : null;
    },
  };
}

/**
 * The prefix a diffusion model's tensors carry. An all-in-one checkpoint
 * nests them under `model.diffusion_model.`; a file holding only the
 * diffusion model names them bare. Mirrors `unet_prefix_from_state_dict`.
 */
function diffusionPrefix(names: Set<string>): string {
  for (const candidate of ["model.diffusion_model.", "model.model.", "net."]) {
    for (const name of names) {
      if (name.startsWith(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * `key_norm` weights are stored as `weight` on most files and `scale` on
 * quantised ones, which is what ComfyUI's `any_suffix_in` is working around.
 */
function anySuffix(has: (name: string) => boolean, stem: string): boolean {
  return has(`${stem}weight`) || has(`${stem}scale`);
}

/**
 * The family a file belongs to, or `null` when nothing matches. Ordered
 * most-specific first, exactly as `detect_unet_config` is.
 */
export function detectFamily(header: Header): string | null {
  const prefix = diffusionPrefix(header.names);
  const has = (name: string) => header.names.has(`${prefix}${name}`);
  const shape = (name: string) => header.shape(`${prefix}${name}`);

  // Krea 2 (K2), which is not a Flux model despite the shared brand.
  if (has("txtfusion.projector.weight")) return "krea2";

  // Flux, Flux.2 and Chroma all lead with the same double-block key norm.
  if (
    anySuffix(has, "double_blocks.0.img_attn.norm.key_norm.") &&
    (has("img_in.weight") ||
      anySuffix(has, "distilled_guidance_layer.norms.0."))
  ) {
    if (has("double_stream_modulation_img.lin.weight")) return "flux2";
    if (
      anySuffix(has, "distilled_guidance_layer.norms.0.") ||
      anySuffix(has, "distilled_guidance_layer.0.norms.0.")
    ) {
      return "chroma";
    }
    return "flux";
  }

  // Lightricks LTX. The audio adaln is what separates LTX-2 from 0.9.x, and
  // it is the generational split §6 asks families to carry.
  if (has("adaln_single.emb.timestep_embedder.linear_1.bias")) {
    return has("audio_adaln_single.linear.weight") ? "ltx-2" : "ltx";
  }

  // Anima is a Cosmos-Predict2 graph with an LLM adapter bolted on.
  if (
    has("blocks.0.mlp.layer1.weight") &&
    has("llm_adapter.blocks.0.cross_attn.q_proj.weight")
  ) {
    return "anima";
  }

  // Z-Image is Lumina 2 at a wider hidden size; the width is the only tell.
  if (
    has("cap_embedder.1.weight") &&
    has("noise_refiner.0.attention.k_norm.weight")
  ) {
    return shape("cap_embedder.1.weight")?.[0] === 3840 ? "z-image" : null;
  }

  // The original UNet line. SDXL carries the size-conditioning embedding
  // that SD 1.5 has no use for.
  if (has("input_blocks.0.0.weight")) {
    return has("label_emb.0.0.weight") ? "sdxl" : "sd15";
  }

  return null;
}

/** Read a file and say what it is; `null` for anything unrecognised. */
export async function probeFamily(path: string): Promise<string | null> {
  return detectFamily(await readHeader(path));
}
