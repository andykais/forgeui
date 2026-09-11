import type { TelemetryStore, VramPhase } from "./store.ts";

/**
 * The VRAM report's clock (§7.1): a sample when a generation starts, one
 * every ten seconds while any generation is running, and one when the last
 * one finishes. Nothing is sampled while the app is idle — an idle machine's
 * VRAM is not news, and polling ComfyUI for it forever would be.
 */
export const VRAM_SAMPLE_INTERVAL_MS = 10_000;

export interface VramReading {
  free: number | null;
  total: number | null;
  device: string | null;
}

export interface VramMonitorOptions {
  store: TelemetryStore;
  /** Reads ComfyUI's `/system_stats`; null when it is not connected. */
  read: () => Promise<VramReading | null>;
  intervalMs?: number;
}

export class VramMonitor {
  #store: TelemetryStore;
  #read: () => Promise<VramReading | null>;
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>();
  #pending: Promise<void> = Promise.resolve();

  constructor(options: VramMonitorOptions) {
    this.#store = options.store;
    this.#read = options.read;
    this.#intervalMs = options.intervalMs ?? VRAM_SAMPLE_INTERVAL_MS;
  }

  get sampling(): boolean {
    return this.#timer !== null;
  }

  /** Called as a job starts executing; the first one starts the ticks. */
  generationStarted(jobId: string): void {
    const first = this.#running.size === 0;
    this.#running.add(jobId);
    if (first) {
      this.sample("start", jobId);
      this.#timer = setInterval(
        () => this.sample("tick", [...this.#running][0] ?? null),
        this.#intervalMs,
      );
      // Nothing here should keep the process alive on its own.
      if (typeof Deno !== "undefined") Deno.unrefTimer(this.#timer);
    }
  }

  /** Called however a job ended — done, failed or cancelled. */
  generationFinished(jobId: string): void {
    if (!this.#running.delete(jobId)) return;
    if (this.#running.size > 0) return;
    this.#stopTimer();
    this.sample("end", jobId);
  }

  /** Tests: resolves once every sample taken so far has been recorded. */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const pending = this.#pending;
      await pending;
      if (pending === this.#pending) return;
    }
  }

  sample(phase: VramPhase, jobId: string | null = null): void {
    this.#pending = this.#pending.then(async () => {
      const reading = await this.#read().catch(() => null);
      if (!reading || reading.total === null || reading.free === null) {
        // Without both numbers there is no "in use" to plot, and a row of
        // nulls would be worse than no row (§7.1).
        return;
      }
      this.#store.recordVram({
        phase,
        used: Math.max(0, reading.total - reading.free),
        free: reading.free,
        total: reading.total,
        device: reading.device,
        job_id: jobId,
      });
    });
  }

  stop(): void {
    this.#stopTimer();
    this.#running.clear();
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
