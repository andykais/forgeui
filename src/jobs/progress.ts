import type { Progress } from "../db/queries.ts";
import type { ApiGraph } from "../workflows/types.ts";

/**
 * Progress per §5.1: the elapsed weight of the finished nodes plus the
 * fraction of the node now running. Weights are the per-node durations
 * `node_timings` remembers for this workflow; a workflow nobody has run yet
 * falls back to equal weights, and a node with no history is worth the
 * average of the ones that have.
 */
export interface ProgressTrackerOptions {
  now?: () => number;
  /** `node_id` → milliseconds, from `node_timings` (§5.1). */
  weights?: Map<string, number>;
}

export class ProgressTracker {
  readonly nodeTotal: number;
  #labels: Map<string, string>;
  #nodeIds: string[];
  #startedAt: number | null = null;
  #finished = new Set<string>();
  #currentNode: string | null = null;
  #currentNodeStartedAt: number | null = null;
  #step = 0;
  #max = 0;
  #timings = new Map<string, number>();
  #now: () => number;
  #weights: Map<string, number>;
  #totalWeight: number;
  #defaultWeight: number;
  /** True when this workflow has been run before, so the ETA has a basis. */
  readonly weighted: boolean;

  constructor(
    graph: ApiGraph,
    options: ProgressTrackerOptions | (() => number) = {},
  ) {
    const settings = typeof options === "function" ? { now: options } : options;
    this.#labels = new Map(
      Object.entries(graph).map(([id, node]) => [
        id,
        node._meta?.title ?? node.class_type,
      ]),
    );
    this.#nodeIds = Object.keys(graph);
    this.nodeTotal = Math.max(1, this.#nodeIds.length);
    this.#now = settings.now ?? Date.now;

    const known = [...(settings.weights ?? new Map())].filter(([id, ms]) =>
      Number.isFinite(ms) && ms > 0 && this.#labels.has(id)
    );
    this.weighted = known.length > 0;
    this.#weights = new Map(known);
    // A node this workflow has no history for still has to be worth
    // something, or a graph that grew a node would stall at 99%. The median
    // rather than the mean, because one node is usually most of the run and
    // an unseen node is far more likely to be a loader than a sampler.
    this.#defaultWeight = this.weighted ? median(known.map(([, ms]) => ms)) : 1;
    this.#totalWeight = this.#nodeIds.length === 0
      ? this.#defaultWeight
      : this.#nodeIds.reduce((sum, id) => sum + this.#weightOf(id), 0);
  }

  /** What the whole run is expected to take, when there is anything to go on. */
  get predictedMs(): number | null {
    return this.weighted ? this.#totalWeight : null;
  }

  #weightOf(nodeId: string): number {
    return this.#weights.get(nodeId) ?? this.#defaultWeight;
  }

  #doneWeight(): number {
    let weight = 0;
    for (const id of this.#finished) weight += this.#weightOf(id);
    if (this.#currentNode !== null && !this.#finished.has(this.#currentNode)) {
      const fraction = this.#max > 0
        ? Math.min(1, Math.max(0, this.#step / this.#max))
        : 0;
      weight += fraction * this.#weightOf(this.#currentNode);
    }
    return Math.min(this.#totalWeight, weight);
  }

  get startedAt(): number | null {
    return this.#startedAt;
  }

  get currentNode(): string | null {
    return this.#currentNode;
  }

  start(at = this.#now()): void {
    this.#startedAt = at;
  }

  /** Nodes ComfyUI skipped because their result was already in memory. */
  cached(nodes: string[]): void {
    for (const node of nodes) this.#finished.add(node);
  }

  executing(nodeId: string | null): void {
    const at = this.#now();
    this.#closeCurrentNode(at);
    this.#currentNode = nodeId;
    this.#currentNodeStartedAt = nodeId === null ? null : at;
    this.#step = 0;
    this.#max = 0;
  }

  progress(nodeId: string | null, step: number, max: number): void {
    if (nodeId !== null && nodeId !== this.#currentNode) this.executing(nodeId);
    this.#step = step;
    this.#max = max;
  }

  /** Called when the prompt ends, so the last node's duration is recorded. */
  finish(at = this.#now()): void {
    this.#closeCurrentNode(at);
    this.#currentNode = null;
    this.#currentNodeStartedAt = null;
    // The prompt is over, so every node is behind us — including the ones
    // ComfyUI never mentioned because it had their result already.
    for (const id of this.#nodeIds) this.#finished.add(id);
  }

  snapshot(): Progress {
    const done = this.#doneWeight();
    const pct = Math.round((done / this.#totalWeight) * 1000) / 10;
    const elapsed = this.#startedAt === null
      ? 0
      : this.#now() - this.#startedAt;
    return {
      pct,
      eta_ms: this.#eta(done, elapsed),
      node_id: this.#currentNode,
      node_label: this.#currentNode === null
        ? null
        : this.#labels.get(this.#currentNode) ?? this.#currentNode,
      // 1-based position of the node now running, for "node 4 of 9".
      node_index: Math.min(
        this.nodeTotal,
        this.#finished.size + (this.#currentNode === null ? 0 : 1),
      ),
      node_total: this.nodeTotal,
      step: this.#step,
      max: this.#max,
    };
  }

  /**
   * Without history the only estimate is the rate measured so far: elapsed
   * time projected onto the fraction that is left, which is what Phase 1 did
   * and is wrong in both directions on a graph with one expensive node.
   *
   * With history there are two estimates — what this workflow took last time,
   * and how fast this run is going — and the second is only worth believing
   * once some of the run has happened. They are blended by how much has
   * finished, so a step boundary crossed in the first half-second cannot
   * announce that the run is nearly over, and a machine that is genuinely
   * slower than last time is believed by the end.
   */
  #eta(done: number, elapsed: number): number | null {
    if (this.#startedAt === null) return null;
    const left = this.#totalWeight - done;
    if (left <= 0) return null;
    const fraction = done / this.#totalWeight;

    if (!this.weighted) {
      return fraction > 0 && elapsed > 0
        ? Math.round(elapsed * (1 - fraction) / fraction)
        : null;
    }
    if (done <= 0 || elapsed <= 0) {
      return Math.max(0, Math.round(left - elapsed));
    }
    const measured = elapsed / done;
    const rate = fraction * measured + (1 - fraction);
    return Math.max(0, Math.round(left * rate));
  }

  /** `{ nodeId: ms }` for the sidecar's `timing.nodes` (§6.2). */
  timings(): Record<string, number> {
    return Object.fromEntries(this.#timings);
  }

  totalMs(at = this.#now()): number {
    return this.#startedAt === null ? 0 : Math.max(0, at - this.#startedAt);
  }

  #closeCurrentNode(at: number): void {
    if (this.#currentNode === null || this.#currentNodeStartedAt === null) {
      return;
    }
    const previous = this.#timings.get(this.#currentNode) ?? 0;
    this.#timings.set(
      this.#currentNode,
      previous + (at - this.#currentNodeStartedAt),
    );
    this.#finished.add(this.#currentNode);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 1;
}

/** A completed job reads as 100% with nothing running. */
export function completedProgress(nodeTotal: number): Progress {
  return {
    pct: 100,
    eta_ms: 0,
    node_id: null,
    node_label: null,
    node_index: nodeTotal,
    node_total: nodeTotal,
    step: 0,
    max: 0,
  };
}
