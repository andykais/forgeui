import { APP_VERSION } from "../version.ts";

/**
 * The sidecar (§6.2) is the source of truth for an output; the database is
 * derived from it. Unknown fields survive a parse/serialize round-trip so a
 * file written by a newer version is never silently truncated.
 */
export interface Sidecar {
  app_version: string;
  job_id: string;
  /** ISO 8601 UTC, seconds precision. */
  created_at: string;
  workflow: SidecarWorkflow | null;
  params: Record<string, unknown>;
  models: SidecarModel[];
  api_graph: Record<string, unknown> | null;
  outputs: SidecarOutput[];
  timing: SidecarTiming;
  /** Unmapped source data for imported samples (§8.3). */
  raw: unknown;
  [unknownField: string]: unknown;
}

export interface SidecarWorkflow {
  id: string;
  name: string;
  hash: string;
  family: string | null;
  kind: string;
  [unknownField: string]: unknown;
}

export interface SidecarModel {
  role: string;
  name: string;
  hash: string | null;
  [unknownField: string]: unknown;
}

export interface SidecarOutput {
  file: string;
  kind: "image" | "video";
  width?: number;
  height?: number;
  duration_ms?: number;
  [unknownField: string]: unknown;
}

export interface SidecarTiming {
  total_ms: number;
  /** node id → milliseconds. */
  nodes: Record<string, number>;
}

export class SidecarError extends Error {
  override readonly name = "SidecarError";
}

export interface SidecarInit {
  job_id: string;
  created_at: Date | string;
  workflow: SidecarWorkflow | null;
  params: Record<string, unknown>;
  models?: SidecarModel[];
  api_graph: Record<string, unknown> | null;
  outputs: SidecarOutput[];
  timing?: SidecarTiming;
  raw?: unknown;
  app_version?: string;
}

/** `2026-09-03T18:12:04Z` — no milliseconds, always UTC. */
export function isoSeconds(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) {
    throw new SidecarError(`created_at: not a date: ${String(date)}`);
  }
  return `${value.toISOString().slice(0, 19)}Z`;
}

/** Field order follows §6.2 so files stay easy to read by hand. */
export function buildSidecar(init: SidecarInit): Sidecar {
  return {
    app_version: init.app_version ?? APP_VERSION,
    job_id: init.job_id,
    created_at: isoSeconds(init.created_at),
    workflow: init.workflow,
    params: init.params,
    models: init.models ?? [],
    api_graph: init.api_graph,
    outputs: init.outputs,
    timing: init.timing ?? { total_ms: 0, nodes: {} },
    raw: init.raw ?? null,
  };
}

export function serializeSidecar(sidecar: Sidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/**
 * The same JSON with every non-ASCII character written as a `\uXXXX` escape,
 * for the copy embedded in a PNG `tEXt` chunk, which is Latin-1 only. Escapes
 * are legal JSON, so `parseSidecar` reads it back unchanged.
 */
export function serializeSidecarAscii(sidecar: Sidecar): string {
  return JSON.stringify(sidecar).replace(
    /[^\u0020-\u007e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function requireString(
  value: unknown,
  where: string,
): string {
  if (typeof value !== "string") {
    throw new SidecarError(`${where}: expected a string`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  where: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SidecarError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SidecarError(`${where}: expected a list`);
  }
  return value;
}

/**
 * Validate the fields the app relies on and hand back everything else
 * untouched.
 */
export function parseSidecar(text: string, source = "sidecar"): Sidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SidecarError(
      `${source}: invalid JSON: ${
        cause instanceof Error ? cause.message : cause
      }`,
    );
  }
  const raw = requireRecord(parsed, source);

  requireString(raw.app_version, `${source}.app_version`);
  requireString(raw.job_id, `${source}.job_id`);
  requireString(raw.created_at, `${source}.created_at`);
  if (raw.workflow !== null) {
    const workflow = requireRecord(raw.workflow, `${source}.workflow`);
    requireString(workflow.id, `${source}.workflow.id`);
    requireString(workflow.hash, `${source}.workflow.hash`);
  }
  requireRecord(raw.params, `${source}.params`);
  for (
    const [i, model] of requireArray(raw.models, `${source}.models`).entries()
  ) {
    const at = `${source}.models[${i}]`;
    const record = requireRecord(model, at);
    requireString(record.role, `${at}.role`);
    requireString(record.name, `${at}.name`);
  }
  if (raw.api_graph !== null) {
    requireRecord(raw.api_graph, `${source}.api_graph`);
  }
  const outputs = requireArray(raw.outputs, `${source}.outputs`);
  for (const [i, output] of outputs.entries()) {
    const at = `${source}.outputs[${i}]`;
    const record = requireRecord(output, at);
    requireString(record.file, `${at}.file`);
    const kind = requireString(record.kind, `${at}.kind`);
    if (kind !== "image" && kind !== "video") {
      throw new SidecarError(`${at}.kind: expected image or video`);
    }
  }
  const timing = requireRecord(raw.timing, `${source}.timing`);
  if (typeof timing.total_ms !== "number") {
    throw new SidecarError(`${source}.timing.total_ms: expected a number`);
  }
  requireRecord(timing.nodes, `${source}.timing.nodes`);

  return raw as Sidecar;
}
