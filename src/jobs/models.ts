import type { SidecarModelRef } from "../db/queries.ts";
import type { ApiGraph } from "../workflows/types.ts";

/**
 * Which model files a graph names, for the sidecar's `models` block (§6.2)
 * and, once Phase 2 has hashed the folders, for `output_models`. Hashes are
 * unknown in Phase 1: the filename plus the role is what a sidecar records,
 * and `reindex` fills the hashes in later.
 */

const LOADERS: Record<string, { role: string; inputs: string[] }> = {
  CheckpointLoaderSimple: { role: "checkpoint", inputs: ["ckpt_name"] },
  UNETLoader: { role: "unet", inputs: ["unet_name"] },
  VAELoader: { role: "vae", inputs: ["vae_name"] },
  CLIPLoader: { role: "clip", inputs: ["clip_name"] },
  DualCLIPLoader: { role: "clip", inputs: ["clip_name1", "clip_name2"] },
  LoraLoader: { role: "lora", inputs: ["lora_name"] },
  LoraLoaderModelOnly: { role: "lora", inputs: ["lora_name"] },
};

/** Checkpoint first, then LoRAs, then the rest (§8.3's popover order). */
const ROLE_ORDER = ["checkpoint", "unet", "lora", "clip", "vae"];

export function collectModels(graph: ApiGraph): SidecarModelRef[] {
  const models: SidecarModelRef[] = [];
  const seen = new Set<string>();
  // Numeric node ids iterate in numeric order, so spliced LoRA nodes come out
  // in chain order.
  for (const node of Object.values(graph)) {
    const loader = LOADERS[node.class_type];
    if (!loader) continue;
    for (const input of loader.inputs) {
      const name = node.inputs[input];
      if (typeof name !== "string" || name.length === 0) continue;
      const key = `${loader.role}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ role: loader.role, name, hash: null });
    }
  }
  return models.sort((a, b) => {
    const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    return byRole !== 0 ? byRole : 0;
  });
}
