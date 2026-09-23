/**
 * ForgeUI, as seen by the bridge (DESIGN-AGENT-LOOP §5).
 *
 * Plain REST and the app's WebSocket (§12) — no auth, because ForgeUI has
 * none and the bridge is a client like the browser is. `origin` travels in the
 * submit body; ForgeUI persists what it understands and ignores the rest,
 * which is what lets the bridge send it before the server side of §6.2 lands.
 */

export class ForgeUiError extends Error {
  override readonly name = "ForgeUiError";
}

/** What `POST /api/jobs` gives back, narrowed to what the bridge reads. */
export interface JobRow {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  workflow_id: string | null;
  outputs?: string[];
  /** §7's `JobError`: the column is `error_json`, the API says `error`. */
  error?: { type?: string; message?: string; node_id?: string | null } | null;
}

export interface Origin {
  source: string;
  project?: string;
  note?: string;
}

export interface SubmitJob {
  workflow_id: string;
  params: Record<string, unknown>;
  note?: string;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export interface ForgeUiOptions {
  url: string;
  fetch?: typeof fetch;
}

export class ForgeUi {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: ForgeUiOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get url(): string {
    return this.#url;
  }

  async request(
    path: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const response = await this.#fetch(`${this.#url}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      // ForgeUI answers a bad param with a message worth showing the model
      // verbatim — it names the param, which is what lets it self-correct.
      // §12 answers `{error: {code, message}}`. Reaching for the message is
      // the point: it names the param that was wrong, which is what lets the
      // model fix it. Rendering the envelope gives it "[object Object]".
      let detail = text.slice(0, 500);
      try {
        const body = JSON.parse(text) as {
          error?: { code?: string; message?: string } | string;
        };
        if (typeof body.error === "string") detail = body.error;
        else if (body.error?.message) detail = body.error.message;
      } catch { /* the text is the detail */ }
      throw new ForgeUiError(
        `${init?.method ?? "GET"} ${path}: ${response.status} ${detail}`,
      );
    }
    return text.trim().length === 0 ? null : JSON.parse(text);
  }

  get(path: string): Promise<unknown> {
    return this.request(path);
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * Submit one job.
   *
   * One call per job is what §12 offers today; the batch API of §6.1 replaces
   * this loop with a single call and a single completion event. The shape here
   * is deliberately the batch's shape already, so that swap is local.
   */
  async submit(job: SubmitJob, origin: Origin): Promise<JobRow> {
    const note = [origin.note, job.note].filter(Boolean).join(" · ");
    return await this.post("/api/jobs", {
      workflow_id: job.workflow_id,
      params: job.params,
      origin: { ...origin, note: note.length > 0 ? note : undefined },
    }) as JobRow;
  }

  async job(id: string): Promise<JobRow> {
    return await this.get(`/api/jobs/${encodeURIComponent(id)}`) as JobRow;
  }

  async cancel(id: string): Promise<void> {
    await this.post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
  }

  /**
   * The media bytes for an output, for `get_output_image` (§5.1).
   *
   * Via the output's own `media_url` rather than a path built here: §12 serves
   * everything from `/api/media/<path>`, and the row is what knows the path.
   * Guessing a URL shape worked until it did not, which is what the
   * integration test now pins.
   */
  async media(id: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const output = await this.get(
      `/api/outputs/${encodeURIComponent(id)}`,
    ) as { media_url?: string };
    if (!output.media_url) {
      throw new ForgeUiError(`output ${id} has no media`);
    }
    const response = await this.#fetch(`${this.#url}${output.media_url}`);
    if (!response.ok) {
      throw new ForgeUiError(
        `GET ${output.media_url}: ${response.status} ${response.statusText}`,
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ??
        "application/octet-stream",
    };
  }

  /** The app's `/ws` as an async iterator of decoded JSON events (§12). */
  watch(signal?: AbortSignal): AsyncIterable<{ type: string; data: unknown }> {
    const url = `${this.#url.replace(/^http/, "ws")}/ws`;
    return watchSocket(url, signal);
  }
}

/**
 * The websocket as an iterator.
 *
 * Buffered rather than dropped: a caller that is between `next()` calls when
 * three jobs land in the same tick must still see all three, or a batch never
 * finishes. Binary frames — ComfyUI's previews, relayed by §12 — are skipped.
 */
async function* watchSocket(
  url: string,
  signal?: AbortSignal,
): AsyncIterable<{ type: string; data: unknown }> {
  const socket = new WebSocket(url);
  const queue: { type: string; data: unknown }[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: Error | null = null;

  const push = (event: { type: string; data: unknown }) => {
    queue.push(event);
    wake?.();
  };
  const finish = (error: Error | null) => {
    closed = true;
    failure = error;
    wake?.();
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      push(JSON.parse(event.data) as { type: string; data: unknown });
    } catch { /* not ours */ }
  };
  socket.onerror = () => finish(new ForgeUiError(`websocket failed: ${url}`));
  socket.onclose = () => finish(null);
  signal?.addEventListener("abort", () => {
    try {
      socket.close();
    } catch { /* already gone */ }
    finish(null);
  });

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    socket.onopen = () => resolve();
    const fail = () => reject(new ForgeUiError(`could not open ${url}`));
    socket.addEventListener("error", fail, { once: true });
    signal?.addEventListener("abort", fail, { once: true });
  });

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (closed) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    try {
      socket.close();
    } catch { /* already gone */ }
  }
}
