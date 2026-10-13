import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { Manifest, Template } from "../types.ts";

/**
 * Save as template (§4.8): which inputs the template keeps, which it asks
 * for, and which it leaves open — and what each button sends.
 */

const createTemplate = vi.fn();
const saveTemplate = vi.fn();
vi.mock("../api.ts", () => ({
  api: {
    createTemplate: (...args: unknown[]) => createTemplate(...args),
    saveTemplate: (...args: unknown[]) => saveTemplate(...args),
  },
}));
vi.mock("../stores/app.svelte.ts", () => ({ app: {} }));

const { default: SaveTemplate } = await import("./SaveTemplate.svelte");

const manifest = {
  id: "sd15",
  name: "Stable Diffusion 1.5",
  params: [
    { key: "prompt", label: "Prompt", type: "text", required: true, bind: "1.text" },
    { key: "seed", label: "Seed", type: "seed", default: -1, bind: "3.seed" },
    { key: "loras", label: "LoRAs", type: "lora_list", bind: { chain: {} } },
  ],
} as unknown as Manifest;

const values = {
  prompt: "a heron in reeds",
  seed: 7,
  loras: [{ name: "grain.safetensors", strength_model: 0.8, strength_clip: 0.8 }],
};

const saved = { id: "t", name: "Grain" } as Template;

function mount(from: Template | null = null) {
  const onsaved = vi.fn();
  render(SaveTemplate, {
    workflow: "sd15",
    workflowName: "Stable Diffusion 1.5",
    manifest,
    values,
    seedLocked: false,
    from,
    onclose: vi.fn(),
    onsaved,
  });
  return { onsaved };
}

function stateOf(key: string): string | null {
  const row = document.querySelector(`[data-param="${key}"]`) as HTMLElement;
  return (
    within(row)
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") === "true")
      ?.textContent?.trim() ?? null
  );
}

describe("save as template", () => {
  beforeEach(() => {
    createTemplate.mockReset().mockResolvedValue(saved);
    saveTemplate.mockReset().mockResolvedValue(saved);
  });

  test("asks for the prompt, keeps the LoRAs, and leaves the rolling seed open", async () => {
    const { onsaved } = mount();
    expect(stateOf("prompt")).toBe("Ask");
    expect(stateOf("loras")).toBe("Save value");
    expect(stateOf("seed")).toBe("Leave open");
    // A required input is required either way: it can be saved or asked
    // for, but not left open.
    const prompt = document.querySelector('[data-param="prompt"]') as HTMLElement;
    expect(within(prompt).queryByText("Leave open")).toBeNull();

    await fireEvent.input(screen.getByLabelText("Template name"), {
      target: { value: "Grainy" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(createTemplate).toHaveBeenCalledWith({
      name: "Grainy",
      description: null,
      workflow: "sd15",
      values: { loras: values.loras },
      ask: ["prompt"],
    });
    expect(onsaved).toHaveBeenCalledWith(saved, "created");
  });

  test("a choice moves an input between saved, asked and open", async () => {
    mount();
    const seed = document.querySelector('[data-param="seed"]') as HTMLElement;
    await fireEvent.click(within(seed).getByText("Save value"));
    await fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(createTemplate.mock.calls[0]![0].values).toEqual({
      seed: 7,
      loras: values.loras,
    });
  });

  test("opened from a template, it starts there and can update it", async () => {
    const from = {
      id: "grainy",
      name: "Grainy",
      description: "film look",
      workflow: "sd15",
      values: { seed: 7 },
      ask: [],
      source: "user",
    } as unknown as Template;
    const { onsaved } = mount(from);
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe(
      "Grainy",
    );
    expect(stateOf("seed")).toBe("Save value");
    expect(stateOf("loras")).toBe("Leave open");
    // The prompt is required, so a template that does not set it asks for
    // it, whether or not it said so.
    expect(stateOf("prompt")).toBe("Ask");

    await fireEvent.click(screen.getByRole("button", { name: "Update “Grainy”" }));
    expect(saveTemplate).toHaveBeenCalledWith("grainy", {
      name: "Grainy",
      description: "film look",
      values: { seed: 7 },
      ask: ["prompt"],
    });
    expect(onsaved).toHaveBeenCalledWith(saved, "updated");
  });
});
