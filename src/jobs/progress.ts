import type { Progress } from "../db/queries.ts";
import type { ApiGraph } from "../workflows/types.ts";

/**
 * Progress with equal node weights (§5.1's first-run fallback, which is all
 * of Phase 1): finished nodes plus the fraction of the node now running. Node
 * durations are still recorded, because every sidecar carries them (§6.2) and
 * Phase 2 turns them into real weights.
 */
export class ProgressTracker {
  readonly nodeTotal: number;
  #labels: Map<string, string>;
  #startedAt: number | null = null;
  #finishedNodes = 0;
  #currentNode: string | null = null;
  #currentNodeStartedAt: number | null = null;
  #step = 0;
  #max = 0;
  #timings = new Map<string, number>();
  #now: () => number;

  constructor(graph: ApiGraph, now: () => number = Date.now) {
    this.#labels = new Map(
      Object.entries(graph).map(([id, node]) => [
        id,
        node._meta?.title ?? node.class_type,
      ]),
    );
    this.nodeTotal = Math.max(1, Object.keys(graph).length);
    this.#now = now;
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
    this.#finishedNodes = Math.min(
      this.nodeTotal,
      this.#finishedNodes + nodes.length,
    );
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
  }

  snapshot(): Progress {
    const fraction = this.#max > 0
      ? Math.min(1, Math.max(0, this.#step / this.#max))
      : 0;
    const done = Math.min(
      this.nodeTotal,
      this.#finishedNodes + (this.#currentNode === null ? 0 : fraction),
    );
    const pct = Math.round((done / this.nodeTotal) * 1000) / 10;
    const elapsed = this.#startedAt === null
      ? 0
      : this.#now() - this.#startedAt;
    const eta = pct > 0 && pct < 100 && elapsed > 0
      ? Math.round(elapsed * (100 - pct) / pct)
      : null;
    return {
      pct,
      eta_ms: eta,
      node_id: this.#currentNode,
      node_label: this.#currentNode === null
        ? null
        : this.#labels.get(this.#currentNode) ?? this.#currentNode,
      // 1-based position of the node now running, for "node 4 of 9".
      node_index: Math.min(
        this.nodeTotal,
        this.#finishedNodes + (this.#currentNode === null ? 0 : 1),
      ),
      node_total: this.nodeTotal,
      step: this.#step,
      max: this.#max,
    };
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
    this.#finishedNodes = Math.min(this.nodeTotal, this.#finishedNodes + 1);
  }
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
