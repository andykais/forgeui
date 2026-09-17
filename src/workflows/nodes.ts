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
  /**
   * Inputs whose widget expands into several, keyed by the value selected.
   * ComfyUI calls these `DynamicCombo`: picking `on` for a sampling mode adds
   * that mode's own widgets after it, and the prompt names them
   * `<parent>.<child>` (comfy_api/latest/_io.py). The selected key decides how
   * many values the node's `widgets_values` holds, so the width cannot be
   * read from the widget list alone.
   */
  dynamic?: Record<string, Record<string, string[]>>;
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
  // Returns its input as well as showing it, so templates chain through it.
  // Not `output: true` here: that flag means "writes files" (§5 step 3), and
  // this writes none.
  PreviewAny: {
    inputs: ["source"],
    outputs: ["STRING"],
  },
  StringConcatenate: {
    widgets: ["string_a", "string_b", "delimiter"],
    outputs: ["STRING"],
  },
  // The prompt enhancer: a language model rewrites the prompt before it is
  // encoded. `sampling_mode` is a DynamicCombo — choosing `on` adds the seven
  // sampling widgets below it, named `sampling_mode.temperature` and so on.
  TextGenerate: {
    inputs: ["clip", "image", "video", "audio"],
    widgets: [
      "prompt",
      "max_length",
      "sampling_mode",
      "thinking",
      "use_default_template",
    ],
    dynamic: {
      sampling_mode: {
        on: [
          "temperature",
          "top_k",
          "top_p",
          "min_p",
          "repetition_penalty",
          "seed",
          "presence_penalty",
        ],
        off: [],
      },
    },
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

  // ---------------------------------------------------- LTX-2.3 (§4.6)
  //
  // The official image-to-video graph is an audio-video model run twice: a
  // half-resolution pass, a latent upsample, then a refine pass, with the
  // audio latent carried alongside the video one the whole way. These are the
  // classes that graph needs which nothing else here does.
  LTXAVTextEncoderLoader: {
    widgets: ["text_encoder", "ckpt_name", "device"],
    outputs: ["CLIP"],
  },
  LTXVAudioVAELoader: {
    widgets: ["ckpt_name"],
    outputs: ["AUDIO_VAE"],
  },
  LatentUpscaleModelLoader: {
    widgets: ["model_name"],
    outputs: ["LATENT_UPSCALE_MODEL"],
  },
  LTXVEmptyLatentAudio: {
    inputs: ["audio_vae"],
    widgets: ["frames_number", "frame_rate", "batch_size"],
    outputs: ["LATENT"],
  },
  /** Pairs a video latent with its audio one; the sampler moves them together. */
  LTXVConcatAVLatent: {
    inputs: ["video_latent", "audio_latent"],
    outputs: ["LATENT"],
  },
  LTXVSeparateAVLatent: {
    inputs: ["av_latent"],
    outputs: ["video_latent", "audio_latent"],
  },
  LTXVCropGuides: {
    inputs: ["positive", "negative", "latent"],
    outputs: ["CONDITIONING", "CONDITIONING", "LATENT"],
  },
  /** Writes the first frame into an existing latent, in place (§10). */
  LTXVImgToVideoInplace: {
    inputs: ["vae", "image", "latent"],
    widgets: ["strength", "bypass"],
    outputs: ["LATENT"],
  },
  LTXVPreprocess: {
    inputs: ["image"],
    widgets: ["img_compression"],
    outputs: ["IMAGE"],
  },
  LTXVLatentUpsampler: {
    inputs: ["samples", "upscale_model", "vae"],
    outputs: ["LATENT"],
  },
  LTXVAudioVAEDecode: {
    inputs: ["samples", "audio_vae"],
    outputs: ["AUDIO"],
  },
  /** The sigma schedule written out by hand, rather than built from steps. */
  ManualSigmas: {
    widgets: ["sigmas"],
    outputs: ["SIGMAS"],
  },
  /**
   * `a * b + 1`: the frame count from a duration and a frame rate. The three
   * outputs are the one answer in three types, so a binding has to say which
   * — `FLOAT` where a float is wanted, `INT` where the node downstream counts.
   */
  ComfyMathExpression: {
    inputs: ["values.a", "values.b"],
    widgets: ["expression"],
    outputs: ["FLOAT", "INT", "BOOL"],
  },
  ResizeImageMaskNode: {
    inputs: ["input"],
    widgets: ["resize_type", "scale_method"],
    dynamic: {
      resize_type: {
        "scale dimensions": ["width", "height", "crop"],
        "scale longer dimension": ["longer_size"],
        "scale shorter dimension": ["shorter_size"],
      },
    },
    outputs: ["IMAGE"],
  },
  VAEDecodeTiled: {
    inputs: ["samples", "vae"],
    widgets: ["tile_size", "overlap", "temporal_size", "temporal_overlap"],
    outputs: ["IMAGE"],
  },
  /** The prompt enhancer of the official graph; Gemma, behind a switch. */
  TextGenerateLTX2Prompt: {
    inputs: ["clip", "image", "video", "audio"],
    widgets: ["prompt", "max_length", "sampling_mode"],
    dynamic: {
      sampling_mode: {
        on: [
          "temperature",
          "top_k",
          "top_p",
          "min_p",
          "repetition_penalty",
          "seed",
          "presence_penalty",
        ],
        off: [],
      },
    },
    outputs: ["STRING"],
  },
  /** Frames plus audio into one video object; `SaveVideo` writes it. */
  CreateVideo: {
    inputs: ["images", "audio"],
    widgets: ["fps", "bit_depth", "color_space"],
    outputs: ["VIDEO"],
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
  // Scale relative to whatever came in, which is what an upscale means: the
  // output size follows the source rather than being stated up front (§10).
  ImageScaleBy: {
    inputs: ["image"],
    widgets: ["upscale_method", "scale_by"],
    outputs: ["IMAGE"],
  },
  // A real upscale model (ESRGAN and friends) rather than a pixel filter. It
  // scales by whatever factor it was trained at, so what follows brings the
  // result back to the factor that was asked for (§10).
  UpscaleModelLoader: {
    widgets: ["model_name"],
    outputs: ["UPSCALE_MODEL"],
  },
  ImageUpscaleWithModel: {
    inputs: ["upscale_model", "image"],
    outputs: ["IMAGE"],
  },
  // Flux.2 shifts its schedule by resolution, and an upscale only knows the
  // resolution once the scaler has run — so it is read off the image (§10).
  GetImageSize: {
    inputs: ["image"],
    outputs: ["width", "height", "batch_size"],
  },
  VAEEncode: {
    inputs: ["pixels", "vae"],
    outputs: ["LATENT"],
  },
  /*
   * The advanced sampling set (§10). A partial re-sample has to be expressed
   * as a slice of the model's *own* schedule, not as `KSampler.denoise`:
   * denoise builds a schedule of `steps/denoise` and keeps the tail, which
   * is a step spacing a distilled model was never trained on. These four
   * build the native schedule and cut it; `KSamplerSelect`, `RandomNoise`,
   * `CFGGuider` and `SamplerCustomAdvanced` above already sample what is left.
   */
  BasicScheduler: {
    inputs: ["model"],
    widgets: ["scheduler", "steps", "denoise"],
    outputs: ["SIGMAS"],
  },
  SplitSigmasDenoise: {
    inputs: ["sigmas"],
    widgets: ["denoise"],
    outputs: ["high_sigmas", "low_sigmas"],
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
  SaveVideo: {
    inputs: ["video"],
    widgets: ["filename_prefix", "format", "codec"],
    output: true,
  },
  SaveAnimatedWEBP: {
    inputs: ["images"],
    widgets: ["filename_prefix", "fps", "lossless", "quality", "method"],
    output: true,
  },

  // ---------------------------------------------------------------- audio
  // The generic core audio nodes (`comfy_extras/nodes_audio.py`). Every save
  // node here reports its files under ComfyUI's `audio` key rather than
  // `images`, which is the difference the app had to learn (§4.1).
  LoadAudio: {
    widgets: ["audio"],
    outputs: ["AUDIO"],
  },
  EmptyLatentAudio: {
    widgets: ["seconds", "batch_size"],
    outputs: ["LATENT"],
  },
  VAEEncodeAudio: {
    inputs: ["audio", "vae"],
    outputs: ["LATENT"],
  },
  VAEDecodeAudio: {
    inputs: ["samples", "vae"],
    outputs: ["AUDIO"],
  },
  TrimAudioDuration: {
    inputs: ["audio"],
    widgets: ["start_index", "duration"],
    outputs: ["AUDIO"],
  },
  SaveAudio: {
    inputs: ["audio"],
    widgets: ["filename_prefix"],
    outputs: ["AUDIO"],
    output: true,
  },
  SaveAudioMP3: {
    inputs: ["audio"],
    widgets: ["filename_prefix", "quality"],
    outputs: ["AUDIO"],
    output: true,
  },
  SaveAudioOpus: {
    inputs: ["audio"],
    widgets: ["filename_prefix", "quality"],
    outputs: ["AUDIO"],
    output: true,
  },
  // `format` is a DynamicCombo: flac takes no further widget, mp3 and opus
  // each add their own quality combo after it (comfy_api/latest/_io.py).
  SaveAudioAdvanced: {
    inputs: ["audio"],
    widgets: ["filename_prefix", "format"],
    dynamic: {
      format: {
        flac: [],
        mp3: ["quality"],
        opus: ["quality"],
      },
    },
    outputs: ["AUDIO"],
    output: true,
  },
  PreviewAudio: {
    inputs: ["audio"],
    output: true,
  },

  // ---- ACE-Step 1.5, the song model (`comfy_extras/nodes_ace.py`) --------
  // Core nodes, so `ace-step-song` runs on stock ComfyUI (DESIGN-AUDIO
  // §2.1.1). `seed` carries the same `control_after_generate` combo a
  // sampler's does, and the encoder holds the musical parameters — bpm, key,
  // time signature — that a picture model has no equivalent of.
  "TextEncodeAceStepAudio1.5": {
    inputs: ["clip"],
    widgets: [
      "tags",
      "lyrics",
      "seed",
      "bpm",
      "duration",
      "timesignature",
      "language",
      "keyscale",
      "generate_audio_codes",
      "cfg_scale",
      "temperature",
      "top_p",
      "top_k",
      "min_p",
    ],
    after: { seed: "fixed" },
    outputs: ["CONDITIONING"],
  },
  "EmptyAceStep1.5LatentAudio": {
    widgets: ["seconds", "batch_size"],
    outputs: ["LATENT"],
  },
};

export const CORE_NODE_TYPES: readonly string[] = Object.keys(CORE_NODES);

/**
 * A custom node pack a workflow may need (§4.6).
 *
 * Everything else this repo ships runs on stock ComfyUI. The two speech
 * workflows do not, which is a change in what the project promises, so the
 * requirement is written down rather than discovered: a manifest names the
 * pack in `requires`, the loader checks that the pack it names actually
 * covers the nodes the graph uses, and the message a user gets says which
 * pack to install instead of "node type not found".
 *
 * `id` is the folder name under `custom_nodes/`, which is what both the
 * Containerfile and the manual instructions use.
 */
export interface NodePack {
  id: string;
  name: string;
  url: string;
  /** What the container pins; the version this repo's graphs were built on. */
  version: string;
  nodes: Record<string, NodeSchema>;
}

/**
 * The Breeze TTS 2 pack, read off its `nodes.py` rather than guessed.
 *
 * Three generation nodes matter here. `VoiceClone` copies a reference voice
 * at CFG 1 and takes no instruction, because the reference *is* the delivery.
 * `VoiceDesign` invents a voice from a description at CFG 4. `VoiceDirection`
 * is the pair of them: a cloned voice delivered to an instruction. All three
 * end in the same nine sampling widgets, whose order is what a rebuilt
 * LiteGraph document depends on.
 */
const BREEZE_CONTROLS = [
  "max_new_tokens",
  "temperature",
  "top_k",
  "top_p",
  "repetition_penalty",
  "depth_temperature",
  "depth_top_k",
  "depth_top_p",
  "seed",
];

export const NODE_PACKS: Record<string, NodePack> = {
  "ComfyUI-Breeze-TTS-2": {
    id: "ComfyUI-Breeze-TTS-2",
    name: "Breeze TTS 2",
    url: "https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2",
    version: "1.4.6",
    nodes: {
      // No filename widget: the loader takes one of four build labels and
      // resolves the file itself, which is why the speech workflows expose an
      // `enum` rather than a `model` picker (§4.4).
      BreezeTTS2LoadModel: {
        widgets: [
          "model",
          "dtype",
          "device",
          "attention",
          "decode_mode",
          "download_if_missing",
        ],
        outputs: ["BREEZE_TTS2_MODEL"],
      },
      BreezeTTS2VoiceClone: {
        inputs: ["breeze_model", "reference_audio"],
        widgets: ["text", "reference_text", "cfg_scale", ...BREEZE_CONTROLS],
        after: { seed: "fixed" },
        outputs: ["AUDIO"],
      },
      BreezeTTS2VoiceDesign: {
        inputs: ["breeze_model"],
        widgets: ["text", "instruction", "cfg_scale", ...BREEZE_CONTROLS],
        after: { seed: "fixed" },
        outputs: ["AUDIO"],
      },
      BreezeTTS2VoiceDirection: {
        inputs: ["breeze_model", "reference_audio"],
        widgets: [
          "text",
          "reference_text",
          "instruction",
          "cfg_scale",
          "stitch_reference",
          ...BREEZE_CONTROLS,
        ],
        after: { seed: "fixed" },
        outputs: ["AUDIO"],
      },
    },
  },
};

/** Every node type any known pack provides, mapped to the pack providing it. */
export const PACK_OF_NODE: Record<string, NodePack> = Object.fromEntries(
  Object.values(NODE_PACKS).flatMap((pack) =>
    Object.keys(pack.nodes).map((type) => [type, pack] as const)
  ),
);

/**
 * What the app knows about a node type: core first, then any pack's. Every
 * reader goes through this rather than `CORE_NODES` directly, so a pack node
 * gets the same widget order and slot names a core one does.
 */
export function nodeSchema(classType: string): NodeSchema | undefined {
  return CORE_NODES[classType] ?? PACK_OF_NODE[classType]?.nodes[classType];
}

export const OUTPUT_NODE_TYPES: readonly string[] = Object.entries(CORE_NODES)
  .filter(([, schema]) => schema.output)
  .map(([type]) => type);

export function isOutputNodeType(classType: string): boolean {
  return nodeSchema(classType)?.output === true;
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
  const outputs = nodeSchema(classType)?.outputs;
  if (!outputs) return null;
  const index = outputs.indexOf(outputName);
  return index < 0 ? null : index;
}
