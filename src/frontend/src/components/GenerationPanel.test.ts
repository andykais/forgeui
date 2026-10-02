import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { ModelEntry, SampleRaw } from "../types.ts";

/**
 * An imported sample's generation data (§8.3): what it shows, and where each
 * model it names links to — here when the library has it, Civitai otherwise.
 */

const library: Partial<ModelEntry>[] = [];
vi.mock("../stores/app.svelte.ts", () => ({
  app: {
    get allModels() {
      return library;
    },
  },
}));
vi.mock("../stores/toasts.svelte.ts", () => ({ toasts: { message: vi.fn() } }));

const { default: GenerationPanel } = await import("./GenerationPanel.svelte");

const raw: SampleRaw = {
  format: "civitai-meta",
  fields: {
    prompt: "a lighthouse keeper at dusk",
    negative_prompt: "blurry",
    seed: 2870305590,
    steps: 30,
    cfg: 5.5,
    sampler: "DPM++ 2M",
    width: 832,
    height: 1216,
    clip_skip: 2,
    model: "Juggernaut XL v9",
    model_version_id: 290640,
    loras: [
      { name: "Film Grain 35mm", weight: 0.8, model_version_id: 123456 },
      { name: "add_detail", weight: 1, hash: "7c6bad76eb54" },
      { name: "Somebody Else's", weight: 0.4, model_version_id: 999 },
    ],
  },
};

describe("the generation panel", () => {
  test("shows the prompt, the negative and the settings", () => {
    render(GenerationPanel, { raw });
    expect(screen.getByText("a lighthouse keeper at dusk")).toBeTruthy();
    expect(screen.getByText("blurry")).toBeTruthy();
    expect(screen.getByText("2870305590")).toBeTruthy();
    expect(screen.getByText("832 × 1216")).toBeTruthy();
    expect(screen.getByText("clip skip")).toBeTruthy();
    expect(screen.getByText("Civitai")).toBeTruthy();
  });

  test("a LoRA in the library links to its page, by Civitai version", () => {
    library.length = 0;
    library.push({
      hash: "f".repeat(64),
      display_name: "Film grain (mine)",
      source: {
        source: {
          kind: "civitai",
          label: "Civitai",
          url: null,
          model_id: 1,
          model_version_id: 123456,
          fetched_at: null,
        },
      },
    } as Partial<ModelEntry>);
    render(GenerationPanel, { raw, sourceUrl: "https://civitai.com/images/1" });

    const mine = screen.getByText("Film grain (mine)").closest("a")!;
    expect(mine.getAttribute("href")).toBe(`/models/${"f".repeat(64)}`);

    // Not ours, but Civitai knows the version.
    const theirs = screen.getByText(/Somebody Else's/).closest("a")!;
    expect(theirs.getAttribute("href")).toBe("https://civitai.com/model-versions/999");
    // A1111's short LoRA hash matches nothing here, and is not a link.
    expect(screen.getByText("add_detail").closest("a")).toBeNull();
    // The checkpoint is not in the library either.
    expect(
      screen
        .getByText(/Juggernaut XL v9/)
        .closest("a")!
        .getAttribute("href"),
    ).toBe("https://civitai.com/model-versions/290640");
  });

  test("a mirror's samples link to the mirror", () => {
    library.length = 0;
    render(GenerationPanel, {
      raw,
      sourceUrl: "https://civitai.red/images/26534668",
    });
    expect(
      screen
        .getByText(/Juggernaut XL v9/)
        .closest("a")!
        .getAttribute("href"),
    ).toBe("https://civitai.red/model-versions/290640");
  });
});
