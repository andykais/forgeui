/**
 * One round: evict, submit, wait, hand the GPU back (DESIGN-AGENT-LOOP §5.2).
 *
 * This is the only operation in the bridge that takes minutes, and the only
 * one during which the model is not resident. The model is idle for all of it
 * — its turn ended when it emitted the call (§2) — so the duration costs
 * nothing; what costs something is returning without releasing the GPU, which
 * is why every path out of here goes through the `finally`.
 */

import type {
  ForgeUi,
  JobRow,
  Origin,
  OutputRef,
  SubmitJob,
} from "./forgeui.ts";
import { isTerminal } from "./forgeui.ts";
import type { LlamaSwap } from "./llama.ts";
import { sourceFor } from "./llama.ts";

/**
 * How often a round re-reads the jobs it is waiting on.
 *
 * The websocket is the fast path and this is the floor under it. A minute of
 * GPU time is worth a GET a second; a round that hangs because one frame went
 * missing is not.
 */
const RECONCILE_MS = 1000;

/** A timer that does not outlive the wait it was made for. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Nothing here should hold the process open on its own.
    Deno.unrefTimer(timer as unknown as number);
  });
}

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
  /**
   * What this job made, named rather than counted: an id to chain from, the
   * kind, and the path the file actually has. A round whose results are a
   * list of ids leaves the model nothing to point at.
   */
  outputs: OutputRef[];
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
  // Connected before the first submit, and awaited: an iterator that *would*
  // open a socket is not a socket. A job that finishes in the gap emits an
  // event nobody is listening for, and the round then waits out its whole
  // timeout for something that already happened.
  const events = await forge.watch(abort.signal);
  const pump = events[Symbol.asyncIterator]();

  const submitted = new Map<string, RoundJob>();
  /** Ids as the job rows report them, resolved to files once the round ends. */
  const produced = new Map<string, string[]>();
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
          outputs: [],
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
    /** The pull in flight, held across ticks; see the race below. */
    let pulling:
      | Promise<IteratorResult<{ type: string; data: unknown }>>
      | null = null;
    let streamDone = false;

    /** What the rows say, for the jobs no event has settled. */
    const reconcile = async () => {
      for (const id of [...pending]) {
        const row = await forge.job(id).catch(() => null);
        if (row && isTerminal(row.status)) {
          settle(submitted, produced, pending, row, deps, request.jobs.length);
        }
      }
    };

    // A job can already be terminal before the first event arrives.
    await reconcile();

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
      // The socket, or a tick. Every tick re-reads the rows that are still
      // pending: the events are the fast path, and this is the floor under
      // it — a dropped socket or a missed frame must not cost the whole
      // timeout on a call that is holding the GPU.
      //
      // The pull is kept across ticks rather than started afresh each time.
      // `Promise.race` does not cancel the loser, so a `next()` abandoned to
      // a tick stays queued on the generator and swallows the next event
      // into a promise nobody awaits.
      const wait = Math.min(remaining, RECONCILE_MS);
      if (streamDone) {
        await sleep(wait);
        await reconcile();
        continue;
      }
      pulling ??= pump.next();
      const tick = await Promise.race([
        pulling.then(() => false as const),
        sleep(wait).then(() => true as const),
      ]);
      if (tick) {
        await reconcile();
        continue;
      }
      const next = await pulling;
      pulling = null;
      if (next.done) {
        // The socket went. The tick above is what finishes the round now.
        streamDone = true;
        continue;
      }
      const event = next.value;
      if (event.type !== "job") continue;
      const row = event.data as JobRow;
      if (!pending.has(row.id)) continue;
      if (!isTerminal(row.status)) continue;
      settle(submitted, produced, pending, row, deps, request.jobs.length);
    }
  } finally {
    abort.abort();
    await pump.return?.(undefined).catch(() => {});
    // 6. Hand it back whatever happened — a thrown round must not leave
    // ComfyUI holding the weights the model is about to want.
    //
    // Never silently: swallowing this is how the GPU stays full and the only
    // symptom is llama-swap failing to start the model minutes later, with
    // nothing in any log to connect the two.
    if (deps.freeVram) {
      try {
        await forge.post("/api/system/free_vram");
      } catch (cause) {
        console.error(
          `forge mcp: could not free ComfyUI's VRAM — the LLM may not fit when ` +
            `it reloads: ${cause instanceof Error ? cause.message : cause}`,
        );
      }
    }
  }

  // The files, last: a chained job takes an output by id, and the model
  // cannot chain what the round never named. Failing to read one is not
  // worth failing the round over — the id still works.
  await Promise.all(
    [...submitted.entries()].map(async ([jobId, entry]) => {
      entry.outputs = await Promise.all(
        (produced.get(jobId) ?? []).map((id) =>
          forge.output(id).catch(() => ({ id, kind: "unknown" }))
        ),
      );
    }),
  );

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
  produced: Map<string, string[]>,
  pending: Set<string>,
  row: JobRow,
  deps: RoundDeps,
  total: number,
): void {
  const entry = submitted.get(row.id);
  if (!entry) return;
  entry.status = row.status;
  produced.set(row.id, row.outputs ?? []);
  entry.error = errorText(row);
  pending.delete(row.id);
  deps.onProgress?.(
    total - pending.size,
    total,
    `${entry.workflow_id}: ${row.status}`,
  );
}
