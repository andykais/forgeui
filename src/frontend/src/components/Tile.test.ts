import { describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import Tile from "./Tile.svelte";
import type { Output } from "../types.ts";

/**
 * A tile of sound (§11.5): the tone above the waveform, in the hue the
 * waveform itself was drawn in, and the words still in the strip below. All
 * three, each said once — the prompt was already down there, so repeating it
 * in the picture would only shrink the shape.
 */

function output(extra: Partial<Output> = {}): Output {
  return {
    id: "01JOUT",
    job_id: "01J",
    path: "outputs/a.flac",
    sidecar_path: "outputs/a.json",
    kind: "audio",
    width: null,
    height: null,
    duration_ms: 4000,
    sha256: null,
    workflow_id: "breeze-tts-design",
    workflow_hash: "h",
    family: null,
    prompt: "Welcome aboard. Your journey begins now.",
    tone: "a warm, thoughtful young woman",
    tone_color: "#d0a06a",
    params: {},
    deleted_at: null,
    created_at: 1_789_000_000_000,
    media_url: "/api/media/outputs/a.flac",
    waveform_url: "/api/media/outputs/a.flac.waveform.png",
    generation_ms: 900,
    models: [],
    ...extra,
  };
}

describe("an audio tile", () => {
  test("shows the tone above, and the prompt below, in one tile", () => {
    render(Tile, { output: output() });
    const tone = document.querySelector(".tone");
    expect(tone?.textContent).toBe("a warm, thoughtful young woman");
    // The line is drawn in the tone's own colour, which is the colour the
    // waveform under it was drawn in.
    // jsdom normalises the hex to rgb() on its way into the style attribute.
    expect(tone?.getAttribute("style")).toContain("rgb(208, 160, 106)");
    expect(document.querySelector(".prompt")?.textContent).toBe(
      "Welcome aboard. Your journey begins now.",
    );
    expect(document.querySelector(".length")?.textContent?.trim()).toBe("0:04");
  });

  test("a take with no tone is a waveform and nothing else", () => {
    render(Tile, { output: output({ tone: null, tone_color: null }) });
    expect(document.querySelector(".tone")).toBe(null);
  });

  test("a picture has no tone, whatever its params say", () => {
    render(
      Tile,
      {
        output: output({
          kind: "image",
          tone: "a warm, thoughtful young woman",
          tone_color: "#d0a06a",
          waveform_url: null,
        }),
      },
    );
    expect(document.querySelector(".tone")).toBe(null);
  });
});
