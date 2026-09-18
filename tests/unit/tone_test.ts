import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  normaliseTone,
  TONE_PALETTE,
  toneColour,
  waveformColour,
} from "../../src/media/tone.ts";
import { promptText, toneText } from "../../src/jobs/completion.ts";
import { validateManifest } from "../../src/workflows/manifest.ts";
import type { ApiGraph, Manifest } from "../../src/workflows/types.ts";

/**
 * The colour a take is drawn in comes from what it was asked to sound like,
 * and nothing else (DESIGN-AUDIO §11.5). Two properties carry the whole
 * feature: the same tone always lands on the same hue, and the words do not
 * get a vote.
 */

Deno.test("the same tone always picks the same colour", () => {
  const tone = "an older man, warm, unhurried, faint Irish accent";
  assertEquals(toneColour(tone), toneColour(tone));
  assert(TONE_PALETTE.includes(toneColour(tone)!));
});

Deno.test("case, spacing and trailing punctuation are the same voice", () => {
  const colour = toneColour("Warm, thoughtful young woman");
  assertEquals(toneColour("warm, thoughtful young woman."), colour);
  assertEquals(toneColour("  warm,  thoughtful   young woman  "), colour);
  assertEquals(normaliseTone(" Warm,  Thoughtful. "), "warm, thoughtful");
});

Deno.test("different tones are allowed to differ", () => {
  // Not a promise about any two strings — ten hues collide — but these two,
  // which is what stops the test from passing on a constant.
  assertNotEquals(toneColour("neo-soul, brushed drums"), toneColour("a boy"));
});

Deno.test("no tone is no colour, and the waveform keeps its grey", () => {
  for (const empty of [null, undefined, "", "   ", "..."]) {
    assertEquals(toneColour(empty), null, JSON.stringify(empty));
    assertEquals(waveformColour(empty), null, JSON.stringify(empty));
  }
});

Deno.test("ffmpeg is handed the same colour, its own way", () => {
  const colour = toneColour("calm, reflective")!;
  assertEquals(waveformColour("calm, reflective"), `0x${colour.slice(1)}ff`);
});

const graph: ApiGraph = {
  "1": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", direct: false },
  },
  "9": {
    class_type: "SaveAudio",
    inputs: { filename_prefix: "ForgeUI/out", audio: ["8", 0] },
  },
};

function speech(extra: Record<string, unknown>): Manifest {
  return validateManifest({
    id: "fixture",
    name: "Fixture",
    family: null,
    kind: "audio",
    category: null,
    description: null,
    params: [
      { key: "transcript", type: "text", bind: "1.text" },
      { key: "text", type: "text", bind: "1.text" },
      { key: "direct", type: "bool", bind: "1.direct" },
      {
        key: "instruction",
        type: "text",
        bind: "1.text",
        when: { param: "direct", is: true },
      },
    ],
    outputs: [{ node: "9", kind: "audio" }],
    ...extra,
  }, { graph });
}

Deno.test("the tone is the first candidate that applies and says something", () => {
  const manifest = speech({
    prompt: "text",
    tone: ["instruction", "transcript"],
  });
  // Directed: the direction is the tone, however long the transcript is.
  assertEquals(
    toneText(manifest, {
      direct: true,
      instruction: "Speak slowly, restrained.",
      transcript: "the reference clip, transcribed",
      text: "Welcome aboard.",
    }),
    "Speak slowly, restrained.",
  );
  // Not directed: the direction does not apply at all (§4.3), so the clip
  // that was cloned is what this take sounds like.
  assertEquals(
    toneText(manifest, {
      direct: false,
      instruction: "Speak slowly, restrained.",
      transcript: "the reference clip, transcribed",
      text: "Welcome aboard.",
    }),
    "the reference clip, transcribed",
  );
});

Deno.test("an empty candidate is skipped, and nothing left is no tone", () => {
  const manifest = speech({
    prompt: "text",
    tone: ["instruction", "transcript"],
  });
  assertEquals(
    toneText(manifest, { direct: true, instruction: "   ", transcript: "a" }),
    "a",
  );
  assertEquals(toneText(manifest, { direct: true }), null);
  assertEquals(toneText(null, { transcript: "a" }), null);
});

Deno.test("the prompt is the param the manifest names, not the first text", () => {
  const manifest = speech({ prompt: "text", tone: ["transcript"] });
  assertEquals(
    promptText(manifest, { transcript: "a voice", text: "Welcome aboard." }),
    "Welcome aboard.",
  );
  // Without the field it is still the first text param, as it always was.
  assertEquals(
    promptText(speech({}), { transcript: "a voice", text: "Welcome aboard." }),
    "a voice",
  );
});
