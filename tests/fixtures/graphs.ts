import type { ApiGraph } from "../fake-comfy/graph.ts";

/**
 * A prompt-format graph built from core ComfyUI nodes, in the shape the
 * rewrite step produces: bound scalars, `filename_prefix` set to
 * `<jobid>/out` (§5 step 3).
 */
export interface SimpleGraphOptions {
  jobId: string;
  prompt?: string;
  negative?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  width?: number;
  height?: number;
  /** More than one `SaveImage` node, for the multi-output scenario. */
  saveNodes?: number;
  checkpoint?: string;
}

export function simpleImageGraph(options: SimpleGraphOptions): ApiGraph {
  const {
    jobId,
    prompt = "a test prompt",
    negative = "",
    seed = 123456,
    steps = 4,
    cfg = 3.5,
    width = 64,
    height = 64,
    saveNodes = 1,
    checkpoint = "test-checkpoint.safetensors",
  } = options;

  const graph: ApiGraph = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
      _meta: { title: "Load Checkpoint" },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
      _meta: { title: "KSampler" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
      _meta: { title: "Empty Latent Image" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Prompt)" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Negative)" },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["1", 2] },
      _meta: { title: "VAE Decode" },
    },
  };

  for (let i = 0; i < saveNodes; i++) {
    graph[String(9 + i)] = {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: i === 0 ? `${jobId}/out` : `${jobId}/out-${i}`,
        images: ["8", 0],
      },
      _meta: { title: "Save Image" },
    };
  }

  return graph;
}
