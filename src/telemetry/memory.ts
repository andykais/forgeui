import type { MemoryReading, TelemetryStore } from "./store.ts";
import type { MemoryPhase } from "./store.ts";

/**
 * The Memory Usage report's clock (§7.1): a sample when a generation starts,
 * one every ten seconds while any generation is running, and one when the
 * last one finishes. Nothing is sampled while the app is idle — an idle
 * machine's memory is not news, and polling ComfyUI for it forever would be.
 */
export const MEMORY_SAMPLE_INTERVAL_MS = 10_000;

/** What ComfyUI's `/system_stats` says about one machine, at one instant. */
export interface MemoryStats {
  vram_free: number | null;
  vram_total: number | null;
  ram_free: number | null;
  ram_total: number | null;
  device: string | null;
}

export interface MemoryMonitorOptions {
  store: TelemetryStore;
  /** Reads ComfyUI's `/system_stats`; null when it is not connected. */
  read: () => Promise<MemoryStats | null>;
  intervalMs?: number;
}

/**
 * A line needs both halves of its pair: without the total and the free bytes
 * there is no "in use" to plot, and a row of nulls would be worse than no
 * row. A machine that reports RAM but no VRAM still gets its RAM line.
 */
function readings(stats: MemoryStats): MemoryReading[] {
  const found: MemoryReading[] = [];
  if (stats.vram_total !== null && stats.vram_free !== null) {
    found.push({
      series: "vram",
      used: Math.max(0, stats.vram_total - stats.vram_free),
      free: stats.vram_free,
      total: stats.vram_total,
      device: stats.device,
    });
  }
  if (stats.ram_total !== null && stats.ram_free !== null) {
    found.push({
      series: "ram",
      used: Math.max(0, stats.ram_total - stats.ram_free),
      free: stats.ram_free,
      total: stats.ram_total,
      device: null,
    });
  }
  return found;
}

export class MemoryMonitor {
  #store: TelemetryStore;
  #read: () => Promise<MemoryStats | null>;
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>();
  #pending: Promise<void> = Promise.resolve();

  constructor(options: MemoryMonitorOptions) {
    this.#store = options.store;
    this.#read = options.read;
    this.#intervalMs = options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS;
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

  sample(phase: MemoryPhase, jobId: string | null = null): void {
    this.#pending = this.#pending.then(async () => {
      const stats = await this.#read().catch(() => null);
      if (!stats) return;
      const found = readings(stats);
      if (found.length === 0) return;
      this.#store.recordMemory({ phase, readings: found, job_id: jobId });
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
