import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import {
  countLiveOutputsForSidecar,
  countOutputs,
  countOutputsByDay,
  type DayRange,
  generationTimesFor,
  getOutput,
  listOutputs,
  type ListOutputsOptions,
  modelHashesForOutput,
  type OutputFilters,
  outputModelsFor,
  type OutputRow,
  outputsDeletedBefore,
  refreshModelUsage,
  restoreOutput,
  softDeleteOutput,
} from "../db/queries.ts";
import type { WsHub } from "../http/ws.ts";
import { parseSidecar, type Sidecar } from "../jobs/sidecar.ts";
import { encodeCursor } from "./cursor.ts";

/**
 * Reading and deleting outputs. Deletion is soft with an undo window (§11.2):
 * the row is marked at once so the gallery can drop the tile, and the bytes
 * are removed only once the toast has expired.
 */

export class OutputNotFoundError extends Error {
  override readonly name = "OutputNotFoundError";
  constructor(id: string) {
    super(`no output "${id}"`);
  }
}

export class OutputGoneError extends Error {
  override readonly name = "OutputGoneError";
}

/** §11.2 puts the undo toast at about eight seconds. */
export const UNDO_WINDOW_MS = 8000;

export interface OutputView extends OutputRow {
  /** What the client fetches the media from. */
  media_url: string;
  /** Wall-clock generation time, for the table's DURATION column. */
  generation_ms: number | null;
  models: { model_hash: string; role: string }[];
}

export interface OutputPage {
  outputs: OutputView[];
  /** Pass back as `?cursor=` for the next page; null at the end. */
  cursor: string | null;
}

export interface OutputDetail extends OutputView {
  /** §12: the detail route carries the sidecar contents. */
  sidecar: Sidecar | null;
  sidecar_error: string | null;
}

