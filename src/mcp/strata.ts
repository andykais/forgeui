/**
 * Strata, as seen by the bridge (DESIGN-LLM-BACKENDS §2).
 *
 * Strata serves one model itself rather than behind a proxy, and unloading it
 * ends only the engine process: the HTTP server stays up, the weights stay in
 * the OS file cache, and the next completion loads it again. So the handoff is
 * `POST /unload`, then `GET /health` until `loaded` reads false.
 *
 * Measured on the box this was written for: an unload takes about a second, a
 * load about 25.
 */

import type { LlmHost } from "./llm.ts";
import { LlmHostError, readBody, sleep } from "./llm.ts";

export class StrataError extends LlmHostError {
  override readonly name = "StrataError";
}

export interface StrataHealth {
  model: string | null;
  /** `null` when the server does not say — an older Strata, or a proxy. */
  loaded: boolean | null;
}

/** What `GET /health` says, read without insisting on the rest of its shape. */
export function parseHealth(body: unknown): StrataHealth {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { model: null, loaded: null };
  }
  const record = body as Record<string, unknown>;
  const model = typeof record.model === "string" && record.model.length > 0
    ? record.model
    : null;
  const loaded = typeof record.loaded === "boolean" ? record.loaded : null;
  return { model, loaded };
}

export interface StrataOptions {
  /** Base URL, e.g. `http://127.0.0.1:8080`. */
  url: string;
  /** A label for `origin.source`; otherwise `/health`'s `model`. */
  model?: string | null;
  /** Sent as a bearer token only when given; Strata runs without one by default. */
  apiKey?: string | null;
  /** How long to wait for `/health` to say the engine is gone. */
  unloadTimeoutMs?: number;
  /** `?wait=` on `/unload`: how long to let a turn already running finish. */
  busyWaitS?: number;
  /** Load again once the round is over, rather than on the next completion. */
  reload?: "lazy" | "eager";
  /** How long that eager `POST /load` may take. */
  loadTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class Strata implements LlmHost {
  readonly backend = "strata" as const;
  readonly url: string;
  readonly #model: string | null;
  readonly #apiKey: string | null;
  readonly #unloadTimeoutMs: number;
  readonly #busyWaitS: number;
  readonly #reload: "lazy" | "eager";
  readonly #loadTimeoutMs: number;
  readonly #fetch: typeof fetch;
  /** The last model `/health` named; after an unload there may be none to ask. */
  #lastSeen: string | null = null;

  constructor(options: StrataOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.#model = options.model ?? null;
    this.#apiKey = options.apiKey ?? null;
    this.#unloadTimeoutMs = options.unloadTimeoutMs ?? 60_000;
    this.#busyWaitS = options.busyWaitS ?? 30;
    this.#reload = options.reload ?? "lazy";
    this.#loadTimeoutMs = options.loadTimeoutMs ?? 45_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  #request(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
  ): Promise<Response> {
    const headers = new Headers();
    if (this.#apiKey !== null) {
      headers.set("authorization", `Bearer ${this.#apiKey}`);
    }
    if (method === "POST") headers.set("content-type", "application/json");
    return this.#fetch(`${this.url}${path}`, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async health(): Promise<StrataHealth> {
    const response = await this.#request("GET", "/health", 5_000);
    const { text, json } = await readBody(response);
    if (!response.ok) {
      throw new StrataError(
        `Strata GET /health: ${response.status} ${statusOf(json) ?? text}`
          .trim(),
      );
    }
    const health = parseHealth(json);
    if (health.model !== null) this.#lastSeen = health.model;
    return health;
  }

  async resident(): Promise<string[]> {
    const health = await this.health();
    if (health.loaded !== true) return [];
    return [this.#model ?? health.model ?? this.#lastSeen ?? "strata"];
  }

  /**
   * The configured label wins, as `--llm-model` does for llama-swap; then what
   * `/health` names, which Strata reports whether or not it is loaded; then
   * whatever was last seen.
   */
  async currentModel(): Promise<string | null> {
    if (this.#model !== null) return this.#model;
    try {
      const health = await this.health();
      if (health.model !== null) return health.model;
    } catch {
      // A label is not worth failing a round over.
    }
    return this.#lastSeen;
  }

  async release(): Promise<{ was: string | null }> {
    const was = await this.currentModel();
    const path = this.#busyWaitS > 0
      ? `/unload?wait=${this.#busyWaitS}`
      : "/unload";

    let response: Response;
    try {
      // Strata may spend the whole wait on someone else's turn, then unload.
      response = await this.#request(
        "POST",
        path,
        (this.#busyWaitS + 30) * 1000,
      );
    } catch (cause) {
      throw new StrataError(
        `Strata POST ${path} failed: ${
          cause instanceof Error ? cause.message : cause
        }; nothing was submitted`,
      );
    }
    const { text, json } = await readBody(response);
    const status = statusOf(json);

    if (response.status === 409 || status === "busy") {
      throw new StrataError(
        `Strata is still answering another request after ${this.#busyWaitS}s; ` +
          `nothing was submitted`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new StrataError(
        `Strata refused ${path} with ${response.status}: it wants an API key, ` +
          `and --llm-api-key is ${
            this.#apiKey === null ? "not set" : "not the right one"
          }`,
      );
    }
    if (!response.ok) {
      throw new StrataError(
        `Strata POST ${path}: ${response.status} ${status ?? text}`.trim(),
      );
    }

    // The POST returning is the engine being told to stop. Confirm it went,
    // as for llama-swap: submitting into the gap is an OOM that reads like a
    // ComfyUI bug.
    const deadline = Date.now() + this.#unloadTimeoutMs;
    while (true) {
      const health = await this.health().catch(() => null);
      // A Strata that does not report `loaded` cannot be asked; the 200 is
      // all there is to go on.
      if (health !== null && health.loaded !== true) return { was };
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    throw new StrataError(
      `Strata still has its model loaded ${this.#unloadTimeoutMs}ms after ` +
        `unload; refusing to submit into an OOM`,
    );
  }

  async restore(): Promise<void> {
    if (this.#reload !== "eager") return;
    try {
      const response = await this.#request(
        "POST",
        "/load",
        this.#loadTimeoutMs,
      );
      if (!response.ok) {
        const { text, json } = await readBody(response);
        throw new Error(`${response.status} ${statusOf(json) ?? text}`.trim());
      }
      await response.body?.cancel();
    } catch (cause) {
      // Never thrown: the next completion loads the model regardless. Never
      // silent either — a load that keeps failing is how you learn ComfyUI
      // did not let go.
      console.error(
        `forge mcp: Strata did not load again after the round (the next ` +
          `request will try): ${
            cause instanceof Error ? cause.message : cause
          }`,
      );
    }
  }
}

function statusOf(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  for (const key of ["status", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
      const message = (value as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return null;
}
