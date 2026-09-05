/**
 * ComfyUI's websocket protocol, as much of it as the app consumes (§5 step 6).
 * Everything here is defensive: a field the running ComfyUI does not send must
 * never throw, it just leaves the app with less to show.
 */

export interface ComfyEventBase {
  prompt_id?: string;
}

export interface ExecutionStartEvent extends ComfyEventBase {
  type: "execution_start";
  timestamp?: number;
}

export interface ExecutionCachedEvent extends ComfyEventBase {
  type: "execution_cached";
  nodes: string[];
}

export interface ExecutingEvent extends ComfyEventBase {
  type: "executing";
  /** `null` marks the end of the prompt. */
  node: string | null;
}

export interface ProgressEvent extends ComfyEventBase {
  type: "progress";
  node: string | null;
  value: number;
  max: number;
}

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ExecutedEvent extends ComfyEventBase {
  type: "executed";
  node: string;
  images: ComfyImageRef[];
}

export interface ExecutionSuccessEvent extends ComfyEventBase {
  type: "execution_success";
}

export interface ExecutionErrorEvent extends ComfyEventBase {
  type: "execution_error";
  node_id: string | null;
  node_type: string | null;
  exception_message: string;
  exception_type: string;
  traceback: string[];
}

export interface ExecutionInterruptedEvent extends ComfyEventBase {
  type: "execution_interrupted";
  node_id: string | null;
  node_type: string | null;
}

export interface StatusEvent {
  type: "status";
  queue_remaining: number;
}

export interface PreviewEvent {
  type: "preview";
  /** ComfyUI's image format tag: 1 = JPEG, 2 = PNG. */
  format: number;
  bytes: Uint8Array;
}

export type ComfyEvent =
  | ExecutionStartEvent
  | ExecutionCachedEvent
  | ExecutingEvent
  | ProgressEvent
  | ExecutedEvent
  | ExecutionSuccessEvent
  | ExecutionErrorEvent
  | ExecutionInterruptedEvent
  | StatusEvent
  | PreviewEvent;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function images(value: unknown): ComfyImageRef[] {
  if (!Array.isArray(value)) return [];
  const out: ComfyImageRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const image = entry as Record<string, unknown>;
    const filename = str(image.filename);
    if (!filename) continue;
    out.push({
      filename,
      subfolder: str(image.subfolder) ?? "",
      type: str(image.type) ?? "output",
    });
  }
  return out;
}

/** Every file a node reported, whatever key ComfyUI filed it under. */
export function outputImages(output: unknown): ComfyImageRef[] {
  if (typeof output !== "object" || output === null) return [];
  const record = output as Record<string, unknown>;
  return [
    ...images(record.images),
    ...images(record.gifs),
    ...images(record.videos),
  ];
}

/** Decode one JSON websocket message; unknown types are dropped. */
export function decodeComfyMessage(raw: string): ComfyEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  const type = str(message.type);
  const data =
    (typeof message.data === "object" && message.data !== null
      ? message.data
      : {}) as Record<string, unknown>;
  const prompt_id = str(data.prompt_id);

  switch (type) {
    case "execution_start":
      return { type, prompt_id, timestamp: num(data.timestamp) };
    case "execution_cached":
      return {
        type,
        prompt_id,
        nodes: Array.isArray(data.nodes) ? data.nodes.map(String) : [],
      };
    case "executing":
      return { type, prompt_id, node: str(data.node) ?? null };
    case "progress":
      return {
        type,
        prompt_id,
        node: str(data.node) ?? null,
        value: num(data.value) ?? 0,
        max: num(data.max) ?? 0,
      };
    case "executed": {
      const node = str(data.node) ?? str(data.display_node);
      if (!node) return null;
      return { type, prompt_id, node, images: outputImages(data.output) };
    }
    case "execution_success":
      return { type, prompt_id };
    case "execution_error":
      return {
        type,
        prompt_id,
        node_id: str(data.node_id) ?? null,
        node_type: str(data.node_type) ?? null,
        exception_message: str(data.exception_message) ??
          "ComfyUI reported an error",
        exception_type: str(data.exception_type) ?? "Exception",
        traceback: Array.isArray(data.traceback)
          ? data.traceback.map(String)
          : [],
      };
    case "execution_interrupted":
      return {
        type,
        prompt_id,
        node_id: str(data.node_id) ?? null,
        node_type: str(data.node_type) ?? null,
      };
    case "status": {
      const status = data.status as Record<string, unknown> | undefined;
      const info = status?.exec_info as Record<string, unknown> | undefined;
      return { type, queue_remaining: num(info?.queue_remaining) ?? 0 };
    }
    default:
      return null;
  }
}

/** ComfyUI's binary preview frame: 4-byte event id, 4-byte format, image. */
export function decodePreviewFrame(frame: Uint8Array): PreviewEvent | null {
  if (frame.length < 8) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0) !== 1) return null;
  return {
    type: "preview",
    format: view.getUint32(4),
    bytes: frame.subarray(8),
  };
}
