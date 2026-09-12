import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
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
    path: "/models/loras/krea/film-grain.safetensors",
    name: "krea/film-grain.safetensors",
    filename: "film-grain.safetensors",
    display_name: "Film grain",
    family: "unset",
    kind: "loras",
    class: "lora",
    size: 1024,
    mtime: null,
    id: "hash-placeholder",
    hash: null,
    notes: null,
    tags: [],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    hash_error: null,
    hidden: false,
    present: true,
  },
  {
    path: "/models/loras/detail.safetensors",
    name: "detail.safetensors",
    filename: "detail.safetensors",
    display_name: "Detail",
    family: "unset",
    kind: "loras",
    class: "lora",
    size: 1024,
    mtime: null,
    id: "hash-placeholder",
    hash: null,
    notes: null,
    tags: [],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    hash_error: null,
    hidden: false,
    present: true,
  },
];

interface Handlers {
  onchange: ReturnType<typeof vi.fn>;
  onreset: ReturnType<typeof vi.fn>;
  onedit: ReturnType<typeof vi.fn>;
  onsubmit: ReturnType<typeof vi.fn>;
  onseededit: ReturnType<typeof vi.fn>;
  onseedroll: ReturnType<typeof vi.fn>;
  onseedlock: ReturnType<typeof vi.fn>;
}

function diffusionModel(name: string, family: string, kind = "checkpoints"): ModelEntry {
  return {
    path: `/models/${kind}/${name}`,
    name,
    filename: name,
    display_name: name.replace(/\.safetensors$/, ""),
    family,
    kind,
    class: "diffusion",
    size: 1024,
    mtime: null,
    id: `id-${name}`,
    hash: null,
    notes: null,
    tags: [],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    hash_error: null,
    hidden: false,
    present: true,
  };
}

