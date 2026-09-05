import type { ConfigStore } from "../config/config.ts";
import type { DataPaths } from "../config/paths.ts";
import type { ComfyMode } from "../config/types.ts";
import { ComfyClient, type SystemStats } from "./client.ts";
import type { ComfyEvent } from "./events.ts";
import {
  comfyLaunchCommand,
  LaunchError,
  launchFlagsForDisplay,
} from "./launch.ts";
import { ComfyProcess } from "./process.ts";
import { ComfyWsClient } from "./ws.ts";

/**
 * Owns the connection to ComfyUI: the managed child process in `managed`
 * mode, the websocket in both, and the `starting|running|disconnected|failed`
 * state the UI keys off (§2, §11.3).
 */

export type ComfyState = "starting" | "running" | "disconnected" | "failed";

export interface ComfyStatus {
  state: ComfyState;
  mode: ComfyMode;
  url: string;
  pid: number | null;
  uptime_ms: number | null;
  error: string | null;
  device: string | null;
  vram_free: number | null;
  vram_total: number | null;
  comfyui_version: string | null;
  queue_remaining: number;
  launch_flags: string[];
}

export interface ComfyManagerOptions {
  config: ConfigStore;
  paths: DataPaths;
  onEvent: (event: ComfyEvent) => void;
  /** Fired on every (re)connection, so jobs in flight can be reconciled. */
  onConnect?: () => void;
  onStatus?: (status: ComfyStatus) => void;
  /** How long to wait for the first connection before calling it failed. */
  connectTimeoutMs?: number;
  wsBackoffMs?: number[];
}

export class ComfyManager {
  readonly client: ComfyClient;
  #options: ComfyManagerOptions;
  #state: ComfyState = "starting";
  #error: string | null = null;
  #process: ComfyProcess | null = null;
  #ws: ComfyWsClient;
  #stats: SystemStats | null = null;
  #statsAt = 0;
  #queueRemaining = 0;
  #startTimer: ReturnType<typeof setTimeout> | null = null;
  #waiters: { state: ComfyState; resolve: () => void }[] = [];
  #closed = false;

  constructor(options: ComfyManagerOptions) {
    this.#options = options;
    this.client = new ComfyClient({
      url: options.config.config.comfy.url,
      clientId: crypto.randomUUID(),
    });
    this.#ws = new ComfyWsClient({
      url: () => this.client.wsUrl,
      backoffMs: options.wsBackoffMs,
      onEvent: (event) => this.#onEvent(event),
      onOpen: () => this.#onOpen(),
      onClose: () => this.#onDisconnect(),
    });
  }

  get mode(): ComfyMode {
    return this.#options.config.config.comfy.mode;
  }

  get state(): ComfyState {
    return this.#state;
  }

  get process(): ComfyProcess | null {
    return this.#process;
  }

  /** True when a job can be submitted; the Generate button follows this. */
  get connected(): boolean {
    return this.#state === "running";
  }

  status(): ComfyStatus {
    return {
      state: this.#state,
      mode: this.mode,
      url: this.client.url,
      pid: this.#process?.running ? this.#process.pid : null,
      uptime_ms: this.#process?.running ? this.#process.uptimeMs : null,
      error: this.#error,
      device: this.#stats?.device ?? null,
      vram_free: this.#stats?.vram_free ?? null,
      vram_total: this.#stats?.vram_total ?? null,
      comfyui_version: this.#stats?.comfyui_version ?? null,
      queue_remaining: this.#queueRemaining,
      launch_flags: launchFlagsForDisplay(
        this.#options.config.config,
        this.#options.paths,
      ),
    };
  }

  log(limit?: number): string[] {
    return this.#process?.log(limit) ?? [];
  }

  /** Non-blocking: the UI comes up while ComfyUI is still starting (§11.3). */
  start(): void {
    if (this.#closed) return;
    this.#setState("starting", null);
    if (this.mode === "managed") {
      try {
        this.#spawn();
      } catch (cause) {
        this.#setState(
          "failed",
          cause instanceof LaunchError || cause instanceof Error
            ? cause.message
            : String(cause),
        );
        return;
      }
    }
    this.#ws.start();
    this.#armConnectTimeout();
  }

  async restart(): Promise<void> {
    if (this.mode !== "managed") {
      throw new LaunchError(
        "restart is only possible in managed mode; the app does not own that process",
      );
    }
    this.#ws.stop();
    await this.#process?.stop();
    this.#process = null;
    this.#stats = null;
    this.start();
  }

  /** Refresh VRAM and version, at most once every `maxAgeMs`. */
  async refreshStats(maxAgeMs = 2000): Promise<SystemStats | null> {
    if (this.#state !== "running") return this.#stats;
    if (this.#stats && Date.now() - this.#statsAt < maxAgeMs) {
      return this.#stats;
    }
    try {
      this.#stats = await this.client.systemStats();
      this.#statsAt = Date.now();
    } catch {
      // A stats hiccup is not a connection state change.
    }
    return this.#stats;
  }

  waitForState(state: ComfyState, timeoutMs = 10_000): Promise<void> {
    if (this.#state === state) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.resolve !== onState);
        reject(
          new Error(
            `ComfyUI did not reach "${state}" within ${timeoutMs}ms (now "${this.#state}"${
              this.#error ? `: ${this.#error}` : ""
            })`,
          ),
        );
      }, timeoutMs);
      const onState = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters.push({ state, resolve: onState });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#startTimer !== null) clearTimeout(this.#startTimer);
    this.#startTimer = null;
    this.#ws.stop();
    await this.#process?.stop();
    this.#process = null;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
  }

  #spawn(): void {
    const launch = comfyLaunchCommand(
      this.#options.config.config,
      this.#options.paths,
    );
    this.#process = ComfyProcess.start({
      launch,
      onExit: (status) => {
        if (this.#closed) return;
        this.#ws.stop();
        this.#setState(
          "failed",
          `ComfyUI exited with code ${status.code}${
            status.signal ? ` (${status.signal})` : ""
          }`,
        );
      },
    });
  }

  #armConnectTimeout(): void {
    if (this.#startTimer !== null) clearTimeout(this.#startTimer);
    const timeout = this.#options.connectTimeoutMs ??
      (this.mode === "managed" ? 120_000 : 20_000);
    this.#startTimer = setTimeout(() => {
      this.#startTimer = null;
      if (this.#state === "starting") {
        this.#setState(
          "failed",
          `could not reach ComfyUI at ${this.client.url} within ${
            Math.round(timeout / 1000)
          }s`,
        );
      }
    }, timeout);
  }

  #onOpen(): void {
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    this.#setState("running", null);
    this.refreshStats(0).catch(() => {});
    this.#options.onConnect?.();
  }

  #onDisconnect(): void {
    if (this.#closed) return;
    // A managed child that exited reports "failed" from its own watcher.
    if (this.#process && !this.#process.running) return;
    this.#setState("disconnected", "the websocket to ComfyUI dropped");
  }

  #onEvent(event: ComfyEvent): void {
    if (event.type === "status") this.#queueRemaining = event.queue_remaining;
    this.#options.onEvent(event);
  }

  #setState(state: ComfyState, error: string | null): void {
    const changed = this.#state !== state || this.#error !== error;
    this.#state = state;
    this.#error = error;
    if (!changed) return;
    for (const waiter of [...this.#waiters]) {
      if (waiter.state === state) {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        waiter.resolve();
      }
    }
    this.#options.onStatus?.(this.status());
  }
}
