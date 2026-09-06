import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import ParamPanel from "./ParamPanel.svelte";
import type { Manifest, ModelEntry, Param } from "../../types.ts";
import { fillValues } from "../../stores/panel.svelte.ts";

/**
 * §14.1: one test per param type rendering from a manifest, the
 * advanced-section collapse, required gating, LoRA row add / remove /
 * reorder, and the seed's 🎲 / 🔒 behaviour.
 */

function manifestWith(params: Param[]): Manifest {
  return {
    id: "fixture",
    name: "Fixture",
    family: "flux",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
  };
}

const loras: ModelEntry[] = [
  {
    path: "/models/loras/film-grain.safetensors",
    name: "film-grain.safetensors",
    filename: "film-grain.safetensors",
    display_name: "Film grain",
    family: "unset",
    kind: "loras",
    size: 1024,
    mtime: null,
    id: "hash-placeholder",
    hash: null,
    notes: null,
    tags: [],
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    present: true,
  },
  {
    path: "/models/loras/detail.safetensors",
    name: "detail.safetensors",
    filename: "detail.safetensors",
    display_name: "Detail",
    family: "unset",
    kind: "loras",
    size: 1024,
    mtime: null,
    id: "hash-placeholder",
    hash: null,
    notes: null,
    tags: [],
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    present: true,
  },
];

interface Handlers {
  onchange: ReturnType<typeof vi.fn>;
  onreset: ReturnType<typeof vi.fn>;
  onseededit: ReturnType<typeof vi.fn>;
  onseedroll: ReturnType<typeof vi.fn>;
  onseedlock: ReturnType<typeof vi.fn>;
}

function mount(
  params: Param[],
  values: Record<string, unknown> = {},
  extra: Partial<{
    seedLocked: boolean;
    lastSeed: number | null;
    warnings: string[];
  }> = {},
) {
  const handlers: Handlers = {
    onchange: vi.fn(),
    onreset: vi.fn(),
    onseededit: vi.fn(),
    onseedroll: vi.fn(),
    onseedlock: vi.fn(),
  };
  const result = render(ParamPanel, {
    props: {
      manifest: manifestWith(params),
      values,
      seedLocked: extra.seedLocked ?? false,
      lastSeed: extra.lastSeed ?? null,
      loras,
      checkpoints: [],
      warnings: extra.warnings ?? [],
      ...handlers,
    },
  });
  return { ...result, handlers };
}

