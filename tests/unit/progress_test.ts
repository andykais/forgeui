import { assertEquals } from "@std/assert";
import { completedProgress, ProgressTracker } from "../../src/jobs/progress.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";

const graph: ApiGraph = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: {},
    _meta: { title: "Load Checkpoint" },
  },
  "3": { class_type: "KSampler", inputs: {} },
  "6": { class_type: "CLIPTextEncode", inputs: {} },
  "8": { class_type: "VAEDecode", inputs: {} },
  "9": { class_type: "SaveImage", inputs: {}, _meta: { title: "Save Image" } },
};

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

Deno.test("progress_json has exactly the §7 shape", () => {
  const tracker = new ProgressTracker(graph);
  assertEquals(Object.keys(tracker.snapshot()), [
    "pct",
    "eta_ms",
    "node_id",
    "node_label",
    "node_index",
    "node_total",
    "step",
    "max",
  ]);
});

Deno.test("equal node weights: finished nodes plus the current node's fraction", () => {
  const time = clock();
  const tracker = new ProgressTracker(graph, time.now);
  tracker.start();
  assertEquals(tracker.snapshot().pct, 0);
  assertEquals(tracker.snapshot().node_total, 5);

  tracker.executing("1");
  time.advance(100);
  assertEquals(tracker.snapshot().node_index, 1);
  assertEquals(tracker.snapshot().node_label, "Load Checkpoint");

  tracker.executing("6");
  // One of five nodes finished.
  assertEquals(tracker.snapshot().pct, 20);
  assertEquals(tracker.snapshot().node_index, 2);
  // A node with no title reports its class.
  assertEquals(tracker.snapshot().node_label, "CLIPTextEncode");

  tracker.executing("3");
  tracker.progress("3", 5, 10);
  // Two done, half of the third: 2.5 / 5.
  assertEquals(tracker.snapshot().pct, 50);
  assertEquals(tracker.snapshot().step, 5);
  assertEquals(tracker.snapshot().max, 10);
});

Deno.test("cached nodes count as finished", () => {
  const tracker = new ProgressTracker(graph);
  tracker.start();
  tracker.cached(["1", "6"]);
  assertEquals(tracker.snapshot().pct, 40);
  tracker.executing("3");
  assertEquals(tracker.snapshot().node_index, 3);
});

Deno.test("the ETA is elapsed time projected onto what is left", () => {
  const time = clock();
  const tracker = new ProgressTracker(graph, time.now);
  tracker.start();
  tracker.executing("1");
  time.advance(1000);
  tracker.executing("3");
  // 20% took a second, so the remaining 80% is four more.
  assertEquals(tracker.snapshot().pct, 20);
  assertEquals(tracker.snapshot().eta_ms, 4000);

  // No estimate before anything has finished.
  const fresh = new ProgressTracker(graph, time.now);
  fresh.start();
  assertEquals(fresh.snapshot().eta_ms, null);
});

Deno.test("node durations are recorded for the sidecar", () => {
  const time = clock();
  const tracker = new ProgressTracker(graph, time.now);
  tracker.start();
  tracker.executing("1");
  time.advance(120);
  tracker.executing("3");
  time.advance(9800);
  tracker.executing("8");
  time.advance(80);
  tracker.finish();
  assertEquals(tracker.timings(), { "1": 120, "3": 9800, "8": 80 });
  assertEquals(tracker.totalMs(), 10_000);
  // Nothing is left running once the prompt ends.
  assertEquals(tracker.snapshot().node_id, null);
  assertEquals(tracker.snapshot().node_label, null);
});

Deno.test("a progress event for another node advances the current one", () => {
  const tracker = new ProgressTracker(graph);
  tracker.start();
  tracker.executing("1");
  tracker.progress("3", 1, 4);
  assertEquals(tracker.snapshot().node_id, "3");
  assertEquals(tracker.snapshot().node_index, 2);
});

Deno.test("a finished job reads as 100%", () => {
  assertEquals(completedProgress(9), {
    pct: 100,
    eta_ms: 0,
    node_id: null,
    node_label: null,
    node_index: 9,
    node_total: 9,
    step: 0,
    max: 0,
  });
});

Deno.test("an empty graph still reports a total of one node", () => {
  const tracker = new ProgressTracker({});
  tracker.start();
  assertEquals(tracker.snapshot().node_total, 1);
  assertEquals(tracker.snapshot().pct, 0);
});