export function mediaUrl(path: string): string {
  return `/api/media/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export class OutputStore {
  /** Tests shorten this; the UI's toast is the real clock (§11.2). */
  undoWindowMs = UNDO_WINDOW_MS;
  #db: Database;
  #paths: DataPaths;
  #hub: WsHub;
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #now: () => number;

  constructor(options: {
    db: Database;
    paths: DataPaths;
    hub: WsHub;
    now?: () => number;
  }) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#hub = options.hub;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The shape every client sees for an output. The pipeline broadcasts this
   * rather than the raw row, so a live tile has the same fields a reloaded
   * one does — including the media URL.
   */
  view(row: OutputRow): OutputView {
    return this.#decorate([row])[0]!;
  }

  list(options: ListOutputsOptions = {}): OutputPage {
    const limit = options.limit;
    const rows = listOutputs(this.#db, options);
    const outputs = this.#decorate(rows);
    const last = rows[rows.length - 1];
    // A short page is the end of the list; a full one may not be.
    const exhausted = limit !== undefined
      ? rows.length < limit
      : rows.length < 60;
    return {
      outputs,
      cursor: last && !exhausted
        ? encodeCursor({ created_at: last.created_at, id: last.id })
        : null,
    };
  }

  count(filters: OutputFilters = {}): number {
    return countOutputs(this.#db, filters);
  }

  days(
    ranges: DayRange[],
    filters: OutputFilters = {},
  ): Record<string, number> {
    return countOutputsByDay(this.#db, ranges, filters);
  }

  require(id: string): OutputRow {
    const row = getOutput(this.#db, id);
    if (!row) throw new OutputNotFoundError(id);
    return row;
  }

  /** The row plus its sidecar, which is the reproduction record (§6.1). */
  async detail(id: string): Promise<OutputDetail> {
    const row = this.require(id);
    const [view] = this.#decorate([row]);
    let sidecar: Sidecar | null = null;
    let sidecarError: string | null = null;
    try {
      sidecar = parseSidecar(
        await Deno.readTextFile(join(this.#paths.root, row.sidecar_path)),
        row.sidecar_path,
      );
    } catch (cause) {
      sidecarError = cause instanceof Error ? cause.message : String(cause);
    }
    return { ...view!, sidecar, sidecar_error: sidecarError };
  }

  /**
   * Soft delete, and schedule the bytes to go once the undo window closes.
   * Nothing is confirmed and nothing is asked twice (§11.2).
   */
  softDelete(id: string): { output: OutputRow; undo_window_ms: number } {
    const row = this.require(id);
    if (row.deleted_at === null) {
      softDeleteOutput(this.#db, id, this.#now());
      // A deleted output no longer counts towards the models it used (§7).
      refreshModelUsage(this.#db, modelHashesForOutput(this.#db, id));
    }
    this.#scheduleRemoval(id, this.undoWindowMs);
    const output = this.require(id);
    this.#hub.broadcast({ type: "output_deleted", data: this.view(output) });
    return { output, undo_window_ms: this.undoWindowMs };
  }

  /** The undo toast, while the files are still there. */
  async restore(id: string): Promise<OutputRow> {
    const row = this.require(id);
    if (row.deleted_at === null) return row;
    if (!(await this.#mediaExists(row))) {
      throw new OutputGoneError(
        `output "${id}" was deleted and its files have already been removed`,
      );
    }
    const timer = this.#timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    restoreOutput(this.#db, id);
    refreshModelUsage(this.#db, modelHashesForOutput(this.#db, id));
    const restored = this.require(id);
    this.#hub.broadcast({ type: "output", data: this.view(restored) });
    return restored;
  }

  /**
   * Startup: anything whose window closed while the app was not running is
   * removed now, and anything still inside it gets its timer back.
   */
  async resumeDeletions(): Promise<{ removed: string[]; pending: string[] }> {
    const now = this.#now();
    const removed: string[] = [];
    const pending: string[] = [];
    for (const row of outputsDeletedBefore(this.#db, now + this.undoWindowMs)) {
      const dueAt = (row.deleted_at ?? now) + this.undoWindowMs;
      if (dueAt <= now) {
        await this.#removeFiles(row.id);
        removed.push(row.id);
      } else {
        this.#scheduleRemoval(row.id, dueAt - now);
        pending.push(row.id);
      }
    }
    return { removed, pending };
  }

  /** Cancel pending timers; the rows stay deleted and are reaped next boot. */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #scheduleRemoval(id: string, delayMs: number): void {
    const existing = this.#timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(id);
      this.#removeFiles(id).catch((error) => {
        console.error(`could not remove the files of ${id}:`, error);
      });
    }, Math.max(0, delayMs));
    // A pending deletion must not hold the process open.
    Deno.unrefTimer(timer as unknown as number);
    this.#timers.set(id, timer);
  }

  async #removeFiles(id: string): Promise<void> {
    const row = getOutput(this.#db, id);
    if (!row || row.deleted_at === null) return; // Restored in the meantime.
    await remove(join(this.#paths.root, row.path));
    // The sidecar belongs to the job, so it goes with the last of its outputs.
    if (countLiveOutputsForSidecar(this.#db, row.sidecar_path, row.id) === 0) {
      const others = outputsDeletedBefore(this.#db, Number.MAX_SAFE_INTEGER)
        .filter((other) =>
          other.sidecar_path === row.sidecar_path && other.id !== row.id
        );
      const anyMediaLeft = await Promise.all(
        others.map((other) => this.#mediaExists(other)),
      );
      if (!anyMediaLeft.includes(true)) {
        await remove(join(this.#paths.root, row.sidecar_path));
      }
    }
  }

  async #mediaExists(row: OutputRow): Promise<boolean> {
    try {
      await Deno.stat(join(this.#paths.root, row.path));
      return true;
    } catch {
      return false;
    }
  }

  #decorate(rows: OutputRow[]): OutputView[] {
    const models = outputModelsFor(this.#db, rows.map((row) => row.id));
    const times = generationTimesFor(
      this.#db,
      [
        ...new Set(
          rows.map((row) => row.job_id).filter((id): id is string =>
            id !== null
          ),
        ),
      ],
    );
    return rows.map((row) => ({
      ...row,
      media_url: mediaUrl(row.path),
      generation_ms: row.job_id ? times.get(row.job_id) ?? null : null,
      models: (models.get(row.id) ?? []).map(({ model_hash, role }) => ({
        model_hash,
        role,
      })),
    }));
  }
}

async function remove(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
