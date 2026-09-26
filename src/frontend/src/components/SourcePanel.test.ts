import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SourcePanel from "./SourcePanel.svelte";
import type { ModelSource } from "../types.ts";

/**
 * The model page's source panel (DESIGN-MODEL-IMPORT §7.5). Two of these are
 * about safety rather than looks: the description is rendered as text, and no
 * image inside it is ever loaded.
 */

function source(overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    format: 1,
    source: {
      kind: "civitai",
      label: "Civitai",
      url: "https://civitai.red/models/4384?modelVersionId=128713",
      model_id: 4384,
      model_version_id: 128713,
      fetched_at: "2026-09-25T10:00:00Z",
    },
    creator: { username: "Lykon", url: "https://civitai.red/user/Lykon" },
    model: {
      name: "DreamShaper",
      tags: ["photorealistic", "base model"],
      description_text: "# DreamShaper\n\nA photoreal finetune.",
    },
    version: {
      name: "8",
      base_model: "SD 1.5",
      description_text: "Better at handling Character LoRA.",
    },
    ...overrides,
  };
}

describe("SourcePanel", () => {
  test("names where it came from, who wrote it, and links out", () => {
    render(SourcePanel, { source: source() });
    expect(screen.getByText("From Civitai")).toBeTruthy();
    expect(screen.getByText("by Lykon")).toBeTruthy();
    expect(screen.getByText("SD 1.5")).toBeTruthy();

    const link = screen.getByRole("link", { name: /Civitai/ });
    expect(link.getAttribute("href")).toBe(
      "https://civitai.red/models/4384?modelVersionId=128713",
    );
    // Somebody else's link, opened somewhere else, carrying nothing of ours.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  test("prefers the version's description over the model's", () => {
    render(SourcePanel, { source: source() });
    expect(screen.getByText("Better at handling Character LoRA.")).toBeTruthy();
  });

  test("renders the description as text, never as markup", () => {
    // The server only ever sends `description_text`, but if markup reached
    // this component it must still land on the page as characters.
    const { container } = render(SourcePanel, {
      source: source({
        version: {
          description_text:
            '<img src="https://image.civitai.com/x.png">' +
            "<b>bold</b> and <script>alert(1)</script>",
        },
      }),
    });
    const body = container.querySelector(".body")!;
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("b")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("<b>bold</b>");
  });

  test("loads no image at all, whatever the description holds", () => {
    const { container } = render(SourcePanel, {
      source: source({
        version: {
          description_text: "look: ![pic](https://image.civitai.com/x.png)",
        },
      }),
    });
    // Nothing in this panel may cause a request to a third party when a model
    // page is opened.
    expect(container.querySelectorAll("img").length).toBe(0);
  });

  test("offers the trigger words as things to copy", () => {
    render(SourcePanel, {
      source: null,
      triggerWords: ["cyberrealistic", "photo"],
    });
    expect(screen.getByText("trigger words")).toBeTruthy();
    expect(screen.getByRole("button", { name: /cyberrealistic/ })).toBeTruthy();
  });

  test("draws nothing when nobody has fetched anything", () => {
    const { container } = render(SourcePanel, {
      source: null,
      triggerWords: [],
    });
    expect(container.textContent?.trim()).toBe("");
  });

  test("shows the upstream tags apart from the model's own", () => {
    render(SourcePanel, { source: source() });
    expect(screen.getByText("their tags")).toBeTruthy();
    expect(screen.getByText("photorealistic")).toBeTruthy();
  });
});
