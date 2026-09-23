/**
 * One round: evict, submit, wait, hand the GPU back (DESIGN-AGENT-LOOP §5.2).
 *
 * This is the only operation in the bridge that takes minutes, and the only
 * one during which the model is not resident. The model is idle for all of it
 * — its turn ended when it emitted the call (§2) — so the duration costs
 * nothing; what costs something is returning without releasing the GPU, which
 * is why every path out of here goes through the `finally`.
 */

import type { ForgeUi, JobRow, Origin, SubmitJob } from "./forgeui.ts";
import { isTerminal } from "./forgeui.ts";
import type { LlamaSwap } from "./llama.ts";
import { sourceFor } from "./llama.ts";

export interface RoundRequest {
  jobs: SubmitJob[];
  project?: string;
  note?: string;
  timeoutMs: number;
}

export interface RoundJob {
  job_id: string;
  workflow_id: string;
  status: string;
  output_ids: string[];
  note?: string;
  error?: string;
}

export interface RoundResult {
  source: string;
  project?: string;
  counts: { done: number; failed: number; cancelled: number };
  jobs: RoundJob[];
}

export interface RoundDeps {
  forge: ForgeUi;
  llama: LlamaSwap | null;
  /** Ask ForgeUI to make ComfyUI drop its weights, once the round is over. */
  freeVram?: boolean;
  /** Progress for a human watching, when the client asked for it (§5.3). */
  onProgress?: (done: number, total: number, message: string) => void;
}

function errorText(job: JobRow): string | undefined {
  const error = job.error;
  if (!error) return undefined;
  const where = error.node_id ? ` (node ${error.node_id})` : "";
  return `${error.message ?? error.type ?? "failed"}${where}`;
}

/**
 * Run a round to completion.
 *
 * The websocket is opened *before* the first submit. Opening it afterwards is
 * a race the fake ComfyUI wins routinely: a job can be done before the socket
 * is listening, and then the round waits for an event that already happened.
 */
export async function runRound(
  request: RoundRequest,
  deps: RoundDeps,
): Promise<RoundResult> {
  const { forge, llama } = deps;

  // 1–2. The GPU, before anything is submitted into it.
  const modelId = llama === null ? null : await llama.currentModel();
  const source = sourceFor(modelId);
  if (llama !== null) await llama.unload();

  const origin: Origin = {
    source,
    project: request.project,
    note: request.note,
  };

  const abort = new AbortController();
  const events = forge.watch(abort.signal);
  // Force the socket open now — `watch` connects on first pull, and the point
  // of this line is that the connection exists before a job can finish.
  const pump = events[Symbol.asyncIterator]();

  const submitted = new Map<string, RoundJob>();
  try {
    // 4. Submit. A rejection here is the model's to fix — a bad param names
    // itself — so the ids already queued are cancelled rather than orphaned.
    for (const job of request.jobs) {
      try {
        const row = await forge.submit(job, origin);
        submitted.set(row.id, {
          job_id: row.id,
          workflow_id: job.workflow_id,
          status: row.status,
          output_ids: [],
          note: job.note,
        });
      } catch (cause) {
        await stopAll(forge, [...submitted.keys()]);
        throw cause;
      }
    }

    // 5. Wait. Terminal means terminal, not successful: a round where every
    // job fails still finishes, or the GPU is held by a call nobody ends.
    const deadline = Date.now() + request.timeoutMs;
    const pending = new Set(submitted.keys());

    // A job can already be terminal before the first event arrives.
    for (const id of [...pending]) {
      const row = await forge.job(id).catch(() => null);
      if (row && isTerminal(row.status)) {
        settle(submitted, pending, row, deps, request.jobs.length);
      }
    }

    while (pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await stopAll(forge, [...pending]);
        for (const id of pending) {
          const entry = submitted.get(id)!;
          entry.status = "cancelled";
          entry.error = `timed out after ${request.timeoutMs}ms`;
        }
        break;
      }
      const next = await Promise.race([
        pump.next(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        ),
      ]);
      if (next.done) continue;
      const event = next.value;
      if (event.type !== "job") continue;
      const row = event.data as JobRow;
      if (!pending.has(row.id)) continue;
      if (!isTerminal(row.status)) continue;
      settle(submitted, pending, row, deps, request.jobs.length);
    }
  } finally {
    abort.abort();
    await pump.return?.(undefined).catch(() => {});
    // 6. Hand it back whatever happened — a thrown round must not leave
    // ComfyUI holding the weights the model is about to want.
    if (deps.freeVram) {
      await forge.post("/api/system/free_vram").catch(() => {});
    }
  }

  const jobs = [...submitted.values()];
  return {
    source,
    project: request.project,
    counts: {
      done: jobs.filter((job) => job.status === "done").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      cancelled: jobs.filter((job) => job.status === "cancelled").length,
    },
    jobs,
  };
}

/**
 * Cancel these jobs and wait for them to actually stop.
 *
 * Asking is not enough: `POST /cancel` returns before ComfyUI has torn the
 * job down, so a rollback that returns on the ask hands back a GPU that is
 * still busy — which is the one thing this whole design is trying not to do.
 * Bounded, because a round that has already failed must still end.
 */
async function stopAll(
  forge: ForgeUi,
  ids: string[],
  timeoutMs = 10_000,
): Promise<void> {
  for (const id of ids) await forge.cancel(id).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  const waiting = new Set(ids);
  while (waiting.size > 0 && Date.now() < deadline) {
    for (const id of [...waiting]) {
      const row = await forge.job(id).catch(() => null);
      if (row === null || isTerminal(row.status)) waiting.delete(id);
    }
    if (waiting.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function settle(
  submitted: Map<string, RoundJob>,
  pending: Set<string>,
  row: JobRow,
  deps: RoundDeps,
  total: number,
): void {
  const entry = submitted.get(row.id);
  if (!entry) return;
  entry.status = row.status;
  entry.output_ids = row.outputs ?? [];
  entry.error = errorText(row);
  pending.delete(row.id);
  deps.onProgress?.(
    total - pending.size,
    total,
    `${entry.workflow_id}: ${row.status}`,
  );
}
