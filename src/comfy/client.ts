import type { ApiGraph } from "../workflows/types.ts";
import { type ComfyImageRef, outputImages } from "./events.ts";

/** HTTP half of the ComfyUI API (§2). The websocket half lives in ws.ts. */

export class ComfyHttpError extends Error {
  override readonly name = "ComfyHttpError";
  readonly status: number;
  /** ComfyUI's per-node validation errors, when it sent any. */
  readonly nodeErrors: Record<string, unknown>;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    body: unknown,
    nodeErrors: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.nodeErrors = nodeErrors;
  }
}

export interface QueueItem {
  number: number;
  prompt_id: string;
}

export interface ComfyQueue {
  running: QueueItem[];
  pending: QueueItem[];
}

export interface HistoryEntry {
  prompt_id: string;
  status: string;
  completed: boolean;
  messages: [string, Record<string, unknown>][];
  /** node id → the files that node wrote. */
  outputs: Record<string, ComfyImageRef[]>;
}

export interface SystemStats {
  comfyui_version: string | null;
  python_version: string | null;
  device: string | null;
  vram_total: number | null;
  vram_free: number | null;
}

export interface ComfyClientOptions {
  url: string;
  clientId: string;
  /** Injectable so tests can drive the client without a network. */
  fetch?: typeof fetch;
}

export class ComfyClient {
  readonly clientId: string;
  #base: URL;
  #fetch: typeof fetch;

  constructor(options: ComfyClientOptions) {
    this.#base = new URL(options.url);
    this.clientId = options.clientId;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get url(): string {
    return this.#base.origin;
  }

  /** `http://host:port/ws?clientId=…`, as a websocket URL. */
  get wsUrl(): string {
    const ws = new URL("/ws", this.#base);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    ws.searchParams.set("clientId", this.clientId);
    return ws.href;
  }

  endpoint(path: string): string {
    return new URL(path, this.#base).href;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ): Promise<Response> {
    const abort = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.endpoint(path), {
        ...init,
        signal: abort,
      });
    } catch (cause) {
      throw new ComfyHttpError(
        0,
        `${path}: ${cause instanceof Error ? cause.message : cause}`,
        null,
      );
    }
    if (!response.ok) {
      const body = await response.text();
      let parsed: unknown = body;
      let message = `${path}: ComfyUI answered ${response.status}`;
      let nodeErrors: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
        const payload = parsed as Record<string, unknown>;
        const error = payload.error as Record<string, unknown> | undefined;
        if (typeof error?.message === "string") {
          message = `${error.message}${
            typeof error.details === "string" && error.details.length > 0
              ? `: ${error.details}`
              : ""
          }`;
        }
        if (typeof payload.node_errors === "object" && payload.node_errors) {
          nodeErrors = payload.node_errors as Record<string, unknown>;
        }
      } catch {
        // Not JSON; the text body is the message.
      }
      throw new ComfyHttpError(response.status, message, parsed, nodeErrors);
    }
    return response;
  }

  /**
   * Queue a prompt. The id is chosen by the caller so it can be recorded
   * before the request goes out — otherwise the first websocket events can
   * arrive before the app knows which job they belong to. ComfyUI honours a
   * supplied `prompt_id`; older versions answer with one of their own, which
   * the caller has to accept.
   */
  async prompt(
    graph: ApiGraph,
    promptId?: string,
  ): Promise<{ prompt_id: string; number: number }> {
    const response = await this.#request("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: this.clientId,
        ...(promptId ? { prompt_id: promptId } : {}),
      }),
    });
    const body = await response.json() as {
      prompt_id?: string;
      number?: number;
    };
    if (!body.prompt_id) {
      throw new ComfyHttpError(200, "/prompt: no prompt_id in the reply", body);
    }
    return { prompt_id: body.prompt_id, number: body.number ?? 0 };
  }

  async queue(): Promise<ComfyQueue> {
    const response = await this.#request("/queue");
    const body = await response.json() as Record<string, unknown>;
    const read = (value: unknown): QueueItem[] => {
      if (!Array.isArray(value)) return [];
      const out: QueueItem[] = [];
      for (const entry of value) {
        if (!Array.isArray(entry)) continue;
        const [number, promptId] = entry as [unknown, unknown];
        if (typeof promptId !== "string") continue;
        out.push({
          number: typeof number === "number" ? number : 0,
          prompt_id: promptId,
        });
      }
      return out;
    };
    return {
      running: read(body.queue_running),
      pending: read(body.queue_pending),
    };
  }

  /** Drop pending prompts; a running one has to be interrupted instead. */
  async deleteQueued(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;
    await this.#request("/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  async clearQueue(): Promise<void> {
    await this.#request("/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
  }

  async interrupt(): Promise<void> {
    await this.#request("/interrupt", { method: "POST" });
  }

  /** How a job that finished while the app was not listening is recovered. */
  async history(promptId: string): Promise<HistoryEntry | null> {
    const response = await this.#request(
      `/history/${encodeURIComponent(promptId)}`,
    );
    const body = await response.json() as Record<string, unknown>;
    const entry = body[promptId] as Record<string, unknown> | undefined;
    if (!entry) return null;
    const status = entry.status as Record<string, unknown> | undefined;
    const outputs: Record<string, ComfyImageRef[]> = {};
    for (
      const [node, output] of Object.entries(
        (entry.outputs ?? {}) as Record<string, unknown>,
      )
    ) {
      const files = outputImages(output);
      if (files.length > 0) outputs[node] = files;
    }
    return {
      prompt_id: promptId,
      status: typeof status?.status_str === "string"
        ? status.status_str
        : "unknown",
      completed: status?.completed === true,
      messages: Array.isArray(status?.messages)
        ? status.messages as [string, Record<string, unknown>][]
        : [],
      outputs,
    };
  }

  async systemStats(timeoutMs = 5000): Promise<SystemStats> {
    const response = await this.#request("/system_stats", {}, timeoutMs);
    const body = await response.json() as Record<string, unknown>;
    const system = body.system as Record<string, unknown> | undefined;
    const devices = Array.isArray(body.devices) ? body.devices : [];
    const device = devices[0] as Record<string, unknown> | undefined;
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      comfyui_version: typeof system?.comfyui_version === "string"
        ? system.comfyui_version
        : null,
      python_version: typeof system?.python_version === "string"
        ? system.python_version
        : null,
      device: typeof device?.name === "string" ? device.name : null,
      vram_total: number(device?.vram_total),
      vram_free: number(device?.vram_free),
    };
  }

  /** Content-addressed inputs land here before a job references them (§9). */
  async uploadImage(
    name: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<{ name: string; subfolder: string }> {
    const form = new FormData();
    form.set(
      "image",
      new File([bytes.buffer as ArrayBuffer], name, { type: contentType }),
    );
    form.set("overwrite", "true");
    form.set("type", "input");
    const response = await this.#request("/upload/image", {
      method: "POST",
      body: form,
    });
    const body = await response.json() as { name?: string; subfolder?: string };
    return { name: body.name ?? name, subfolder: body.subfolder ?? "" };
  }
}
