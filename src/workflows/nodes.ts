/**
 * The slice of ComfyUI's node schema the app needs to know by itself: output
 * slot names (so a manifest can say `1.MODEL` instead of `["1", 0]`) and
 * widget order (so a LiteGraph document can be rebuilt from an api graph).
 *
 * Only core ComfyUI nodes are listed — the bundled workflows are held to
 * these (§4.6). Anything else is handled generically: manifests can address
 * an output by index (`12.0`) and unknown widget order falls back to the
 * order the inputs appear in the graph.
 */

export interface NodeSchema {
  /** Inputs fed by links, in the order the editor shows them. */
  inputs?: string[];
  /** Inputs shown as widgets, in the order their values are serialised. */
  widgets?: string[];
  /**
   * UI-only widgets the editor inserts after a named widget, e.g. the
   * `control_after_generate` combo that follows a seed.
   */
  after?: Record<string, string | number | boolean>;
  /** Output slot names, in slot order. */
  outputs?: string[];
  /** Writes files; a prompt is queued for these (§5 step 3). */
  output?: boolean;
}

export const CORE_NODES: Record<string, NodeSchema> = {
  CheckpointLoaderSimple: {
    widgets: ["ckpt_name"],
    outputs: ["MODEL", "CLIP", "VAE"],
  },
  UNETLoader: {
    widgets: ["unet_name", "weight_dtype"],
    outputs: ["MODEL"],
  },
  CLIPLoader: {
    widgets: ["clip_name", "type", "device"],
    outputs: ["CLIP"],
  },
  DualCLIPLoader: {
    widgets: ["clip_name1", "clip_name2", "type", "device"],
    outputs: ["CLIP"],
  },
  VAELoader: {
    widgets: ["vae_name"],
    outputs: ["VAE"],
  },
  LoraLoader: {
    inputs: ["model", "clip"],
    widgets: ["lora_name", "strength_model", "strength_clip"],
    outputs: ["MODEL", "CLIP"],
  },
  LoraLoaderModelOnly: {
    inputs: ["model"],
    widgets: ["lora_name", "strength_model"],
    outputs: ["MODEL"],
  },
  CLIPSetLastLayer: {
    inputs: ["clip"],
    widgets: ["stop_at_clip_layer"],
    outputs: ["CLIP"],
  },
  CLIPTextEncode: {
    inputs: ["clip"],
    widgets: ["text"],
    outputs: ["CONDITIONING"],
  },
  ConditioningZeroOut: {
    inputs: ["conditioning"],
    outputs: ["CONDITIONING"],
  },
  FluxGuidance: {
    inputs: ["conditioning"],
    widgets: ["guidance"],
    outputs: ["CONDITIONING"],
  },
  ModelSamplingSD3: {
    inputs: ["model"],
    widgets: ["shift"],
    outputs: ["MODEL"],
  },
  ModelSamplingAuraFlow: {
    inputs: ["model"],
    widgets: ["shift"],
    outputs: ["MODEL"],
  },
  // ---- utility nodes the official templates wire in (§7) -----------------
  // `PrimitiveInt` and `RandomNoise` carry the same `control_after_generate`
  // combo a seed does, which the editor writes into `widgets_values` too.
  PrimitiveInt: {
    widgets: ["value"],
    after: { value: "fixed" },
    outputs: ["INT"],
  },
  PrimitiveFloat: {
    widgets: ["value"],
    outputs: ["FLOAT"],
  },
  PrimitiveBoolean: {
    widgets: ["value"],
    outputs: ["BOOLEAN"],
  },
  PrimitiveStringMultiline: {
    widgets: ["value"],
    outputs: ["STRING"],
  },
  ComfySwitchNode: {
    inputs: ["on_false", "on_true"],
    widgets: ["switch"],
    outputs: ["output"],
  },
  ResolutionSelector: {
    widgets: ["aspect_ratio", "megapixels", "multiple"],
    outputs: ["INT", "INT"],
  },
  // ---- the Flux.2 custom sampler chain -----------------------------------
  KSamplerSelect: {
    widgets: ["sampler_name"],
    outputs: ["SAMPLER"],
  },
  Flux2Scheduler: {
    widgets: ["steps", "width", "height"],
    outputs: ["SIGMAS"],
  },
  CFGGuider: {
    inputs: ["model", "positive", "negative"],
    widgets: ["cfg"],
    outputs: ["GUIDER"],
  },
  RandomNoise: {
    widgets: ["noise_seed"],
    after: { noise_seed: "randomize" },
    outputs: ["NOISE"],
  },
  SamplerCustomAdvanced: {
    inputs: ["noise", "guider", "sampler", "sigmas", "latent_image"],
    outputs: ["output", "denoised_output"],
  },
  EmptyFlux2LatentImage: {
    widgets: ["width", "height", "batch_size"],
    outputs: ["LATENT"],
  },
  EmptyLatentImage: {
    widgets: ["width", "height", "batch_size"],
    outputs: ["LATENT"],
  },
  EmptySD3LatentImage: {
    widgets: ["width", "height", "batch_size"],
    outputs: ["LATENT"],
  },
  EmptyLTXVLatentVideo: {
    widgets: ["width", "height", "length", "batch_size"],
    outputs: ["LATENT"],
  },
  LTXVConditioning: {
    inputs: ["positive", "negative"],
    widgets: ["frame_rate"],
    outputs: ["CONDITIONING", "CONDITIONING"],
  },
  KSampler: {
    inputs: ["model", "positive", "negative", "latent_image"],
    widgets: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    after: { seed: "randomize" },
    outputs: ["LATENT"],
  },
  KSamplerAdvanced: {
    inputs: ["model", "positive", "negative", "latent_image"],
    widgets: [
      "add_noise",
      "noise_seed",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "start_at_step",
      "end_at_step",
      "return_with_leftover_noise",
    ],
    after: { noise_seed: "randomize" },
    outputs: ["LATENT"],
  },
  LoadImage: {
    widgets: ["image"],
    after: { image: "image" },
    outputs: ["IMAGE", "MASK"],
  },
  ImageScale: {
    inputs: ["image"],
    widgets: ["upscale_method", "width", "height", "crop"],
    outputs: ["IMAGE"],
  },
  VAEEncode: {
    inputs: ["pixels", "vae"],
    outputs: ["LATENT"],
  },
  VAEDecode: {
    inputs: ["samples", "vae"],
    outputs: ["IMAGE"],
  },
  SaveImage: {
    inputs: ["images"],
    widgets: ["filename_prefix"],
    output: true,
  },
  SaveAnimatedWEBP: {
    inputs: ["images"],
    widgets: ["filename_prefix", "fps", "lossless", "quality", "method"],
    output: true,
  },
};

export const CORE_NODE_TYPES: readonly string[] = Object.keys(CORE_NODES);

export const OUTPUT_NODE_TYPES: readonly string[] = Object.entries(CORE_NODES)
  .filter(([, schema]) => schema.output)
  .map(([type]) => type);

export function isOutputNodeType(classType: string): boolean {
  return CORE_NODES[classType]?.output === true;
}

/**
 * Resolve `MODEL` / `CLIP` / … to a slot index for a node type. A numeric
 * name is taken as the index itself, which is the escape hatch for nodes the
 * app has no schema for.
 */
export function outputSlot(
  classType: string,
  outputName: string,
): number | null {
  if (/^\d+$/.test(outputName)) return Number(outputName);
  const outputs = CORE_NODES[classType]?.outputs;
  if (!outputs) return null;
  const index = outputs.indexOf(outputName);
  return index < 0 ? null : index;
}
