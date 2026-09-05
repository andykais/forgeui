import { encodeHex } from "@std/encoding/hex";
import type { ApiGraph, Manifest } from "./types.ts";

/**
 * JSON with object keys sorted, so a reformat or a key reorder does not move
 * the workflow hash. Arrays keep their order — it is meaningful everywhere we
 * use it (param order is panel order, LoRA order is chain order).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${
    entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    )
      .join(",")
  }}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return encodeHex(new Uint8Array(digest));
}

/**
 * `sha256(api.json + manifest.json)` (§4.5), over the canonical form of both
 * so the hash tracks content rather than formatting. Stamped into every
 * sidecar so old outputs can be recognised; nothing keys off it.
 */
export async function workflowHash(
  graph: ApiGraph,
  manifest: Manifest | null,
): Promise<string> {
  return `sha256:${await sha256Hex(
    canonicalJson(graph) + canonicalJson(manifest),
  )}`;
}
