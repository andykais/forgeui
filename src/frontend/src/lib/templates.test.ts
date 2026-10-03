import { describe, expect, test } from "vitest";
import { defaultFor } from "../stores/panel.svelte.ts";
import { defaultStates, describeValue, fromStates, statesOf } from "./templates.ts";
import type { Manifest, ModelEntry } from "../types.ts";

/**
 * A template leaves each param set, asked for or open (§4.8). Where a new
 * one starts matters most: a saved set of LoRAs must still ask for the
 * prompt, or the template would quietly fill in yesterday's.
 */

const manifest = {
  id: "w",
  name: "W",
  params: [
    { key: "prompt", type: "text", required: true, bind: "1.text" },
    { key: "negative", type: "text", default: "", bind: "2.text" },
    { key: "seed", type: "seed", default: -1, bind: "3.seed" },
    { key: "steps", type: "int", default: 20, bind: "3.steps", advanced: true },
    { key: "loras", type: "lora_list", bind: { chain: {} } },
  ],
} as unknown as Manifest;

const values = {
  prompt: "a heron in reeds",
  negative: "",
  seed: 42,
  steps: 28,
  loras: [
    { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
  ],
};

describe("a new template's starting states", () => {
  test("required is asked, changed is saved, the rest is open", () => {
    expect(defaultStates(manifest, values, defaultFor, false)).toEqual({
      prompt: "ask",
      negative: "open",
      seed: "open",
      steps: "set",
      loras: "set",
    });
  });

  test("a pinned seed is saved; a rolling one is not", () => {
    expect(defaultStates(manifest, values, defaultFor, true).seed).toBe("set");
  });

  test("the body carries the saved values and the asked keys, nothing open", () => {
    const body = fromStates(defaultStates(manifest, values, defaultFor, false), values);
    expect(body).toEqual({
      values: { steps: 28, loras: values.loras },
      ask: ["prompt"],
    });
  });

  test("an existing template's states read back", () => {
    // The prompt is required, so it reads as asked even where the template
    // does not list it.
    expect(statesOf({ values: { steps: 30 }, ask: [] }, manifest)).toEqual({
      prompt: "ask",
      negative: "open",
      seed: "open",
      steps: "set",
      loras: "open",
    });
  });
});

describe("a value in one line", () => {
  const loras = [
    { name: "krea/film-grain.safetensors", display_name: "Film grain" },
  ] as ModelEntry[];

  test("LoRAs by title, sizes by their numbers, seeds by what -1 means", () => {
    expect(describeValue(values.loras, undefined, loras)).toBe("Film grain 0.8");
    expect(describeValue([1024, 768])).toBe("1024 × 768");
    expect(describeValue(-1, manifest.params[2])).toBe("random");
    const image = { key: "image", type: "image", bind: "6.image" } as const;
    expect(describeValue(`${"ab".repeat(32)}.png`, image)).toBe("image abababab…");
    expect(describeValue(null)).toBe("—");
    expect(describeValue(true)).toBe("on");
  });
});
