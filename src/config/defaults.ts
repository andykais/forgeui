import type { Config } from "./types.ts";

/** Model kinds listed in Settings (frame 08). Any other key is honoured too. */
export const DEFAULT_MODEL_KINDS = [
  "checkpoints",
  "loras",
  "vae",
  "controlnet",
] as const;

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

export function defaultConfig(): Config {
  return {
    server: { host: "127.0.0.1", port: 7777 },
    comfy: {
      mode: "managed",
      path: null,
      url: DEFAULT_COMFY_URL,
      python: null,
      extra_args: [],
    },
    model_folders: Object.fromEntries(
      DEFAULT_MODEL_KINDS.map((kind) => [kind, [] as string[]]),
    ),
    keys: {
      select_prev: ["ArrowLeft"],
      select_next: ["ArrowRight"],
      select_up: ["ArrowUp"],
      select_down: ["ArrowDown"],
      fullscreen: ["f"],
      close: ["Escape"],
    },
    ui: {
      rail_expanded: false,
      tile_size: { generate: "small", gallery: "small", models: "small" },
      sidebar_collapsed: { generate: false, gallery: false, models: false },
      filmstrip_collapsed: { generate: false, gallery: false, models: false },
    },
  };
}
