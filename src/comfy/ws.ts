import {
  type ComfyEvent,
  decodeComfyMessage,
  decodePreviewFrame,
} from "./events.ts";

/**
 * The websocket half of the ComfyUI connection: reconnects on its own and
 * tells the caller each time it comes back, which is the app's cue to
 * reconcile jobs it may have missed events for (§5 step 6).
 */

export interface ComfyWsOptions {
  url: () => string;
  onEvent: (event: ComfyEvent) => void;
  /** Called after every successful (re)connection. */
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  /** Backoff schedule in ms; the last value repeats. */
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 5000];

export class ComfyWsClient {
  #options: ComfyWsOptions;
  #socket: WebSocket | null = null;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #connected = false;

  constructor(options: ComfyWsOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#open();
  }

  /** Drop the connection and stop retrying. */
  stop(): void {
    this.#stopped = true;
    this.#connected = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }

  /** Drop the current connection but keep reconnecting, as a restart does. */
  reset(): void {
    if (this.#stopped) return;
    this.stop();
    this.#stopped = false;
    this.#attempt = 0;
    this.#open();
  }

  #open(): void {
    if (this.#stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#options.url());
    } catch (cause) {
      this.#scheduleRetry(
        cause instanceof Error ? cause.message : String(cause),
      );
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#connected = true;
      this.#options.onOpen?.();
    };
    socket.onmessage = (event) => this.#onMessage(event);
    socket.onerror = () => {
      // A failed connection also fires onclose; retry is scheduled there.
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      const wasConnected = this.#connected;
      this.#connected = false;
      if (wasConnected) this.#options.onClose?.(event.reason || "closed");
      this.#scheduleRetry(event.reason || "closed");
    };
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      const decoded = decodeComfyMessage(event.data);
      if (decoded) this.#options.onEvent(decoded);
      return;
    }
    const frame = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : null;
    if (!frame) return;
    const preview = decodePreviewFrame(frame);
    if (preview) this.#options.onEvent(preview);
  }

  #scheduleRetry(_reason: string): void {
    if (this.#stopped || this.#timer !== null) return;
    const backoff = this.#options.backoffMs ?? DEFAULT_BACKOFF;
    const wait = backoff[Math.min(this.#attempt, backoff.length - 1)] ?? 1000;
    this.#attempt++;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, wait);
  }
}
