import { assertEquals } from "@std/assert";
import {
  describeNodeErrors,
  validationLog,
  withNodeErrors,
} from "../../src/comfy/errors.ts";

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

Deno.test("ComfyUI's log of a refusal: its validation lines, nothing else from the same moment", () => {
  // What a ComfyUI prints for a refused prompt (execution.py validate_prompt,
  // server.py post_prompt), with a running job's progress bar interleaved
  // and stderr lines carrying the process wrapper's "! " prefix.
  const lines = [
    "got prompt",
    "! Failed to validate prompt for output 9:",
    " 45%|████▌     | 9/20 [00:02<00:02,  4.10it/s]",
    "! * CheckpointLoaderSimple 4:",
    "!   - Value not in list: ckpt_name: 'qwen.safetensors' not in ['v1-5.safetensors']",
    "! * KSampler 3:",
    "!   - Required input is missing: cfg",
    "! Output will be ignored",
    "! invalid prompt: {'type': 'prompt_outputs_failed_validation', 'message': 'Prompt outputs failed validation', 'details': '', 'extra_info': {}}",
  ];
  assertEquals(validationLog(lines), [
    "Failed to validate prompt for output 9:",
    "* CheckpointLoaderSimple 4:",
    "  - Value not in list: ckpt_name: 'qwen.safetensors' not in ['v1-5.safetensors']",
    "* KSampler 3:",
    "  - Required input is missing: cfg",
    "Output will be ignored",
  ]);
  assertEquals(
    validationLog(["got prompt", "Prompt executed in 2.1 seconds"]),
    [],
  );
});

Deno.test("the log as a real ComfyUI 0.34 writes it: coloured level tags", () => {
  // Copied from a managed ComfyUI 0.34.0 refusing sd15 with no checkpoint.
  const lines = [
    "! \x1b[32m[INFO]\x1b[0m got prompt",
    "! \x1b[1m\x1b[31m[ERROR]\x1b[0m Failed to validate prompt for output 9:",
    "! \x1b[1m\x1b[31m[ERROR]\x1b[0m * CheckpointLoaderSimple 1:",
    "! \x1b[1m\x1b[31m[ERROR]\x1b[0m   - Value not in list: ckpt_name: 'v1-5-pruned-emaonly-fp16.safetensors' not in []",
    "! \x1b[1m\x1b[31m[ERROR]\x1b[0m Output will be ignored",
    "! \x1b[1m\x1b[33m[WARNING]\x1b[0m invalid prompt: {'type': 'prompt_outputs_failed_validation', 'message': 'Prompt outputs failed validation', 'details': '', 'extra_info': {}}",
  ];
  assertEquals(validationLog(lines), [
    "Failed to validate prompt for output 9:",
    "* CheckpointLoaderSimple 1:",
    "  - Value not in list: ckpt_name: 'v1-5-pruned-emaonly-fp16.safetensors' not in []",
    "Output will be ignored",
  ]);
});
