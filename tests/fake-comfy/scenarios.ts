/**
 * Scenarios are data: a list of steps the fake ComfyUI replays for one
 * prompt. §14.1 requires coverage of success, multi-output, error mid-graph,
 * cancel while queued, cancel while running, WS disconnect + reconnect, and
 * death before `executed`.
 */

/** How a step names a node: an id, the nth output node, or the sampler. */
export type NodeRef =
  | string
  | { nth: number }
  | { save: number }
  | { sampler: true };

export type Step =
  | { kind: "status"; queue_remaining?: number }
  | { kind: "execution_start" }
  | { kind: "execution_cached"; nodes?: NodeRef[] }
  | { kind: "executing"; node: NodeRef | null }
  | { kind: "progress"; node: NodeRef; value: number; max: number }
  | { kind: "preview"; node?: NodeRef; format?: "png" | "jpeg" }
  | { kind: "executed"; node: NodeRef; images?: number }
  | { kind: "execution_success" }
  | {
    kind: "execution_error";
    node: NodeRef;
    message?: string;
    exception_type?: string;
  }
  | { kind: "delay"; ms: number }
  /** Park until the test calls `openGate(name)`. */
  | { kind: "gate"; name: string }
  /** Drop every websocket, as if ComfyUI's server went away. */
  | { kind: "drop_sockets" }
  /** Stop replaying and leave the prompt unfinished, as if the process died. */
  | { kind: "die" };

export interface Scenario {
  name: string;
  /** Keep the prompt in `queue_pending` until this gate opens. */
  hold?: string;
  steps: Step[];
}

export const SCENARIO_NAMES = [
  "success",
  "multi-output",
  "error-mid-graph",
  "cancel-while-queued",
  "cancel-while-running",
  "ws-reconnect",
  "death-before-executed",
] as const;

export type ScenarioName = typeof SCENARIO_NAMES[number];

const sampler: NodeRef = { sampler: true };

const successSteps: Step[] = [
  { kind: "execution_start" },
  { kind: "execution_cached", nodes: [] },
  { kind: "executing", node: sampler },
  { kind: "progress", node: sampler, value: 1, max: 4 },
  { kind: "preview", node: sampler },
  { kind: "progress", node: sampler, value: 4, max: 4 },
  { kind: "executing", node: { save: 0 } },
  { kind: "executed", node: { save: 0 }, images: 1 },
  { kind: "executing", node: null },
  { kind: "execution_success" },
];

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "success": { name: "success", steps: successSteps },

  "multi-output": {
    name: "multi-output",
    steps: [
      { kind: "execution_start" },
      { kind: "executing", node: sampler },
      { kind: "progress", node: sampler, value: 4, max: 4 },
      { kind: "executing", node: { save: 0 } },
      { kind: "executed", node: { save: 0 }, images: 2 },
      // Skipped when the graph has a single output node.
      { kind: "executing", node: { save: 1 } },
      { kind: "executed", node: { save: 1 }, images: 1 },
      { kind: "executing", node: null },
      { kind: "execution_success" },
    ],
  },

  "error-mid-graph": {
    name: "error-mid-graph",
    steps: [
      { kind: "execution_start" },
      { kind: "executing", node: sampler },
      { kind: "progress", node: sampler, value: 1, max: 4 },
      {
        kind: "execution_error",
        node: sampler,
        message: "Allocation on device 0 would exceed allowed memory",
        exception_type: "torch.OutOfMemoryError",
      },
    ],
  },

  /** Never starts on its own; the test deletes it from the queue. */
  "cancel-while-queued": {
    name: "cancel-while-queued",
    hold: "start",
    steps: successSteps,
  },

  /** Parks mid-sampling so the test can call `/interrupt`. */
  "cancel-while-running": {
    name: "cancel-while-running",
    steps: [
      { kind: "execution_start" },
      { kind: "executing", node: sampler },
      { kind: "progress", node: sampler, value: 1, max: 8 },
      { kind: "gate", name: "interrupt" },
      { kind: "executing", node: { save: 0 } },
      { kind: "executed", node: { save: 0 }, images: 1 },
      { kind: "executing", node: null },
      { kind: "execution_success" },
    ],
  },

  "ws-reconnect": {
    name: "ws-reconnect",
    steps: [
      { kind: "execution_start" },
      { kind: "executing", node: sampler },
      { kind: "progress", node: sampler, value: 1, max: 4 },
      { kind: "drop_sockets" },
      { kind: "gate", name: "reconnected" },
      { kind: "progress", node: sampler, value: 4, max: 4 },
      { kind: "executing", node: { save: 0 } },
      { kind: "executed", node: { save: 0 }, images: 1 },
      { kind: "executing", node: null },
      { kind: "execution_success" },
    ],
  },

  "death-before-executed": {
    name: "death-before-executed",
    steps: [
      { kind: "execution_start" },
      { kind: "executing", node: sampler },
      { kind: "progress", node: sampler, value: 1, max: 4 },
      { kind: "die" },
    ],
  },
};

export function resolveScenario(scenario: ScenarioName | Scenario): Scenario {
  return typeof scenario === "string" ? SCENARIOS[scenario] : scenario;
}
