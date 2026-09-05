/** Formatting the mocks call for: mono numbers, id suffixes, relative time. */

/** `31.4s`, `1:04`, `420ms` — generation wall clock (§11.2). */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** `0:05` for video length and ETAs. */
export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—:—";
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function relativeTime(at: number | null | undefined): string {
  if (!at) return "never";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1m ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

export function absoluteTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** `…ZM4T-0`: the last five characters of the ULID plus the index (§11.2). */
export function shortId(id: string): string {
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return `…${id.slice(-5)}`;
  return `…${id.slice(Math.max(0, dash - 5), dash)}${id.slice(dash)}`;
}

export function bytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${
    units[unit]
  }`;
}

/** `1024×1024`, and `1216×704 · 0:05` for video (§11.2). */
export function dimensions(
  width: number | null,
  height: number | null,
  durationMs?: number | null,
): string {
  const size = width && height ? `${width}×${height}` : "—";
  return durationMs ? `${size} · ${clock(durationMs)}` : size;
}

/** Today / Yesterday / the date, for the gallery's day dividers (§11.2). */
export function dayLabel(date: string): string {
  const today = localDate(new Date());
  const yesterday = localDate(new Date(Date.now() - 86_400_000));
  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";
  const parsed = new Date(`${date}T00:00:00`);
  return parsed
    .toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    })
    .toUpperCase();
}

/** `YYYY-MM-DD` in the browser's timezone, which is what the dividers use. */
export function localDate(at: Date | number): string {
  const date = typeof at === "number" ? new Date(at) : at;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function vram(free: number | null, total: number | null): string {
  if (free === null) return "";
  const gb = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GB`;
  return total ? `${gb(free)} VRAM free` : gb(free);
}
