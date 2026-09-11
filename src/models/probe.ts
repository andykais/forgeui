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

/**
 * Bumped whenever anything below changes what a file is called. A probe row
 * records the version that wrote it, so a scan re-reads every header the old
 * detector answered rather than trusting a cache the new one disagrees with.
 * Without it, adding a family fixed nothing for anybody who already had those
 * models: their answers were decided once, by a build that had never heard of
 * it, and no rescan would look again.
 *
 * 1. the families through `sd15`
 * 2. `wan2` and `qwen-image`
 */
export const DETECTOR_VERSION = 2;

/** Tensor names, the shape of each, and what the file says about itself. */
export interface Header {
  names: Set<string>;
  shape: (name: string) => number[] | null;
  /** `__metadata__`, string values only; empty when the file carries none. */
  metadata: Record<string, string>;
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
  const metadata: Record<string, string> = {};
  const raw = parsed.__metadata__;
  if (typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") metadata[key] = value;
    }
  }
  return {
    names,
    metadata,
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

  // Wan. `head.modulation` is the whole test in ComfyUI, and it is the same
  // test for 2.1 and 2.2 — one family, as §8.1 says.
  if (has("head.modulation")) return "wan2";

  // Qwen-Image. `txt_norm.weight` alone is the tell, which is why ComfyUI
  // asks it near-last; Mage-Flow carries the same key at a narrower width,
  // and the two shapes are what separate them.
  if (has("txt_norm.weight")) {
    const mageFlow = shape("txt_norm.weight")?.[0] === 2560 &&
      shape("proj_out.weight")?.[0] === 128;
    if (!mageFlow) return "qwen-image";
  }

  // The original UNet line. SDXL carries the size-conditioning embedding
  // that SD 1.5 has no use for.
  if (has("input_blocks.0.0.weight")) {
    return has("label_emb.0.0.weight") ? "sdxl" : "sd15";
  }

  return null;
}

/**
 * A LoRA holds no model, only deltas, so none of the discriminators above
 * appear in one. What it does carry is the name of every base-model module
 * it patches, which is the same information wearing a different hat.
 */
export function isLora(header: Header): boolean {
  for (const name of header.names) {
    if (
      name.includes("lora_up.") || name.includes("lora_down.") ||
      name.includes(".lora_A.") || name.includes(".lora_B.") ||
      name.startsWith("lora_unet_") || name.startsWith("lora_te")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * What a LoRA says it was trained against. `modelspec.architecture` is the
 * ModelSpec field the common trainers write, `ss_base_model_version` is
 * sd-scripts' own; both are declarations rather than names, so they are
 * trusted ahead of anything read off the keys. Ordered so that the narrower
 * generation wins — `flux2` before `flux`, `ltx-2` before `ltx`.
 */
const DECLARED_ARCHITECTURES: readonly [RegExp, string][] = [
  [/flux[\W_]?2|flux2/, "flux2"],
  [/chroma/, "chroma"],
  [/krea/, "krea2"],
  [/flux/, "flux"],
  [/ltx[\W_]?(video[\W_]?)?2/, "ltx-2"],
  [/ltx/, "ltx"],
  [/z[\W_]?image/, "z-image"],
  [/wan[\W_]?(video|x)?[\W_]?2|wan[\W_]?(video|x)/, "wan2"],
  [/qwen/, "qwen-image"],
  [/anima|cosmos/, "anima"],
  [/(stable[\W_]?diffusion[\W_]?xl)|sdxl/, "sdxl"],
  [/(stable[\W_]?diffusion[\W_]?v?1)|sd[\W_]?1[\W_]?5|sd_v1/, "sd15"],
];

function declaredFamily(metadata: Record<string, string>): string | null {
  for (const key of ["modelspec.architecture", "ss_base_model_version"]) {
    const declared = metadata[key]?.toLowerCase();
    if (!declared) continue;
    for (const [pattern, family] of DECLARED_ARCHITECTURES) {
      if (pattern.test(declared)) return family;
    }
  }
  return null;
}

/**
 * The family a LoRA patches, or `null`. The file's own declaration first;
 * failing that, the module names its keys are built from — a trainer writes
 * the base model's module path into every key, with `.` flattened to `_`, so
 * a substring is the safe way to read them either way round.
 */
export function detectLoraFamily(header: Header): string | null {
  const declared = declaredFamily(header.metadata);
  if (declared) return declared;

  const keys = [...header.names];
  const some = (...needles: string[]) =>
    keys.some((key) => needles.some((needle) => key.includes(needle)));

  if (some("txtfusion")) return "krea2";
  if (some("double_stream_modulation")) return "flux2";
  if (some("distilled_guidance_layer")) return "chroma";
  // Flux names its blocks `double_blocks` / `single_blocks`; the diffusers
  // conversion calls the second half `single_transformer_blocks`.
  if (some("double_blocks", "single_blocks", "single_transformer_blocks")) {
    return "flux";
  }
  if (some("llm_adapter")) return "anima";
  if (some("adaln_single")) {
    return some("audio_adaln_single") ? "ltx-2" : "ltx";
  }
  if (some("cap_embedder", "noise_refiner")) return "z-image";
  // Wan's image-conditioned blocks carry `k_img`/`v_img`, which nothing else
  // here does. Its plainer tell — `self_attn` beside `cross_attn` — waits
  // until after the UNet line, below.
  if (some("k_img", "v_img")) return "wan2";
  // Qwen-Image modulates the image and text streams separately, and that
  // pair of names is not shared by anything else in this list.
  if (some("img_mod") && some("txt_mod")) return "qwen-image";

  // The UNet line. Both generations name their blocks the same way, so the
  // tell is elsewhere: SDXL has two text encoders where SD 1.5 has one, and
  // its attention blocks are deeper than one transformer block.
  if (some("input_blocks", "output_blocks", "down_blocks", "up_blocks")) {
    const twoEncoders = keys.some((key) =>
      key.startsWith("lora_te2_") || key.includes("text_encoder_2")
    );
    const deepAttention = keys.some((key) =>
      /transformer_blocks[._](?!0[^0-9])\d+/.test(key)
    );
    return twoEncoders || deepAttention || some("label_emb") ? "sdxl" : "sd15";
  }

  // The broader tells, last, so a narrower family always answers first: an
  // SD text encoder carries `self_attn` of its own, and Mage-Flow shares
  // Qwen's `txt_norm`, so neither may be asked before the lines above.
  if (some("cross_attn") && some("self_attn")) return "wan2";
  if (some("txt_norm")) return "qwen-image";

  return null;
}

/** Read a file and say what it is; `null` for anything unrecognised. */
export async function probeFamily(path: string): Promise<string | null> {
  const header = await readHeader(path);
  return isLora(header) ? detectLoraFamily(header) : detectFamily(header);
}
