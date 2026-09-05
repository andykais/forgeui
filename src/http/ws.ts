/**
 * The app's own `/ws` (§12): JSON events for job, output and system changes,
 * plus ComfyUI's binary preview frames relayed with the job id in front (§5
 * step 6). Everything is pushed; nothing here is polled.
 */

export interface WsEvent {
  type:
    | "job"
    | "output"
    | "output_deleted"
    | "system_status"
    /** The model library's two background passes (§8.1). */
    | "rescan_progress"
    | "hashing_progress";
  data: unknown;
}

/**
 * Preview frame layout, little of which ComfyUI dictates:
 *
 *     uint32 event   always 1 (preview image)
 *     uint32 format  1 = JPEG, 2 = PNG, as ComfyUI tags it
 *     uint32 length  byte length of the job id that follows
 *     bytes  job id  UTF-8
 *     bytes  image
 */
export const PREVIEW_EVENT = 1;

export function encodePreviewFrame(
  jobId: string,
  format: number,
  image: Uint8Array,
): Uint8Array {
  const id = new TextEncoder().encode(jobId);
  const frame = new Uint8Array(12 + id.length + image.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, PREVIEW_EVENT);
  view.setUint32(4, format);
  view.setUint32(8, id.length);
  frame.set(id, 12);
  frame.set(image, 12 + id.length);
  return frame;
}

export interface DecodedPreviewFrame {
  jobId: string;
  format: number;
  image: Uint8Array;
}

export function decodePreviewFrame(
  frame: Uint8Array,
): DecodedPreviewFrame | null {
  if (frame.length < 12) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0) !== PREVIEW_EVENT) return null;
  const format = view.getUint32(4);
  const idLength = view.getUint32(8);
  if (frame.length < 12 + idLength) return null;
  return {
    jobId: new TextDecoder().decode(frame.subarray(12, 12 + idLength)),
    format,
    image: frame.subarray(12 + idLength),
  };
}

export class WsHub {
  #sockets = new Set<WebSocket>();
  /** Sent to every client the moment it connects. */
  #hello: (() => WsEvent[]) | null = null;

  onHello(build: () => WsEvent[]): void {
    this.#hello = build;
  }

  get size(): number {
    return this.#sockets.size;
  }

  handle(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      this.#sockets.add(socket);
      for (const event of this.#hello?.() ?? []) {
        this.#send(socket, JSON.stringify(event));
      }
    };
    socket.onclose = () => this.#sockets.delete(socket);
    socket.onerror = () => this.#sockets.delete(socket);
    return response;
  }

  broadcast(event: WsEvent): void {
    if (this.#sockets.size === 0) return;
    const payload = JSON.stringify(event);
    for (const socket of this.#sockets) this.#send(socket, payload);
  }

  broadcastPreview(jobId: string, format: number, image: Uint8Array): void {
    if (this.#sockets.size === 0) return;
    const frame = encodePreviewFrame(jobId, format, image);
    for (const socket of this.#sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }

  close(): void {
    for (const socket of [...this.#sockets]) {
      try {
        socket.close(1001, "the app is shutting down");
      } catch {
        // Already closing.
      }
    }
    this.#sockets.clear();
  }

  #send(socket: WebSocket, payload: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}
