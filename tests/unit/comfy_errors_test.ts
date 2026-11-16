import { assertEquals } from "@std/assert";
import { describeNodeErrors, withNodeErrors } from "../../src/comfy/errors.ts";

/** `node_errors` as a real ComfyUI's `/prompt` sends it (execution.py). */
const REAL = {
  "3": {
    errors: [{
      type: "value_not_in_list",
      message: "Value not in list",
      details: "sampler_name: 'eulr' not in (list of length 40)",
      extra_info: { input_name: "sampler_name", received_value: "eulr" },
    }],
    dependent_outputs: ["9"],
    class_type: "KSampler",
  },
  "9": {
    errors: [{
      type: "required_input_missing",
      message: "Required input is missing",
      details: "",
      extra_info: { input_name: "images" },
    }],
    dependent_outputs: ["9"],
    class_type: "SaveImage",
  },
};

Deno.test("one line per reason, naming the node and the input", () => {
  assertEquals(describeNodeErrors(REAL), [
    `node "3" (KSampler): Value not in list: sampler_name: 'eulr' not in (list of length 40)`,
    `node "9" (SaveImage): Required input is missing: images`,
  ]);
});

Deno.test("the top-level message keeps ComfyUI's words and lists the reasons under it", () => {
  assertEquals(
    withNodeErrors("Prompt outputs failed validation", REAL),
    "Prompt outputs failed validation:\n" +
      `- node "3" (KSampler): Value not in list: sampler_name: 'eulr' not in (list of length 40)\n` +
      `- node "9" (SaveImage): Required input is missing: images`,
  );
  assertEquals(
    withNodeErrors("Prompt has no outputs", {}),
    "Prompt has no outputs",
  );
});

Deno.test("a pasted option list is clipped, and a flood of errors is capped", () => {
  const long = describeNodeErrors({
    "1": {
      class_type: "CheckpointLoaderSimple",
      errors: [{ message: "Value not in list", details: "x".repeat(5000) }],
    },
  });
  assertEquals(long[0]!.length < 500, true);
  assertEquals(long[0]!.endsWith("…"), true);

  const many: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) {
    many[String(i)] = { class_type: "X", errors: [{ message: "bad" }] };
  }
  const lines = describeNodeErrors(many);
  assertEquals(lines.length, 21);
  assertEquals(lines.at(-1), "… and 10 more");
});

Deno.test("anything not in ComfyUI's shape is skipped, not guessed at", () => {
  assertEquals(describeNodeErrors(null), []);
  assertEquals(describeNodeErrors({ "1": "nope", "2": { errors: ["x"] } }), []);
  assertEquals(describeNodeErrors({ "4": { class_type: "Foo", errors: [] } }), [
    `node "4" (Foo): failed validation`,
  ]);
});