function mount(
  params: Param[],
  values: Record<string, unknown> = {},
  extra: Partial<{
    seedLocked: boolean;
    lastSeed: number | null;
    warnings: string[];
    checkpoints: ModelEntry[];
    byClass: Record<string, ModelEntry[]>;
  }> = {},
) {
  const handlers: Handlers = {
    onchange: vi.fn(),
    onreset: vi.fn(),
    onedit: vi.fn(),
    onsubmit: vi.fn(),
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
      checkpoints: extra.checkpoints ?? [],
      modelsOfClass: (modelClass: string | undefined) =>
        (modelClass === undefined ? undefined : extra.byClass?.[modelClass]) ??
        extra.checkpoints ??
        [],
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
          label: "Model",
          type: "model",
          bind: "1.ckpt_name",
        },
      ],
      { checkpoint: "krea2.safetensors" },
    );
    expect(screen.getByText("krea2.safetensors")).toBeTruthy();
  });

  test("the model picker lists every diffusion folder, family first", async () => {
    const { handlers } = mount(
      [
        {
          key: "model",
          label: "Model",
          type: "model",
          bind: "1.unet_name",
          filter: { class: "diffusion", family: "flux" },
        },
      ],
      { model: "flux1-dev.safetensors" },
      {
        checkpoints: [
          diffusionModel("flux1-dev.safetensors", "flux", "diffusion_models"),
          diffusionModel("illustriousXL.safetensors", "sdxl"),
          diffusionModel("untagged.safetensors", "unset"),
        ],
      },
    );

    await fireEvent.click(screen.getByText("flux1-dev"));

    // Same family first, then anything nobody has filed, then the divider:
    // a different family is ordered down, never hidden (§13).
    const options = screen
      .getAllByRole("button")
      .filter((node) => node.classList.contains("option"))
      .map((node) => node.textContent?.trim().split(/\s+/)[0]);
    expect(options).toEqual(["flux1-dev", "untagged", "illustriousXL"]);
    expect(screen.getByText("Other models")).toBeTruthy();

    // A model from checkpoints/ is selectable in a workflow whose loader is
    // a UNETLoader: one class, one list (§3).
    await fireEvent.click(screen.getByText("illustriousXL"));
    expect(handlers.onchange).toHaveBeenCalledWith("model", "illustriousXL.safetensors");
  });

  test("a model that is not on disk is flagged in the panel", async () => {
    mount(
      [{ key: "model", label: "Model", type: "model", bind: "1.unet_name" }],
      // What a bundled workflow ships: the template's filename, which is not
      // the filename on this machine.
      { model: "krea2_turbo_fp8_scaled.safetensors" },
      { checkpoints: [diffusionModel("krea2_turbo_bf16.safetensors", "krea2")] },
    );
    expect(screen.getByText("not found")).toBeTruthy();
  });

  test("a text_encoder param picks from the clip class, not diffusion", async () => {
    const encoder = diffusionModel("qwen3vl_4b.safetensors", "unset", "text_encoders");
    encoder.class = "clip";
    const { handlers } = mount(
      [
        {
          key: "clip",
          label: "Text encoder",
          type: "text_encoder",
          bind: "2.clip_name",
          filter: { class: "clip" },
        },
      ],
      { clip: "" },
      {
        checkpoints: [diffusionModel("flux1-dev.safetensors", "flux")],
        byClass: { clip: [encoder] },
      },
    );

    await fireEvent.click(screen.getByText("choose a model…"));
    // The diffusion model is not offered for a text encoder slot.
    expect(screen.queryByText("flux1-dev")).toBeNull();
    await fireEvent.click(screen.getByText("qwen3vl_4b"));
    expect(handlers.onchange).toHaveBeenCalledWith("clip", "qwen3vl_4b.safetensors");
  });

  test("the model picker searches across folders", async () => {
    mount(
      [{ key: "model", label: "Model", type: "model", bind: "1.ckpt_name" }],
      { model: "" },
      {
        checkpoints: [
          diffusionModel("flux1-dev.safetensors", "flux", "diffusion_models"),
          diffusionModel("illustriousXL.safetensors", "sdxl"),
        ],
      },
    );

    await fireEvent.click(screen.getByText("choose a model…"));
    await fireEvent.input(screen.getByLabelText("Search models"), {
      target: { value: "illus" },
    });
    expect(screen.queryByText("flux1-dev")).toBeNull();
    expect(screen.getByText("illustriousXL")).toBeTruthy();
  });

  test("image offers all three ways of having a picture to hand", () => {
    // The picker, a drop, and a paste: a screenshot only ever lives on the
    // clipboard, and making somebody save it to disk first serves nothing.
    mount([
      { key: "image", label: "Image", type: "image", required: true, bind: "10.image" },
    ]);
    expect(screen.getByText(/Choose, drop or paste an image/)).toBeTruthy();
    expect(
      screen.getByLabelText("Image: choose, drop or paste an image"),
    ).toBeTruthy();
  });

  test("mask and video still say why they cannot run yet", () => {
    mount([
      { key: "mask", label: "Mask", type: "mask", bind: "11.mask" },
    ]);
    expect(screen.getByText(/arrive in a later phase/)).toBeTruthy();
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

  test("a row is added from the picker at full strength, linked", async () => {
    const { handlers } = mount([loraParam], { loras: [] });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await fireEvent.click(screen.getByRole("button", { name: /krea\/film-grain/ }));
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "krea/film-grain.safetensors", strength_model: 1, strength_clip: 1 },
    ]);
  });

  test("a row's sliders reach as far as its model says", async () => {
    mount([loraParam], {
      loras: [
        { name: "krea/film-grain.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    });
    const slider = screen.getByLabelText("krea/film-grain.safetensors strength");
    // The fixture leaves the bounds at the default.
    expect(slider.getAttribute("min")).toBe("-2");
    expect(slider.getAttribute("max")).toBe("2");
  });

  test("an added LoRA is marked rather than offered twice", async () => {
    mount([loraParam], {
      loras: [
        { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
      ],
    });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(screen.getByText("added")).toBeTruthy();
  });

  test("one slider drives both strengths until they are unlinked", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
      ],
    });
    const slider = screen.getByLabelText("krea/film-grain.safetensors strength");
    await fireEvent.input(slider, { target: { value: "0.5" } });
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "krea/film-grain.safetensors", strength_model: 0.5, strength_clip: 0.5 },
    ]);

    await fireEvent.click(screen.getByLabelText("Unlink strengths"));
    expect(
      screen.getByLabelText("krea/film-grain.safetensors model strength"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("krea/film-grain.safetensors clip strength"),
    ).toBeTruthy();
  });

  test("a row can be removed", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
        { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    });
    await fireEvent.click(screen.getByLabelText("Remove krea/film-grain.safetensors"));
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
    ]);
  });

  test("rows can be dragged into a new order, because order is chain order", async () => {
    const { handlers } = mount([loraParam], {
      loras: [
        { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
        { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    });
    const rows = document.querySelectorAll(".lora-row");
    await fireEvent.dragStart(rows[1]!);
    await fireEvent.drop(rows[0]!);
    expect(handlers.onchange).toHaveBeenCalledWith("loras", [
      { name: "detail.safetensors", strength_model: 1, strength_clip: 1 },
      { name: "krea/film-grain.safetensors", strength_model: 0.8, strength_clip: 0.8 },
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

describe("the panel header and the prompt", () => {
  test("Edit is offered beside Reset to defaults", async () => {
    const { handlers } = mount([{ key: "prompt", type: "text", bind: "6.text" }]);
    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(handlers.onedit).toHaveBeenCalled();
  });

  test("Enter in the prompt runs the workflow, Shift+Enter does not", async () => {
    const { handlers } = mount(
      [{ key: "prompt", label: "Prompt", type: "text", bind: "6.text" }],
      { prompt: "figs" },
    );
    const field = screen.getByLabelText("Prompt");

    await fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(handlers.onsubmit).not.toHaveBeenCalled();

    await fireEvent.keyDown(field, { key: "Enter" });
    expect(handlers.onsubmit).toHaveBeenCalledTimes(1);
  });

  test("picking a model hands the caret to the prompt", async () => {
    mount(
      [
        { key: "prompt", label: "Prompt", type: "text", bind: "6.text" },
        { key: "model", label: "Model", type: "model", bind: "4.ckpt_name" },
      ],
      { prompt: "figs", model: "" },
      { checkpoints: [diffusionModel("flux-dev.safetensors", "flux")] },
    );
    await fireEvent.click(screen.getByRole("button", { name: /choose a model/ }));
    await fireEvent.click(screen.getByRole("button", { name: /flux-dev/ }));
    // The focus is taken on the microtask after the picker closes.
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(screen.getByLabelText("Prompt"));
  });
});

describe("Advanced says when the problem is inside it", () => {
  const params: Param[] = [
    { key: "prompt", label: "Prompt", type: "text", bind: "6.text" },
    {
      key: "vae",
      label: "VAE",
      type: "vae",
      advanced: true,
      filter: { class: "vae" },
      bind: "10.vae_name",
    },
  ];

  test("a model that is not on disk opens the section and is marked", async () => {
    mount(
      params,
      { prompt: "figs", vae: "ae.safetensors" },
      { byClass: { vae: [diffusionModel("flux-vae.safetensors", "flux", "vae")] } },
    );
    await tick();
    // Open, so the field that has to be fixed is the one on screen.
    expect(screen.getByText("VAE")).toBeTruthy();
    expect(screen.getByText("not found")).toBeTruthy();
    // And said on the header, so a section closed again still reads as wrong.
    expect(screen.getByRole("button", { name: /Advanced/ }).textContent).toContain("1");
  });

  test("a section with nothing wrong in it stays collapsed", async () => {
    mount(
      params,
      { prompt: "figs", vae: "flux-vae.safetensors" },
      { byClass: { vae: [diffusionModel("flux-vae.safetensors", "flux", "vae")] } },
    );
    await tick();
    expect(screen.queryByText("VAE")).toBeNull();
  });
});

describe("the LoRA search box", () => {
  const loraParam: Param = {
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
  };

  test("the list covers the panel rather than hanging off its row", async () => {
    // A row low in the panel would otherwise put half its list below the
    // bottom of the screen (§11.3).
    mount([loraParam], { loras: [] });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    const popover = screen.getByRole("dialog", { name: "LoRAs" });
    // `fixed` is the viewport-positioned class; `height` is what says this
    // one is covering the panel rather than hanging off its trigger.
    expect(popover.className).toContain("fixed");
    expect(popover.style.top).not.toBe("");
    expect(popover.style.left).not.toBe("");
    expect(popover.style.height).not.toBe("");
  });

  test("opening the picker puts the caret in its search box", async () => {
    mount([loraParam], { loras: [] });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // One click opens it and starts the search; there is no second one.
    expect(document.activeElement).toBe(screen.getByLabelText("Search LoRAs"));
  });

  test("adding one leaves the caret and the panel where they were", async () => {
    // Unlike picking a model, which is the start of writing a prompt. Adding
    // a LoRA is not: you are working in this list, usually about to add
    // another, and being thrown back up to the prompt took the panel's scroll
    // with it.
    mount([{ key: "prompt", label: "Prompt", type: "text", bind: "6.text" }, loraParam], {
      prompt: "figs",
      loras: [],
    });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await fireEvent.click(screen.getByRole("button", { name: /krea\/film-grain/ }));
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).not.toBe(screen.getByLabelText("Prompt"));
  });

  test("picking a model still hands the caret to the prompt", async () => {
    mount([
      { key: "prompt", label: "Prompt", type: "text", bind: "6.text" },
      { key: "model", label: "Model", type: "model", bind: "1.ckpt_name" },
    ], { prompt: "figs", model: "" }, {
      checkpoints: [diffusionModel("krea2_turbo_bf16.safetensors", "krea2")],
    });
    await fireEvent.click(screen.getByText("choose a model…"));
    await fireEvent.click(screen.getByText("krea2_turbo_bf16"));
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByLabelText("Prompt"));
  });

  test("a regular expression narrows the list to what it matches", async () => {
    mount([loraParam], { loras: [] });
    await fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    const search = screen.getByLabelText("Search LoRAs");
    await fireEvent.input(search, { target: { value: "krea.*grain" } });
    expect(screen.getByRole("button", { name: /krea\/film-grain/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /detail\.safetensors/ })).toBeNull();

    // A half-typed pattern falls back to a substring rather than emptying it.
    await fireEvent.input(search, { target: { value: "detail(" } });
    expect(screen.queryByRole("button", { name: /krea\/film-grain/ })).toBeNull();
  });
});

/**
 * `when`: a param applies only while another holds a given value (§4.3). The
 * panel and the server have to agree, so the same predicate decides what is
 * rendered here and what `coerceParams` checks `required` against.
 */
describe("a param that only sometimes applies", () => {
  const turbo: Param = {
    key: "turbo",
    label: "Turbo LoRA",
    type: "bool",
    bind: "17.value",
  };
  const steps: Param = {
    key: "steps",
    label: "Steps",
    type: "int",
    bind: "9.value",
    when: { param: "turbo", is: false },
  };
  const turboSteps: Param = {
    key: "turbo_steps",
    label: "Turbo steps",
    type: "int",
    bind: "10.value",
    when: { param: "turbo", is: true },
  };

  test("only the side the switch is on is rendered", () => {
    mount([turbo, steps, turboSteps], { turbo: false, steps: 30, turbo_steps: 8 });
    expect(screen.getByText("Steps")).toBeTruthy();
    expect(screen.queryByText("Turbo steps")).toBeNull();
  });

  test("and it swaps when the switch does", () => {
    mount([turbo, steps, turboSteps], { turbo: true, steps: 30, turbo_steps: 8 });
    expect(screen.queryByText("Steps")).toBeNull();
    expect(screen.getByText("Turbo steps")).toBeTruthy();
  });

  test("the count says how many fields are on screen", () => {
    // Three in the manifest, two of them ever at once. A count that said
    // three would disagree with what you can see.
    mount([turbo, steps, turboSteps], { turbo: false });
    expect(screen.getByText("2")).toBeTruthy();
  });

  test("an advanced one that does not apply raises no problem", () => {
    // Advanced opens itself when something down there needs fixing (§11.2);
    // a field the workflow is ignoring is not something to fix.
    mount(
      [
        turbo,
        {
          key: "image",
          label: "Image",
          type: "image",
          required: true,
          advanced: true,
          bind: "10.image",
          when: { param: "turbo", is: true },
        },
      ],
      { turbo: false },
    );
    expect(screen.queryByText("Image")).toBeNull();
    expect(screen.queryByTitle("Something down here needs fixing")).toBeNull();
  });
});
