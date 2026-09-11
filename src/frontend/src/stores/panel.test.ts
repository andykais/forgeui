import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LoraRow, Manifest, WorkflowDetail } from "../types.ts";

/**
 * Putting a LoRA from a finished run into the panel (§11.2). The number that
 * makes a LoRA worth anything is the strength somebody found for it, and it
 * is sitting in the metadata of the output on screen — so it is carried over
 * as it stands rather than read off and typed back in.
 */

vi.mock("../api.ts", () => ({ api: {} }));
vi.mock("./app.svelte.ts", () => ({ app: { comfyReady: true } }));

const { panel } = await import("./panel.svelte.ts");

const LORA_PARAM = {
  key: "loras",
  type: "lora_list",
  bind: {
    chain: {
      model_from: "1.MODEL",
      clip_from: null,
      model_to: ["3.model"],
      clip_to: null,
    },
  },
} as const;

function load(params: unknown[]) {
  const manifest = {
    id: "w",
    name: "Krea 2 Turbo",
    family: "krea2",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
  } as unknown as Manifest;
  panel.detail = { id: "w", name: "Krea 2 Turbo", manifest } as WorkflowDetail;
  panel.values = {};
}

const row = (name: string, strength: number): LoraRow => ({
  name,
  strength_model: strength,
  strength_clip: strength,
});

const rows = () => panel.values.loras as LoraRow[] | undefined;

describe("adding a LoRA to the panel", () => {
  beforeEach(() => load([LORA_PARAM]));

  test("arrives at the strength it was run at", () => {
    expect(panel.addLora(row("glow.safetensors", 0.8))).toBe("added");
    expect(rows()).toEqual([
      { name: "glow.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    ]);
  });

  test("a second one is appended, not swapped in", () => {
    panel.addLora(row("glow.safetensors", 0.8));
    panel.addLora(row("grain.safetensors", 1.2));
    expect(rows()!.map((lora) => lora.name)).toEqual([
      "glow.safetensors",
      "grain.safetensors",
    ]);
  });

  test("one already listed moves to the new strength", () => {
    // Two rows naming one file would have ComfyUI apply it twice, which is
    // not what "apply this at 0.5" means.
    panel.addLora(row("glow.safetensors", 0.8));
    expect(panel.addLora(row("glow.safetensors", 0.5))).toBe("updated");
    expect(rows()).toEqual([
      { name: "glow.safetensors", strength_model: 0.5, strength_clip: 0.5 },
    ]);
  });

  test("model and clip strengths are kept apart", () => {
    panel.addLora({
      name: "glow.safetensors",
      strength_model: 1,
      strength_clip: 0.4,
    });
    expect(rows()![0]).toEqual({
      name: "glow.safetensors",
      strength_model: 1,
      strength_clip: 0.4,
    });
  });

  test("a workflow that takes no LoRAs says so rather than inventing a list", () => {
    load([{ key: "prompt", type: "text", bind: "4.text" }]);
    expect(panel.loraParam).toBeNull();
    expect(panel.addLora(row("glow.safetensors", 1))).toBeNull();
    expect(panel.values.loras).toBeUndefined();
  });
});