describe("each param type renders from the manifest", () => {
  test("text", async () => {
    const { handlers } = mount(
      [{ key: "prompt", label: "Prompt", type: "text", bind: "6.text" }],
      { prompt: "figs" },
    );
    const field = screen.getByLabelText("Prompt");
    expect((field as HTMLTextAreaElement).value).toBe("figs");
    await fireEvent.input(field, { target: { value: "herons" } });
    expect(handlers.onchange).toHaveBeenCalledWith("prompt", "herons");
  });

  test("int and float", async () => {
    const { handlers } = mount(
      [
        { key: "steps", label: "Steps", type: "int", min: 1, max: 100, bind: "3.steps" },
        { key: "cfg", label: "CFG", type: "float", step: 0.1, bind: "3.cfg" },
      ],
      { steps: 28, cfg: 3.5 },
    );

    // A bounded number gets a slider as well as the field.
    expect(screen.getByLabelText("Steps")).toHaveProperty("type", "range");
    const stepsValue = screen.getByLabelText("Steps value");
    expect((stepsValue as HTMLInputElement).value).toBe("28");
    await fireEvent.input(stepsValue, { target: { value: "30" } });
    expect(handlers.onchange).toHaveBeenCalledWith("steps", 30);

    // An unbounded float is just a field.
    const cfg = screen.getByLabelText("CFG value");
    expect((cfg as HTMLInputElement).value).toBe("3.5");
  });

  test("bool", async () => {
    const { handlers } = mount(
      [{ key: "tiled", label: "Tiled", type: "bool", bind: "8.tiled" }],
      { tiled: false },
    );
    await fireEvent.change(screen.getByLabelText("Tiled"), {
      target: { checked: true },
    });
    expect(handlers.onchange).toHaveBeenCalledWith("tiled", true);
  });

  test("enum", async () => {
    const { handlers } = mount(
      [
        {
          key: "sampler",
          label: "Sampler",
          type: "enum",
          options: ["euler", "dpmpp_2m"],
          bind: "3.sampler_name",
        },
      ],
      { sampler: "euler" },
    );
    const select = screen.getByLabelText("Sampler") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "euler",
      "dpmpp_2m",
    ]);
    await fireEvent.change(select, { target: { value: "dpmpp_2m" } });
    expect(handlers.onchange).toHaveBeenCalledWith("sampler", "dpmpp_2m");
  });

  test("size resolves ratio presets against the base resolution", async () => {
    const { handlers } = mount(
      [
        {
          key: "size",
          label: "Size",
          type: "size",
          default: [1024, 1024],
          step: 64,
          bind: { w: "5.width", h: "5.height" },
        },
      ],
      { size: [1024, 1024] },
    );

    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("1024");
    // 16:9 of a 1024×1024 base, snapped to the model's 64px grid (§11.3).
    const preset = screen.getByRole("button", { name: "16:9" });
    expect(preset.getAttribute("title")).toBe("1344 × 768");
    await fireEvent.click(preset);
    expect(handlers.onchange).toHaveBeenCalledWith("size", [1344, 768]);
  });

  test("checkpoint shows a picker", () => {
    mount(
      [
        {
          key: "checkpoint",
          label: "Checkpoint",
          type: "checkpoint",
          bind: "1.ckpt_name",
        },
      ],
      { checkpoint: "krea2.safetensors" },
    );
    expect(screen.getByText("krea2.safetensors")).toBeTruthy();
  });

  test("image says why it cannot run yet, rather than faking an upload", () => {
    mount([
      { key: "image", label: "Image", type: "image", required: true, bind: "10.image" },
    ]);
    expect(screen.getByText(/inputs arrive with the content-addressed/)).toBeTruthy();
  });
});

describe("the panel's own behaviour", () => {
  test("required params are marked, and order is required then optional", () => {
    mount([
      { key: "negative", label: "Negative", type: "text", bind: "7.text" },
      { key: "prompt", label: "Prompt", type: "text", required: true, bind: "6.text" },
    ]);
    const keys = [...document.querySelectorAll("[data-param]")].map((node) =>
      node.getAttribute("data-param"),
    );
    expect(keys).toEqual(["prompt", "negative"]);
    expect(screen.getByText("required")).toBeTruthy();
  });

  test("the advanced section is collapsed until it is opened", async () => {
    mount(
      [
        { key: "prompt", label: "Prompt", type: "text", bind: "6.text" },
        { key: "steps", label: "Steps", type: "int", advanced: true, bind: "3.steps" },
        { key: "cfg", label: "CFG", type: "float", advanced: true, bind: "3.cfg" },
      ],
      { steps: 28, cfg: 3.5 },
    );

    expect(screen.queryByLabelText("Steps value")).toBeNull();
    // The header names the keys it hides and counts them.
    const header = screen.getByRole("button", { name: /Advanced/ });
    expect(header.textContent).toContain("steps · cfg");
    await fireEvent.click(header);
    expect(screen.getByLabelText("Steps value")).toBeTruthy();
    expect(screen.getByLabelText("CFG value")).toBeTruthy();
  });

  test("Reset to defaults is offered on the header", async () => {
    const { handlers } = mount([{ key: "prompt", type: "text", bind: "6.text" }]);
    await fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(handlers.onreset).toHaveBeenCalled();
  });

  test("keys the manifest no longer has are shown as a warning", () => {
    mount(
      [{ key: "prompt", type: "text", bind: "6.text" }],
      {},
      {
        warnings: ["refiner_steps", "clip_skip"],
      },
    );
    expect(screen.getByText(/refiner_steps, clip_skip/)).toBeTruthy();
    expect(screen.getByText(/no longer exposes/)).toBeTruthy();
  });
});

