/**
 * llama-swap, as seen by the bridge (DESIGN-AGENT-LOOP §5, §8).
 *
 * Two things are wanted from it: make the VLM let go of the GPU, and say what
 * model that VLM is so a generation can be labelled with it. Nothing here
 * loads a model — llama-swap does that by itself when the harness sends its
 * next completion, which is the whole reason the handoff needs so little code.
 */

export class LlamaSwapError extends Error {
  override readonly name = "LlamaSwapError";
}

/**
 * The model ids llama-swap reports as running.
 *
 * `GET /running` has no documented response shape, so this reads the shapes it
 * could plausibly return rather than insisting on one: an array or an object
 * wrapping it under `running` or `models`, holding either bare strings or
 * objects that name the model under `model`, `id` or `name`. Anything it
 * cannot read is no models rather than an exception — a label is not worth
 * failing a round over, and §5.2 treats "nothing running" as the normal case.
 */
export function parseRunning(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
    ? (() => {
      const record = body as Record<string, unknown>;
      for (const key of ["running", "models", "data"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
      return [];
    })()
    : [];

  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.length > 0) ids.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    // Some shapes carry the state beside the id; a model that is stopping is
    // not one we want to be labelled with.
    const state = record.state ?? record.status;
    if (typeof state === "string" && /stop|unload|error/i.test(state)) continue;
    for (const key of ["model", "id", "name", "model_id"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        ids.push(value);
        break;
      }
    }
  }
  return ids;
}

/** `llm:qwen-vlm` — what lands in `origin.source` (§6.2). */
export function sourceFor(modelId: string | null): string {
  return modelId === null ? "llm:unknown" : `llm:${modelId}`;
}

export interface LlamaSwapOptions {
  /** Base URL, e.g. `http://127.0.0.1:8080`. */
  url: string;
  /** Unload only this model, rather than everything running. */
  model?: string | null;
  /** How long to wait for the GPU to actually come free. */
  unloadTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class LlamaSwap {
  readonly #url: string;
  readonly #model: string | null;
  readonly #unloadTimeoutMs: number;
  readonly #fetch: typeof fetch;
  /**
   * The last model seen running.
   *
   * Read before every eviction, because after one there is nothing running to
   * ask — and a round that starts while the model happens to be cold would
   * otherwise be labelled `llm:unknown` for no better reason than timing.
   */
  #lastSeen: string | null = null;

  constructor(options: LlamaSwapOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#model = options.model ?? null;
    this.#unloadTimeoutMs = options.unloadTimeoutMs ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#fetch(`${this.#url}${path}`, init);
    if (!response.ok) {
      throw new LlamaSwapError(
        `llama-swap ${
          init?.method ?? "GET"
        } ${path}: ${response.status} ${response.statusText}`,
      );
    }
    const text = await response.text();
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** What is resident right now. */
  async running(): Promise<string[]> {
    const ids = parseRunning(await this.#json("/running"));
    if (ids.length > 0) this.#lastSeen = ids[0]!;
    return ids;
  }

  /**
   * Which model a generation started now should be attributed to.
   *
   * The configured `--llm-model` wins when there is one: it is what the
   * operator said this bridge serves, and it is right even when nothing is
   * loaded. Otherwise ask, and fall back to whatever was last seen.
   */
  async currentModel(): Promise<string | null> {
    if (this.#model !== null) return this.#model;
    try {
      const ids = await this.running();
      if (ids.length > 0) return ids[0]!;
    } catch {
      // A label is not worth failing over; §5.2 carries on with what it knows.
    }
    return this.#lastSeen;
  }

  /**
   * Make the GPU free, and do not return until it is.
   *
   * Unloading is asynchronous on llama-swap's side — `unloadTimeout` governs
   * how long it gives the child to stop — so the POST returning is not the
   * same as the VRAM being back. Submitting into that gap is how you get an
   * OOM that reads like a ComfyUI bug (§5.2 step 2).
   */
  async unload(): Promise<{ was: string | null }> {
    const was = await this.currentModel();
    const path = this.#model === null
      ? "/api/models/unload"
      : `/api/models/unload/${encodeURIComponent(this.#model)}`;
    await this.#json(path, { method: "POST" });

    const deadline = Date.now() + this.#unloadTimeoutMs;
    while (Date.now() < deadline) {
      const ids = await this.running().catch(() => [] as string[]);
      const stillUp = this.#model === null
        ? ids.length > 0
        : ids.includes(this.#model);
      if (!stillUp) return { was };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new LlamaSwapError(
      `llama-swap still has a model resident ${this.#unloadTimeoutMs}ms after unload; ` +
        `refusing to submit into an OOM`,
    );
  }
}
