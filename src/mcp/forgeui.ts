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

/** A model as `GET /api/models` lists it, narrowed to what a picker reads. */
export interface ModelRow {
  name: string;
  display_name: string;
  family: string;
  kind: string;
  tags: string[];
  notes: string | null;
  strength_min: number;
  strength_max: number;
  output_count: number;
  /** False once the file is gone; the row survives for its outputs (§8.1). */
  present: boolean;
}

export interface ModelListing {
  models: ModelRow[];
  /** Every configured folder kind and the class it is filed under (§8.2). */
  classes?: Record<string, string>;
}

/** One finished file, as `generate` reports it and `attach_input` takes it. */
export interface OutputRef {
  id: string;
  kind: string;
  /** Where it sits under the data dir — what the file is actually called. */
  path?: string;
  media_url?: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
}

/** An output's bytes, and the row they belong to. */
export interface MediaBytes {
  bytes: Uint8Array;
  mimeType: string;
  /** False when this is the file itself, including when a preview was asked
   * for and ForgeUI could not make one. */
  resized: boolean;
  output: {
    id?: string;
    kind?: string;
    path?: string;
    media_url?: string;
    width?: number | null;
    height?: number | null;
    duration_ms?: number | null;
  };
}

/** What `POST /api/inputs` gives back: media in the store, ready to bind. */
export interface StoredInputView {
  sha256: string;
  ext: string;
  filename: string;
  kind: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  bytes: number;
  url: string;
  derived_from_output: string | null;
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
        ...(typeof init?.body === "string"
          ? { "content-type": "application/json" }
          : {}),
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

  get<T = unknown>(path: string): Promise<T> {
    return this.request(path) as Promise<T>;
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

  /** One output row, narrowed to what a chained job needs to name it. */
  async output(id: string): Promise<OutputRef> {
    const row = await this.get<
      OutputRef & { kind?: string }
    >(`/api/outputs/${encodeURIComponent(id)}`);
    return {
      id,
      kind: row.kind ?? "image",
      path: row.path,
      media_url: row.media_url,
      width: row.width ?? null,
      height: row.height ?? null,
      duration_ms: row.duration_ms ?? null,
    };
  }

  /**
   * Adopt an output into the input store (§9).
   *
   * The file itself, not a copy of it: `adoptOutput` hardlinks where it can,
   * so chaining a 200MB video costs nothing and the bytes the next graph
   * loads are bit-for-bit the ones that came out of the last one.
   */
  attachOutput(outputId: string): Promise<StoredInputView> {
    return this.post("/api/inputs", {
      output_id: outputId,
    }) as Promise<StoredInputView>;
  }

  /** Upload bytes the bridge read off its own disk. */
  async attachFile(
    filename: string,
    bytes: Uint8Array,
  ): Promise<StoredInputView> {
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], filename));
    return await this.request("/api/inputs", {
      method: "POST",
      body: form,
    }) as StoredInputView;
  }

  /**
   * The media bytes for an output (§5.1): the file itself for
   * `get_output_file`, or with `maxEdge` the smaller copy `get_output_preview`
   * shows (§6.3).
   *
   * Via the output's own `media_url` rather than a path built here: §12 serves
   * everything from `/api/media/<path>`, and the row is what knows the path.
   * Guessing a URL shape worked until it did not, which is what the
   * integration test now pins.
   *
   * A ForgeUI with no ffmpeg cannot make the smaller copy and says so with a
   * 503; that comes back as the full file with `resized: false`, so the
   * caller can say what it is handing over rather than fail.
   */
  async media(
    id: string,
    options: { maxEdge?: number } = {},
  ): Promise<MediaBytes> {
    const output = await this.get(
      `/api/outputs/${encodeURIComponent(id)}`,
    ) as MediaBytes["output"];
    if (!output.media_url) {
      throw new ForgeUiError(`output ${id} has no media`);
    }
    const fetchOnce = (maxEdge?: number) =>
      this.#fetch(
        `${this.#url}${output.media_url}` +
          (maxEdge === undefined ? "" : `?max_edge=${maxEdge}`),
      );
    let response = await fetchOnce(options.maxEdge);
    let resized = options.maxEdge !== undefined;
    if (resized && response.status === 503) {
      await response.body?.cancel();
      response = await fetchOnce();
      resized = false;
    }
    if (!response.ok) {
      throw new ForgeUiError(
        `GET ${output.media_url}: ${response.status} ${response.statusText}`,
      );
    }
    const mimeType = response.headers.get("content-type") ??
      "application/octet-stream";
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType,
      // Audio is served as it is whatever was asked (§12), so only a picture
      // or a clip that came back a different type was actually made smaller.
      resized: resized && !mimeType.startsWith("audio/"),
      output,
    };
  }

  /** The app's `/ws` as an async iterator of decoded JSON events (§12). */
  /**
   * The app's `/ws`, already connected.
   *
   * A promise, and not an iterable that connects when it is first pulled:
   * the caller opens this *before* submitting, and "before" has to mean the
   * socket is open by then, not that an object exists which would open one.
   */
  watch(
    signal?: AbortSignal,
  ): Promise<AsyncIterable<{ type: string; data: unknown }>> {
    const url = `${this.#url.replace(/^http/, "ws")}/ws`;
    return watchSocket(url, signal);
  }
}

/**
 * The websocket as an iterator, connected before this resolves.
 *
 * Not an `async function*`: a generator runs none of its body until the
 * first `next()`, so a version of this that opened the socket inside one
 * opened it *after* the jobs were submitted, however early the caller asked
 * for the iterator. Events that landed in between were simply missed, and
 * the round then waited for something that had already happened — which CI
 * found and a fast machine never did.
 *
 * Buffered rather than dropped: a caller that is between `next()` calls when
 * three jobs land in the same tick must still see all three, or a batch never
 * finishes. Binary frames — ComfyUI's previews, relayed by §12 — are skipped.
 */
async function watchSocket(
  url: string,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ type: string; data: unknown }>> {
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

  return {
    async *[Symbol.asyncIterator]() {
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
    },
  };
}
