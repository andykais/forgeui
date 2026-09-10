/**
 * The terminal the app was started in is the only place it can say what it is
 * doing, so what it prints there is part of the interface: one line per thing
 * that happened, stamped with the local time, and never one per frame.
 *
 * Progress belongs on `/ws`, not here — a running job pushes hundreds of
 * updates a second and none of them are worth a line.
 */

function stamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${
    pad(at.getSeconds())
  }`;
}

export function log(message: string): void {
  console.log(`${stamp(new Date())} ${message}`);
}

export function logError(message: string): void {
  console.error(`${stamp(new Date())} ${message}`);
}

/** Seconds, to one decimal: a generation is measured in seconds, not ms. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A value fit for one line of a log: one line, and no longer than `max`. */
export function oneLine(value: string, max = 72): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
