import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import type { ModelEntry, OutputDetail, Sidecar } from "../types.ts";

/**
 * The metadata sidebar (§11.2): what it names each model, and how the values
 * it marks copyable are wrapped.
 */

const patchOutput = vi.fn((id: string, patch: { notes?: string | null }) =>
  Promise.resolve({ id, notes: patch.notes ?? null })
);
vi.mock("../api.ts", () => ({
  api: {
    promote: vi.fn(),
    patchOutput: (id: string, patch: { notes?: string | null }) =>
      patchOutput(id, patch),
    // The sidebar asks for the provenance chain on every output it shows
    // (§11.2); these tests are about the rows above it, so it comes back
    // empty and the block is not rendered at all.
    lineage: vi.fn(() => Promise.resolve({ parents: [], children: [] })),
  },
}));

const library: ModelEntry[] = [];
vi.mock("../stores/app.svelte.ts", () => ({
  app: {
    dataDir: "/data",
    get loras() {
      return library;
    },
    modelByName: (name: string) =>
      library.find((model) => model.name === name) ?? null,
    modelName: (hash: string) =>
      library.find((model) => model.hash === hash)?.display_name ?? "unknown",
    model: (hash: string) =>
      library.find((model) => model.hash === hash) ?? null,
  },
}));

/** The panel the sidebar offers to put a LoRA into (§11.2). */
const stub = {
  manifest: null as unknown,
  loraParam: null as unknown,
  detail: null as unknown,
  addLora: vi.fn(() => "added" as const),
};
vi.mock("../stores/panel.svelte.ts", () => ({ panel: stub }));

/** A workflow is open in the panel, and it takes LoRAs. */
function panelTakesLoras() {
  stub.manifest = { name: "Krea 2 Turbo" };
  stub.loraParam = { key: "loras", type: "lora_list" };
  stub.detail = { name: "Krea 2 Turbo" };
}

const { default: MetadataSidebar } = await import("./MetadataSidebar.svelte");

