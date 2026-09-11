import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import ModelCard from "./ModelCard.svelte";
import SamplesStrip from "./SamplesStrip.svelte";
import type { ModelEntry, Sample } from "../types.ts";

/**
 * The Models grid card and the Samples strip (§11.2, §8.3): what a card says
 * about a model that has not been hashed yet, how a family is set from the
 * card, and the two actions a sample's hover menu offers.
 */

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "a".repeat(64),
    hash: "a".repeat(64),
    path: "/models/loras/film-grain-35mm.safetensors",
    name: "film-grain-35mm.safetensors",
    filename: "film-grain-35mm.safetensors",
    display_name: "Film grain 35mm",
    family: "sd15",
    kind: "loras",
    class: "lora",
    size: 145_000_000,
    mtime: 1_780_000_000_000,
    notes: null,
    tags: [],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 12,
    last_used_at: null,
    hashing: false,
    present: true,
    ...overrides,
  };
}

describe("the model card", () => {
  test("shows the family, the size and a link to what it made", () => {
    render(ModelCard, { model: model(), onfamily: vi.fn() });

    expect(screen.getByText("Film grain 35mm")).toBeTruthy();
    expect(screen.getByText("sd15")).toBeTruthy();
    const outputs = screen.getByText("12 outputs") as HTMLAnchorElement;
    expect(outputs.getAttribute("href")).toBe(`/gallery?models=${"a".repeat(64)}`);
  });

  test("a model with no hash yet says so and offers no family control", () => {
    render(ModelCard, {
      model: model({ hash: null, id: "path:abc", hashing: true, family: "unset" }),
      onfamily: vi.fn(),
    });

    expect(screen.getByText("hashing")).toBeTruthy();
    // Nothing about it can be edited until it has an identity (§8.1).
    expect(screen.queryByText(/SET FAMILY/)).toBeNull();
  });

  test("SET FAMILY sets one from the hardcoded list", async () => {
    const onfamily = vi.fn();
    render(ModelCard, { model: model({ family: "unset" }), onfamily });

    await fireEvent.click(screen.getByText(/SET FAMILY/));
    await fireEvent.click(screen.getByText("flux"));

    expect(onfamily).toHaveBeenCalledTimes(1);
    expect(onfamily.mock.calls[0]?.[1]).toBe("flux");
  });

  test("a family that is already set can be changed from the card", async () => {
    // It used to be a plain badge: re-filing a model meant opening its page.
    const onfamily = vi.fn();
    render(ModelCard, { model: model({ family: "sd15" }), onfamily });

    await fireEvent.click(screen.getByTitle("Set this model's family"));
    await fireEvent.click(screen.getByText("sdxl"));

    expect(onfamily.mock.calls[0]?.[1]).toBe("sdxl");
  });

  test("the list escapes the card, which clips its own overflow", async () => {
    render(ModelCard, { model: model(), onfamily: vi.fn() });
    await fireEvent.click(screen.getByTitle("Set this model's family"));

    // Anchored in viewport coordinates: `overflow: hidden` on the card would
    // otherwise take the list with it, and it never appeared at all.
    const popover = screen.getByRole("dialog", { name: "Family" });
    expect(popover.className).toContain("fixed");
    expect(popover.style.top).not.toBe("");
    expect(popover.style.left).not.toBe("");
  });

  test("the search box narrows the families", async () => {
    render(ModelCard, { model: model(), onfamily: vi.fn() });
    await fireEvent.click(screen.getByTitle("Set this model's family"));

    const search = screen.getByLabelText("Search families");
    // The caret is taken on the frame after the click that opened it.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(search);
    await fireEvent.input(search, { target: { value: "flux" } });

    expect(screen.getByText("flux")).toBeTruthy();
    expect(screen.getByText("flux2")).toBeTruthy();
    expect(screen.queryByText("sdxl")).toBeNull();
  });

  test("the arrow keys walk the list and Enter takes one", async () => {
    const onfamily = vi.fn();
    render(ModelCard, { model: model(), onfamily });
    await fireEvent.click(screen.getByTitle("Set this model's family"));

    const search = screen.getByLabelText("Search families");
    // Down from nothing takes the first, so three downs reach the third.
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    await fireEvent.keyDown(search, { key: "ArrowUp" });
    const active = document.querySelector("[data-active='true']");
    expect(active?.textContent?.trim()).toBe("flux2");

    await fireEvent.keyDown(search, { key: "Enter" });
    expect(onfamily.mock.calls[0]?.[1]).toBe("flux2");
  });
});

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: "01JSAMPLE",
    model_hash: "a".repeat(64),
    path: `samples/${"a".repeat(64)}/01JSAMPLE.png`,
    sidecar_path: `samples/${"a".repeat(64)}/01JSAMPLE.json`,
    kind: "image",
    source_url: null,
    params: null,
    created_at: 1_780_000_000_000,
    media_url: `/api/media/samples/${"a".repeat(64)}/01JSAMPLE.png`,
    reusable: false,
    ...overrides,
  };
}

describe("the samples strip", () => {
  test("offers Set as thumbnail and Delete, and Edit only on promotions", () => {
    const { unmount } = render(SamplesStrip, {
      samples: [sample()],
      onimport: vi.fn(),
      onthumb: vi.fn(),
      ondelete: vi.fn(),
      onedit: vi.fn(),
    });

    expect(screen.getByLabelText("Set 01JSAMPLE as thumbnail")).toBeTruthy();
    expect(screen.getByLabelText("Delete sample 01JSAMPLE")).toBeTruthy();
    // A dropped file has nothing to reuse (§8.3).
    expect(screen.queryByLabelText("Edit 01JSAMPLE in Generate")).toBeNull();
    unmount();

    render(SamplesStrip, {
      samples: [sample({ reusable: true, params: { seed: 7 } })],
      onimport: vi.fn(),
      onthumb: vi.fn(),
      ondelete: vi.fn(),
      onedit: vi.fn(),
    });
    expect(screen.getByLabelText("Edit 01JSAMPLE in Generate")).toBeTruthy();
  });

  test("the chosen thumbnail is marked, and the actions report the sample", async () => {
    const onthumb = vi.fn();
    const ondelete = vi.fn();
    const chosen = sample();
    render(SamplesStrip, {
      samples: [chosen],
      thumbPath: chosen.path,
      onimport: vi.fn(),
      onthumb,
      ondelete,
      onedit: vi.fn(),
    });

    expect(screen.getByText("thumbnail")).toBeTruthy();
    await fireEvent.click(screen.getByLabelText("Set 01JSAMPLE as thumbnail"));
    await fireEvent.click(screen.getByLabelText("Delete sample 01JSAMPLE"));
    expect(onthumb.mock.calls[0]?.[0]).toMatchObject({ id: "01JSAMPLE" });
    expect(ondelete.mock.calls[0]?.[0]).toMatchObject({ id: "01JSAMPLE" });
  });

  test("a dropped file is handed over as it arrives", async () => {
    const onimport = vi.fn();
    render(SamplesStrip, {
      samples: [],
      onimport,
      onthumb: vi.fn(),
      ondelete: vi.fn(),
      onedit: vi.fn(),
    });

    const file = new File([new Uint8Array([1, 2, 3])], "reference.png", {
      type: "image/png",
    });
    await fireEvent.drop(screen.getByText("Drop a file"), {
      dataTransfer: { files: [file] },
    });
    expect(onimport).toHaveBeenCalledTimes(1);
    expect(onimport.mock.calls[0]?.[0][0].name).toBe("reference.png");
  });
});
