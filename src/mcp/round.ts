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
import { ForgeUiError, isTerminal } from "./forgeui.ts";
import type { LlmHost } from "./llm.ts";
import { describeError, LlmHostError, sourceFor } from "./llm.ts";

/**
 * How often a round re-reads the jobs it is waiting on.
 *
 * The websocket is the fast path and this is the floor under it. A minute of
 * GPU time is worth a GET a second; a round that hangs because one frame went
 * missing is not.
 */
const RECONCILE_MS = 1000;

/**
 * How long a cancel may take to land. ComfyUI interrupts between sampler
 * steps, and a step of a video model can take tens of seconds.
 */
const STOP_TIMEOUT_MS = 60_000;

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
  /** The LLM server to take the GPU from; `null` when it is not on this GPU. */
  llm: LlmHost | null;
  /** Ask ForgeUI to make ComfyUI drop its weights, once the round is over. */
  freeVram?: boolean;
  /** Progress for a human watching, when the client asked for it (§5.3). */
  onProgress?: (done: number, total: number, message: string) => void;
  /**
   * The caller gave up on the call: the MCP client's request timeout, a
   * `notifications/cancelled`, or a closed stream (DESIGN-AGENT-LOOP §5.3).
   *
   * A harness that has stopped waiting sends its next completion straight
   * away, and that completion is what loads the LLM again — into a GPU, and
   * RAM, that ComfyUI is still filling. So an abandoned round cancels its
   * jobs, waits until they have actually stopped, and hands the GPU back
   * then, not when its own timeout runs out minutes later.
   */
  signal?: AbortSignal;
  /** How long a cancelled round waits for ComfyUI to stop. Tests shorten it. */
  stopTimeoutMs?: number;
}

/** What a job cancelled because the caller left says about itself. */
const ABANDONED =
  "cancelled: the MCP client stopped waiting for this call (its request " +
  "timeout?). Raise the harness's MCP timeout above the longest round";

/** A promise that settles when `signal` aborts; never, without one. */
function abortedBy(signal: AbortSignal | undefined): Promise<true> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) return resolve(true);
    signal.addEventListener("abort", () => resolve(true), { once: true });
  });
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
  const { forge, llm, signal } = deps;
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  // Nobody is waiting: take nothing from the LLM and submit nothing.
  if (signal?.aborted) {
    throw new ForgeUiError("the call was cancelled before the round began");
  }
  const abandoned = abortedBy(signal);

  // 1–2. The GPU, before anything is submitted into it.
  const modelId = llm === null ? null : await llm.currentModel();
  const source = sourceFor(modelId);
  if (llm !== null) {
    try {
      await llm.release();
    } catch (cause) {
      // The backend's own errors already say what it answered. One it never
      // answered — the bridge cannot reach `--llm-url` — says only "fetch
      // failed", which reads as ForgeUI being down when every other tool works.
      if (cause instanceof LlmHostError) throw cause;
      throw new LlmHostError(
        `could not reach the LLM server (${llm.backend} at ${llm.url}) to ` +
          `free the GPU before the round; check --llm-url is reachable from ` +
          `where the bridge runs: ${describeError(cause)}`,
        { cause },
      );
    }
  }

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
  /**
   * Jobs a cancel could not stop in time. While there are any, ComfyUI still
   * holds the GPU, and nothing here may invite the LLM back onto it.
   */
  let stillRunning: string[] = [];
  try {
    // 4. Submit. A rejection here is the model's to fix — a bad param names
    // itself — so the ids already queued are cancelled rather than orphaned.
    for (const [index, job] of request.jobs.entries()) {
      // The client left while the batch was going in: submit no more. The
      // wait below sees the abort and cancels what is already queued.
      if (signal?.aborted) break;
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
        stillRunning = await stopAll(
          forge,
          [...submitted.keys()],
          stopTimeoutMs,
        );
        // In a batch of six, "steps: out of range" is no use without which.
        throw new ForgeUiError(
          `job ${index + 1} of ${request.jobs.length} (${job.workflow_id}) ` +
            `was refused, and the round with it: ${describeError(cause)}`,
        );
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

    /** Cancel what is left, and say why on each job. */
    const giveUp = async (why: string) => {
      stillRunning = await stopAll(forge, [...pending], stopTimeoutMs);
      for (const id of pending) {
        const entry = submitted.get(id)!;
        entry.status = "cancelled";
        entry.error = why;
      }
    };

    while (pending.size > 0) {
      if (signal?.aborted) {
        console.error(
          `forge mcp: the client abandoned a generate call with ` +
            `${pending.size} job(s) unfinished; cancelling them before the ` +
            `LLM can reload. Raise the harness's MCP timeout above the ` +
            `longest round`,
        );
        await giveUp(ABANDONED);
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await giveUp(`timed out after ${request.timeoutMs}ms`);
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
      // An abort wakes the wait at once: every second spent here after the
      // client has left is a second the LLM may be loading into a full GPU.
      if (streamDone) {
        await Promise.race([sleep(wait), abandoned]);
        if (!signal?.aborted) await reconcile();
        continue;
      }
      pulling ??= pump.next();
      const tick = await Promise.race([
        pulling.then(() => false as const),
        sleep(wait).then(() => true as const),
        abandoned,
      ]);
      if (tick) {
        if (!signal?.aborted) await reconcile();
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
    // symptom is the LLM server failing to load the model minutes later, with
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
    // 7. Only after ComfyUI has let go: an eager reload into a GPU still
    // holding the diffusion weights is the OOM the eviction was for. A no-op
    // unless asked for, and it never throws.
    //
    // And not at all while a cancel has not landed: a job ComfyUI is still
    // running is still holding the GPU, and the reload is what would lock
    // the machine. The next completion loads the model once it is free.
    if (llm !== null) {
      if (stillRunning.length > 0) {
        console.error(
          `forge mcp: ${stillRunning.length} job(s) had not stopped ` +
            `${stopTimeoutMs / 1000}s after being cancelled ` +
            `(${stillRunning.join(", ")}); not reloading the LLM onto a GPU ` +
            `ComfyUI is still using`,
        );
      } else {
        await llm.restore();
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
 * Bounded, because a round that has already failed must still end; what it
 * returns is the ids that had not stopped by then.
 */
async function stopAll(
  forge: ForgeUi,
  ids: string[],
  timeoutMs: number,
): Promise<string[]> {
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
  return [...waiting];
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
