import { assertEquals, assertThrows } from "@std/assert";
import {
  ManifestError,
  validateManifest,
} from "../../src/workflows/manifest.ts";
import { coerceParams, ParamError } from "../../src/workflows/coerce.ts";
import { applicableParams } from "../../src/workflows/visibility.ts";
import type { ApiGraph, Manifest } from "../../src/workflows/types.ts";

/**
 * `when`: a param applies only while another holds a given value (§4.3).
 *
 * The point is a graph switch that leaves part of the panel doing nothing —
 * Anima's Turbo routes steps and cfg to a different pair of primitives — and
 * the thing that has to hold is that the panel and the server agree, because
 * a required field nobody can see is a submit button that refuses with no way
 * to find out why.
 */

const graph: ApiGraph = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "b.safetensors" },
  },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 8,
      model: ["1", 0],
      positive: ["6", 0],
      negative: ["6", 0],
      latent_image: ["5", 0],
    },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["3", 0], vae: ["1", 2] },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ForgeUI/out", images: ["8", 0] },
  },
  "10": { class_type: "LoadImage", inputs: { image: "example.png" } },
};

function manifest(params: unknown[]): Manifest {
  return validateManifest({
    id: "fixture",
    name: "Fixture",
    family: "sdxl",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });
}

const TURBO = { key: "turbo", type: "bool", default: false, bind: "3.seed" };
const STEPS = {
  key: "steps",
  type: "int",
  bind: "3.steps",
  when: { param: "turbo", is: false },
};
const TURBO_STEPS = {
  key: "turbo_steps",
  type: "int",
  bind: "3.cfg",
  when: { param: "turbo", is: true },
};

Deno.test("a param applies only while its condition holds", () => {
  const m = manifest([TURBO, STEPS, TURBO_STEPS]);
  const keys = (values: Record<string, unknown>) =>
    applicableParams(m, values).map((param) => param.key);

  assertEquals(keys({ turbo: false }), ["turbo", "steps"]);
  assertEquals(keys({ turbo: true }), ["turbo", "turbo_steps"]);
  // The switch itself always applies: nothing gates it.
  assertEquals(keys({}), ["turbo"]);
});

Deno.test("required is checked against what applies, not the whole manifest", () => {
  const m = manifest([
    TURBO,
    {
      key: "image",
      type: "image",
      required: true,
      bind: "10.image",
      when: { param: "turbo", is: true },
    },
  ]);

  // Off: the field is not on screen, so it cannot refuse the job. There
  // would be nothing to go and fill in.
  const off = coerceParams(m, { turbo: false });
  assertEquals(off.values.image, null);

  // On: it is on screen and empty, so it refuses — and names itself.
  const thrown = assertThrows(
    () => coerceParams(m, { turbo: true }),
    ParamError,
    "is required",
  );
  assertEquals((thrown as ParamError).key, "image");

  // On and filled: through.
  assertEquals(
    coerceParams(m, { turbo: true, image: "abc.png" }).values.image,
    "abc.png",
  );
});

Deno.test("a param that does not apply still carries a value into the graph", () => {
  // Hiding is about the panel, not about the graph: the switch routes around
  // the node, so what its widget holds is simply never read.
  const m = manifest([TURBO, STEPS]);
  const { values } = coerceParams(m, { turbo: true, steps: 30 });
  assertEquals(values.steps, 30);
});

Deno.test("a condition naming nothing is refused at load", () => {
  assertThrows(
    () =>
      manifest([{
        key: "steps",
        type: "int",
        bind: "3.steps",
        when: { param: "nope", is: true },
      }]),
    ManifestError,
    'no param "nope"',
  );
});

Deno.test("a condition cannot depend on itself, directly or round a ring", () => {
  assertThrows(
    () =>
      manifest([{
        key: "steps",
        type: "int",
        bind: "3.steps",
        when: { param: "steps", is: 1 },
      }]),
    ManifestError,
    "cannot decide whether it applies itself",
  );
  // a → b → a: no value either could hold settles it.
  assertThrows(
    () =>
      manifest([
        {
          key: "a",
          type: "bool",
          bind: "3.seed",
          when: { param: "b", is: true },
        },
        {
          key: "b",
          type: "bool",
          bind: "3.steps",
          when: { param: "a", is: true },
        },
      ]),
    ManifestError,
    "depends on itself through another param",
  );
});

Deno.test("the comparison is exact, so a checkbox is not a truthy string", () => {
  const m = manifest([TURBO, STEPS]);
  const applies = (turbo: unknown) =>
    applicableParams(m, { turbo }).map((param) => param.key);
  assertEquals(applies(false), ["turbo", "steps"]);
  // `"false"` is not `false`; a manifest saying `is: false` means the boolean.
  assertEquals(applies("false"), ["turbo"]);
  assertEquals(applies(0), ["turbo"]);
});
