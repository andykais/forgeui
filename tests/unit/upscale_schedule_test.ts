import { assertEquals } from "@std/assert";

/**
 * What "creativity" means on the upscale workflow (§10).
 *
 * The first version bound it to `KSampler.denoise`, which is a different
 * thing from the control SwarmUI exposes under the same idea: ComfyUI's
 * `denoise` builds a schedule of `int(steps/denoise)` and keeps the tail
 * (`comfy/samplers.py` `KSampler.set_steps`), so the model walks a step
 * spacing it was never distilled for, and the step *count* never falls as
 * the strength does. `BasicScheduler` + `SplitSigmasDenoise` cut the model's
 * own schedule instead, which is what `start_at_step` does for SwarmUI.
 *
 * This reproduces both in plain arithmetic, so the difference stays a fact
 * rather than an argument.
 */

/** Krea 2's flow schedule: shift 1.15, multiplier 1.0 (ComfyUI supported_models). */
function kreaSigmas(steps: number): number[] {
  const shift = 1.15;
  const table: number[] = [];
  for (let i = 1; i <= 1000; i++) {
    const t = i / 1000;
    table.push((shift * t) / (1 + (shift - 1) * t));
  }
  // comfy/samplers.py simple_scheduler
  const ss = table.length / steps;
  const sigmas: number[] = [];
  for (let x = 0; x < steps; x++) {
    sigmas.push(table[table.length - (1 + Math.trunc(x * ss))]!);
  }
  return [...sigmas, 0];
}

/** The old binding: `KSampler(steps, denoise)`. */
function viaDenoise(steps: number, denoise: number): number[] {
  const full = kreaSigmas(Math.trunc(steps / denoise));
  return full.slice(full.length - (steps + 1));
}

/** The new one: `BasicScheduler(steps)` cut by `SplitSigmasDenoise`. */
function viaSplit(steps: number, creativity: number): number[] {
  const full = kreaSigmas(steps);
  const keep = Math.round(steps * creativity);
  return full.slice(full.length - (keep + 1));
}

const round = (x: number) => Math.round(x * 1000) / 1000;

Deno.test("creativity cuts the model's own schedule, and its step count with it", () => {
  const sigmas = viaSplit(8, 0.2);
  // Two steps of the native eight, starting where the eighth-step schedule
  // says 0.2 of the way from the end is.
  assertEquals(sigmas.length - 1, 2);
  assertEquals(round(sigmas[0]!), 0.277);
  // Raising it runs more of the same schedule, not a different one.
  const more = viaSplit(8, 0.5);
  assertEquals(more.length - 1, 4);
  assertEquals(round(more[0]!), 0.535);
  assertEquals(
    kreaSigmas(8).slice(4).map(round),
    more.map(round),
    "the tail of the native schedule, unchanged",
  );
});

Deno.test("`denoise` would have started hotter and never shortened", () => {
  // The bug this workflow shipped with: 0.4 of a schedule stretched to 20.
  const old = viaDenoise(8, 0.4);
  assertEquals(old.length - 1, 8, "eight steps however low the strength goes");
  assertEquals(round(old[0]!), 0.434);

  // Same nominal number, the new binding: hardly more than a third the noise
  // and a quarter the steps.
  const now = viaSplit(8, 0.2);
  assertEquals(round(now[0]!), 0.277);
  assertEquals(now.length - 1, 2);

  // And most of the spacing `denoise` produces is off the model's own grid,
  // which is what a distilled 8-step model has no training for. (One of the
  // eight lands on a native sigma by coincidence; seven do not.)
  const native = new Set(kreaSigmas(8).map(round));
  const offGrid = old.slice(0, -1).map(round).filter((s) => !native.has(s));
  assertEquals(offGrid.length, 7);
  assertEquals(
    now.slice(0, -1).map(round).every((sigma) => native.has(sigma)),
    true,
    "every step the split takes is one the model was distilled on",
  );
});
