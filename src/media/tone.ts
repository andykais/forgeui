/**
 * The colour a take is drawn in, from the tone it was asked for
 * (DESIGN-AUDIO §2.2, §11.5).
 *
 * A grid of sound is a grid of waveforms, and waveforms of speech all look
 * roughly alike — a row of grey hedges. The one thing that does separate them
 * is what they sound like, which is the one thing a picture of the amplitude
 * cannot show. So the tone picks the colour: every take made with the same
 * voice, or the same style tags, comes out the same hue, and a grid sorts
 * itself by ear without anybody reading a word of it.
 *
 * The hue comes from the tone and not from the prompt on purpose. Colouring
 * by the words would give one voice a different colour every take, which is
 * the opposite of the grouping this is for.
 */

/**
 * Ten hues around the wheel, all held to roughly one lightness and a low
 * saturation. Muted is the requirement rather than the taste: these are the
 * loudest thing on a page of forty tiles, and a full-strength wheel there is
 * a bag of sweets. Around this value they read as tinted paper — different
 * enough to group by, quiet enough to look at.
 */
export const TONE_PALETTE: readonly string[] = [
  "#6fb6c8", // cyan
  "#7fbf9a", // green
  "#9ab87a", // olive
  "#bfae63", // gold
  "#d0a06a", // amber
  "#cf8f7a", // terracotta
  "#cf8fa8", // rose
  "#b083b8", // mauve
  "#a68fce", // violet
  "#8f9fd4", // periwinkle
];

/**
 * The tone as the palette keys on it: case, spacing and trailing punctuation
 * are not a different voice. "Warm, thoughtful." and "warm thoughtful" are
 * one tone and have to land on one colour, or the grouping is defeated by a
 * capital letter.
 */
export function normaliseTone(tone: string): string {
  return tone
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/^[\s.,;:!?'"\-–—]+|[\s.,;:!?'"\-–—]+$/g, "")
    .trim();
}

/**
 * FNV-1a, 32-bit. Synchronous and tiny, which is what this needs: the only
 * property being asked for is that the same text always picks the same hue
 * and different texts spread out.
 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    // The FNV prime, by shifts, so this stays in 32 bits without BigInt.
    value = (value + (value << 1) + (value << 4) + (value << 7) +
      (value << 8) + (value << 24)) >>> 0;
  }
  return value >>> 0;
}

/** `#rrggbb` for a tone, or null when there is no tone to colour by. */
export function toneColour(tone: string | null | undefined): string | null {
  if (typeof tone !== "string") return null;
  const key = normaliseTone(tone);
  if (key === "") return null;
  return TONE_PALETTE[hash(key) % TONE_PALETTE.length]!;
}

/**
 * The same colour as ffmpeg spells it: `0xRRGGBBAA`. A take with no tone
 * keeps the grey the waveform has always been drawn in, which is also what
 * every take made before this existed still looks like.
 */
export function waveformColour(tone: string | null | undefined): string | null {
  const colour = toneColour(tone);
  return colour === null ? null : `0x${colour.slice(1)}ff`;
}