describe("the seed", () => {
  const seedParam: Param = { key: "seed", label: "Seed", type: "seed", bind: "3.seed" };

  test("unlocked shows the last-used seed greyed with the random hint", () => {
    mount([seedParam], { seed: -1 }, { seedLocked: false, lastSeed: 4242 });
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("4242");
    expect(screen.getByText(/random each run/)).toBeTruthy();
  });

  test("locked shows the pinned seed and says it is reused", () => {
    mount([seedParam], { seed: 4242 }, { seedLocked: true, lastSeed: 4242 });
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("4242");
    expect(screen.getByText(/reused until unlocked/)).toBeTruthy();
  });

  test("🎲 re-rolls and 🔒 toggles the lock", async () => {
    const { handlers } = mount([seedParam], { seed: -1 }, { lastSeed: 7 });
    await fireEvent.click(screen.getByLabelText("Roll a new seed"));
    expect(handlers.onseedroll).toHaveBeenCalled();
    await fireEvent.click(screen.getByLabelText("Lock the seed"));
    expect(handlers.onseedlock).toHaveBeenCalled();
  });

  test("typing in the field reports the typed value", async () => {
    const { handlers } = mount([seedParam], { seed: 1 }, { seedLocked: true });
    await fireEvent.input(screen.getByLabelText("Seed"), { target: { value: "99" } });
    expect(handlers.onseededit).toHaveBeenCalledWith(99);
  });
});

describe("the LoRA list", () => {
  const loraParam: Param = {
    key: "loras",
    label: "LoRAs",
    type: "lora_list",
    bind: {
      chain: {
        model_from: "1.MODEL",
        clip_from: "2.CLIP",
        model_to: ["3.model"],
        clip_to: ["6.clip"],
      },
    },
  };

  test("a row is added from the picker with linked strengths", async () => {
    const { handlers } = mount([loraParam], { loras: [] });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Film grain/ }));
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    ]);
  });

  test("an added LoRA is marked rather than offered twice", async () => {
    mount([loraParam], {
      loras: [
        { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
      ],
    });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(screen.getByText("added")).toBeTruthy();
  });

  test("one slider drives both strengths until they are unlinked", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
      ],
    });
    const slider = screen.getByLabelText("Film grain strength");
    await fireEvent.input(slider, { target: { value: "0.5" } });
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "film-grain.safetensors", strength_model: 0.5, strength_clip: 0.5 },
    ]);

    await fireEvent.click(screen.getByLabelText("Unlink strengths"));
    expect(screen.getByLabelText("Film grain model strength")).toBeTruthy();
    expect(screen.getByLabelText("Film grain clip strength")).toBeTruthy();
  });

  test("a row can be removed", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
        { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    });
    await fireEvent.click(screen.getByLabelText("Remove Film grain"));
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
    ]);
  });

  test("rows can be dragged into a new order, because order is chain order", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
        { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    });
    const rows = document.querySelectorAll(".lora-row");
    await fireEvent.dragStart(rows[1]!);
    await fireEvent.drop(rows[0]!);
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      { name: "film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    ]);
  });
});

describe("Reuse Parameters maps by key", () => {
  const manifest = manifestWith([
    { key: "prompt", type: "text", bind: "6.text" },
    { key: "seed", type: "seed", default: -1, bind: "3.seed" },
    { key: "steps", type: "int", default: 28, bind: "3.steps" },
  ]);

  test("known keys are filled and missing ones fall back to defaults", () => {
    const { values, warnings } = fillValues(manifest, { prompt: "figs", seed: 7 });
    expect(values).toEqual({ prompt: "figs", seed: 7, steps: 28 });
    expect(warnings).toEqual([]);
  });

  test("keys the manifest no longer has come back as warnings (§6.4)", () => {
    const { values, warnings } = fillValues(manifest, {
      prompt: "figs",
      refiner_steps: 8,
      clip_skip: 2,
    });
    expect(warnings).toEqual(["refiner_steps", "clip_skip"]);
    expect("refiner_steps" in values).toBe(false);
  });
});
