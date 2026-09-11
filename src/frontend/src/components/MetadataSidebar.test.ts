import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { ModelEntry, OutputDetail, Sidecar } from "../types.ts";

/**
 * The metadata sidebar (§11.2): what it names each model, and how the values
 * it marks copyable are wrapped.
 */

vi.mock("../api.ts", () => ({ api: { promote: vi.fn() } }));

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
    notes: null,
    tags: [],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    present: true,
  };
}

const A = "a".repeat(64);
const B = "b".repeat(64);

function output(): OutputDetail {
  const sidecar = {
    app_version: "0.1.0",
    job_id: "01J",
    created_at: "2026-09-11T00:00:00Z",
    workflow: { id: "w", name: "Krea 2 Turbo", hash: "h", family: "krea2", kind: "image" },
    params: {
      prompt: "a red firetruck\n\non a wet street",
      seed: 6568869050459850,
      loras: [
        { name: "glow.safetensors", strength_model: 1, strength_clip: 1 },
        { name: "grain.safetensors", strength_model: 0.5, strength_clip: 0.5 },
      ],
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
    width: 1024,
    height: 1024,
    duration_ms: null,
    sha256: null,
    workflow_id: "w",
    workflow_hash: "h",
    family: "krea2",
    prompt: null,
    params: {},
    deleted_at: null,
    created_at: 1_789_000_000_000,
    media_url: "/api/media/outputs/a.png",
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

function mount() {
  return render(MetadataSidebar, {
    output: output(),
    onedit: vi.fn(),
    onrerun: vi.fn(),
    ondelete: vi.fn(),
  });
}

describe("the metadata sidebar", () => {
  beforeEach(() => {
    library.length = 0;
    library.push(lora("glow.safetensors", A), lora("grain.safetensors", B));
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

  test("a copyable value is a span inside its dd, never the dd", () => {
    // Firefox's plain-text serialiser indents the contents of a `dd` by four
    // spaces whenever the selection spans the element — which is exactly what
    // `user-select: all` makes — so the prompt came back off the clipboard
    // indented on every line, blank ones included.
    mount();
    for (const el of document.querySelectorAll(".selectable")) {
      expect(el.tagName).toBe("SPAN");
      expect(el.parentElement?.tagName).toBe("DD");
    }
    const keys = [...document.querySelectorAll(".row")]
      .filter((row) => row.querySelector(".selectable"))
      .map((row) => row.querySelector("dt")?.textContent?.trim());
    expect(keys).toEqual(["prompt", "seed"]);
  });

  test("the prompt is shown exactly as it was written", () => {
    mount();
    const prompt = [...document.querySelectorAll(".row")]
      .find((row) => row.querySelector("dt")?.textContent?.trim() === "prompt")
      ?.querySelector(".selectable");
    expect(prompt?.textContent).toBe("a red firetruck\n\non a wet street");
  });

  test("a role no param names is still listed once", () => {
    mount();
    // Both LoRAs are named by the `loras` param, so neither is repeated as a
    // role row above it.
    expect(screen.queryAllByText("lora")).toHaveLength(0);
  });
});