function lora(name: string, hash: string): ModelEntry {
  return {
    id: hash,
    hash,
    path: `/models/loras/${name}`,
    name,
    filename: name,
    display_name: name.replace(/\.safetensors$/, ""),
    family: "flux",
    kind: "loras",
    class: "lora",
    size: 1,
    mtime: null,
    added_at: null,
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

const A = "a".repeat(64);
const B = "b".repeat(64);

function output(extra: Record<string, unknown> = {}): OutputDetail {
  const sidecar = {
    app_version: "0.1.0",
    job_id: "01J",
    created_at: "2026-09-11T00:00:00Z",
    workflow: {
      id: "w",
      name: "Krea 2 Turbo",
      hash: "h",
      family: "krea2",
      kind: "image",
    },
    params: {
      prompt: "a red firetruck\n\non a wet street",
      seed: 6568869050459850,
      loras: [
        { name: "glow.safetensors", strength_model: 1, strength_clip: 1 },
        { name: "grain.safetensors", strength_model: 0.5, strength_clip: 0.5 },
      ],
      ...extra,
    },
    models: [
      { role: "lora", name: "glow.safetensors", hash: null },
      { role: "lora", name: "grain.safetensors", hash: null },
    ],
    api_graph: null,
    outputs: [],
    timing: { total_ms: 228, nodes: {} },
    raw: null,
  } satisfies Sidecar;
  return {
    id: "01JOUT",
    job_id: "01J",
    path: "outputs/a.png",
    sidecar_path: "outputs/a.json",
    kind: "image",
    tone: null,
    tone_color: null,
    width: 1024,
    height: 1024,
    duration_ms: null,
    sha256: null,
    workflow_id: "w",
    workflow_hash: "h",
    family: "krea2",
    prompt: null,
    notes: null,
    params: {},
    deleted_at: null,
    created_at: 1_789_000_000_000,
    media_url: "/api/media/outputs/a.png",
    waveform_url: null,
    generation_ms: 228,
    // Both LoRAs share the one role, which is the shape that used to defeat
    // the by-role lookup.
    models: [
      { model_hash: A, role: "lora" },
      { model_hash: B, role: "lora" },
    ],
    sidecar,
    sidecar_error: null,
  };
}

function mount(extra: Record<string, unknown> = {}) {
  return render(MetadataSidebar, {
    output: output(extra),
    onedit: vi.fn(),
    onrerun: vi.fn(),
    ondelete: vi.fn(),
  });
}

describe("the metadata sidebar", () => {
  beforeEach(() => {
    library.length = 0;
    library.push(lora("glow.safetensors", A), lora("grain.safetensors", B));
    stub.manifest = null;
    stub.loraParam = null;
    stub.detail = null;
    stub.addLora.mockClear();
  });

  test("names every LoRA, rather than one of them twice", () => {
    // `output_models` is keyed by role, so a job with two LoRAs has two rows
    // under the one `lora` role: looking a hash up by role gave both rows the
    // first hash, and both chips the same name.
    mount();
    const names = [...document.querySelectorAll(".lora-name")].map((el) =>
      el.textContent?.trim()
    );
    expect(names).toEqual(["glow", "grain"]);
  });

  test("each LoRA links to its own model page", () => {
    mount();
    const links = [...document.querySelectorAll(".lora-name a")].map((el) =>
      el.getAttribute("href")
    );
    expect(links).toEqual([`/models/${A}`, `/models/${B}`]);
  });

  test("a LoRA the library has not got yet is still named", () => {
    library.length = 0;
    mount();
    const names = [...document.querySelectorAll(".lora-name")].map((el) =>
      el.textContent?.trim()
    );
    expect(names).toEqual(["glow.safetensors", "grain.safetensors"]);
  });

  test("no value sits in a dd, whatever the selection covers", () => {
    // Firefox's plain-text serialiser indents the contents of a `dd` by four
    // spaces — every line, blank ones included — whenever the selection spans
    // the element, which a drag across the sidebar does. Wrapping the value
    // in a span was not enough: the `dd` is the thing that indents, so there
    // is no `dd` here any more.
    mount();
    expect(document.querySelectorAll("dd")).toHaveLength(0);
    expect(document.querySelectorAll("dl")).toHaveLength(0);
    const keys = [...document.querySelectorAll(".field")]
      .filter((row) => row.querySelector(".selectable"))
      .map((row) => row.querySelector(".key")?.textContent?.trim());
    expect(keys).toEqual(["prompt", "seed"]);
  });

  test("the label sits above its value, not beside it", () => {
    // A 74px label column took a fifth of the sidebar away from the value.
    mount();
    const row = [...document.querySelectorAll(".field")].find(
      (r) => r.querySelector(".key")?.textContent?.trim() === "prompt",
    );
    expect(row?.children).toHaveLength(2);
    expect(row?.children[0]?.className).toContain("key");
    expect(getComputedStyle(row!).display).toBe("block");
  });

  test("the prompt is shown exactly as it was written", () => {
    mount();
    const prompt = [...document.querySelectorAll(".field")]
      .find((row) =>
        row.querySelector(".key")?.textContent?.trim() === "prompt"
      )
      ?.querySelector(".selectable");
    expect(prompt?.textContent).toBe("a red firetruck\n\non a wet street");
  });

  test("a role no param names is still listed once", () => {
    mount();
    // Both LoRAs are named by the `loras` param, so neither is repeated as a
    // role row above it.
    expect(screen.queryAllByText("lora")).toHaveLength(0);
  });

  test("offers each LoRA to the workflow open in the panel", async () => {
    panelTakesLoras();
    mount();
    const add = await screen.findByLabelText(
      "Add grain at 0.5 to Krea 2 Turbo",
    );
    await add.click();
    // The strengths come from the run, not from the model's own defaults:
    // what makes a LoRA usable is the number somebody already found for it.
    expect(stub.addLora).toHaveBeenCalledWith({
      name: "grain.safetensors",
      strength_model: 0.5,
      strength_clip: 0.5,
    });
  });

  test("says nothing when the open workflow takes no LoRAs", () => {
    stub.manifest = { name: "Some workflow" };
    stub.loraParam = null;
    mount();
    expect(screen.queryByLabelText(/^Add /)).toBeNull();
  });

  test("an image param is shown as the picture, not as its hash", () => {
    // The value is a 64-character content hash. True, and no use to anybody
    // reading it: the question an image param raises is "which image".
    const image = `${"c".repeat(64)}.png`;
    mount({ image });
    const row = [...document.querySelectorAll(".field")].find(
      (field) => field.querySelector(".key")?.textContent?.trim() === "image",
    );
    expect(row?.textContent).not.toContain(image);
    expect(row?.querySelector("img")?.getAttribute("src")).toBe(
      `/api/media/inputs/cc/${image}`,
    );
  });

  test("a param that only looks like a filename is left as text", () => {
    mount({ model: "krea2_turbo_fp8_scaled.safetensors" });
    const row = [...document.querySelectorAll(".field")].find(
      (field) => field.querySelector(".key")?.textContent?.trim() === "model",
    );
    expect(row?.querySelector("img")).toBeNull();
    expect(row?.textContent).toContain("krea2_turbo_fp8_scaled.safetensors");
  });

  test("a note is saved on blur, and Escape puts back what was there", async () => {
    // §6.2: feedback typed after looking at the picture, which the MCP
    // bridge reads back later. Saved on blur like the model page's notes.
    //
    // `mount()` passes no `onnotes`, which is the point: the save must not
    // depend on someone listening for the result.
    patchOutput.mockClear();
    mount();
    const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    await fireEvent.input(field, { target: { value: "hands are mangled" } });
    await fireEvent.blur(field);
    expect(patchOutput).toHaveBeenCalledWith("01JOUT", {
      notes: "hands are mangled",
    });

    // Escape reverts to the row's own value and does not save.
    patchOutput.mockClear();
    await fireEvent.input(field, { target: { value: "no wait" } });
    await fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    await fireEvent.blur(field);
    expect(patchOutput).not.toHaveBeenCalled();
  });

  test("a note that has not changed is not saved again", async () => {
    // Stepping through the filmstrip blurs the field on every move; a PATCH
    // per step would rewrite the sidecar for nothing.
    patchOutput.mockClear();
    render(MetadataSidebar, {
      output: { ...output(), notes: "already said" },
      onedit: vi.fn(),
      onrerun: vi.fn(),
      ondelete: vi.fn(),
    });
    const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(field.value).toBe("already said");
    await fireEvent.blur(field);
    expect(patchOutput).not.toHaveBeenCalled();
  });

  test("the output id can be copied out of the actions row", async () => {
    // Anything outside this window that names an output does it by id — the
    // MCP bridge's `attach_input` and `get_output` both take one. An id you
    // can only read is an id you retype.
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mount();
    await fireEvent.click(screen.getByLabelText("Copy output id"));
    expect(writeText).toHaveBeenCalledWith("01JOUT");
    vi.unstubAllGlobals();
  });

  test("says nothing when no workflow is open at all", () => {
    mount();
    expect(screen.queryByLabelText(/^Add /)).toBeNull();
  });
});
