import type { Job } from "../types.ts";

/**
 * Where a queued job sits in the line, counting from the one that runs next
 * (§11.2).
 *
 * The job lists are newest first everywhere — that is the order the grid, the
 * filmstrip and the queue strip read in — but ComfyUI runs them oldest first.
 * Numbering them by their index therefore called the job that runs *last*
 * "position 1", which is the opposite of what the number is for.
 *
 * Returns 0 for a job that is not in the list, which no caller should be
 * asking about.
 */
export function queuePosition(queued: readonly Job[], id: string): number {
  const index = queued.findIndex((job) => job.id === id);
  return index < 0 ? 0 : queued.length - index;
}
