import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import SourcePanel from "./SourcePanel.svelte";
import type { ModelSource } from "../types.ts";

/**
 * The model page's source panel (DESIGN-MODEL-IMPORT §7.5). Two of these are
 * about safety rather than looks: no markup a stranger wrote reaches the page
 * as markup, and no image inside the description is ever loaded.
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

  test("shows the version's description, then the model's overview", () => {
    // The version's is what this file is; the overview is where an author
    // puts what applies to all of them — which download is which, say — so
    // neither stands in for the other.
    const { container } = render(SourcePanel, { source: source() });
    const blocks = [...container.querySelectorAll<HTMLElement>(".description")];
    expect(blocks.map((block) => block.dataset.title)).toEqual([
      "This version · 8",
      "Overview",
    ]);
    expect(blocks[0]!.textContent).toContain("Better at handling Character LoRA.");
    expect(blocks[1]!.querySelector("h1")?.textContent).toBe("DreamShaper");
  });

  test("the overview alone, when the version has none", () => {
    const { container } = render(SourcePanel, {
      source: source({ version: { name: "8", description_text: null } }),
    });
    const titles = [...container.querySelectorAll<HTMLElement>(".description")].map(
      (block) => block.dataset.title,
    );
    expect(titles).toEqual(["Overview"]);
  });

  test("the same text in both is shown once", () => {
    const same = "One description, pasted into both.";
    const { container } = render(SourcePanel, {
      source: source({
        model: { name: "M", description_text: same },
        version: { name: "1", description_text: same },
      }),
    });
    expect(container.querySelectorAll(".description").length).toBe(1);
    expect(screen.getAllByText(same).length).toBe(1);
  });

  test("renders the Markdown by default, and the source on request", async () => {
    const { container } = render(SourcePanel, {
      source: source({
        version: {
          description_text:
            "## Usage\n\n- **cfg** 4\n- see [the guide](https://example.com/g)",
        },
      }),
    });
    const block = container.querySelector<HTMLElement>('[data-title^="This version"]')!;
    const body = () => block.querySelector(".body")!;
    const button = (name: string) => within(block).getByRole("button", { name });
    expect(body().querySelector("h2")?.textContent).toBe("Usage");
    expect(body().querySelector("li strong")?.textContent).toBe("cfg");
    const link = body().querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/g");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(button("Preview").getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(button("Source"));
    expect(body().querySelector("h2")).toBeNull();
    expect(body().textContent).toContain("## Usage");
    expect(body().textContent).toContain("[the guide](https://example.com/g)");

    // Each description has its own toggle: the overview is still rendered.
    const overview = container.querySelector<HTMLElement>('[data-title="Overview"]')!;
    expect(overview.querySelector(".body.rendered")).not.toBeNull();

    await fireEvent.click(button("Preview"));
    expect(body().querySelector("h2")).not.toBeNull();
  });

  test("never renders markup a stranger wrote, in either view", async () => {
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
    const block = container.querySelector<HTMLElement>('[data-title^="This version"]')!;
    for (const view of ["Preview", "Source"]) {
      await fireEvent.click(within(block).getByRole("button", { name: view }));
      const body = block.querySelector(".body")!;
      expect(body.querySelector("img")).toBeNull();
      expect(body.querySelector("b")).toBeNull();
      expect(body.querySelector("script")).toBeNull();
      expect(body.textContent).toContain("<b>bold</b>");
    }
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
