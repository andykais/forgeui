import { delay } from "@std/async/delay";

/**
 * Minimal websocket client for tests: records every message the fake (or the
 * app's own `/ws`) sends and lets a test wait for one.
 */
export interface WsJsonMessage {
  kind: "json";
  type: string;
  data: Record<string, unknown>;
}

export interface WsBinaryMessage {
  kind: "binary";
  /** ComfyUI's binary preview header: event id and image format. */
  event: number;
  format: number;
  bytes: Uint8Array;
}

export type WsMessage = WsJsonMessage | WsBinaryMessage;

export class TestSocket {
  readonly messages: WsMessage[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  #socket: WebSocket;
  #waiters: { match: (m: WsMessage) => boolean; resolve: () => void }[] = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => this.#onMessage(event);
    socket.onclose = (event) => {
      this.closes.push({ code: event.code, reason: event.reason });
    };
  }

  static connect(url: string, timeoutMs = 5000): Promise<TestSocket> {
    const socket = new WebSocket(url);
    const client = new TestSocket(socket);
    return new Promise<TestSocket>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`websocket ${url} did not open`)),
        timeoutMs,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(client);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`websocket ${url} failed`));
      };
    });
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  get jsonTypes(): string[] {
    return this.messages
      .filter((m): m is WsJsonMessage => m.kind === "json")
      .map((m) => m.type);
  }

  json(type: string): WsJsonMessage[] {
    return this.messages.filter(
      (m): m is WsJsonMessage => m.kind === "json" && m.type === type,
    );
  }

  binary(): WsBinaryMessage[] {
    return this.messages.filter(
      (m): m is WsBinaryMessage => m.kind === "binary",
    );
  }

  /** Resolve as soon as a matching message has arrived (past or future). */
  async waitFor(
    match: string | ((message: WsMessage) => boolean),
    timeoutMs = 5000,
  ): Promise<WsMessage> {
    const predicate = typeof match === "string"
      ? (m: WsMessage) => m.kind === "json" && m.type === match
      : match;
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    let resolveWaiter = () => {};
    const waited = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    const waiter = { match: predicate, resolve: resolveWaiter };
    this.#waiters.push(waiter);
    try {
      await Promise.race([
        waited,
        delay(timeoutMs).then(() => {
          throw new Error(
            `no websocket message matched ${
              typeof match === "string" ? match : "predicate"
            } within ${timeoutMs}ms; saw: ${this.jsonTypes.join(", ")}`,
          );
        }),
      ]);
    } finally {
      this.#waiters = this.#waiters.filter((w) => w !== waiter);
    }
    return this.messages.find(predicate)!;
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      const parsed = JSON.parse(event.data) as {
        type: string;
        data: Record<string, unknown>;
      };
      this.#record({
        kind: "json",
        type: parsed.type,
        data: parsed.data ?? {},
      });
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#record({
      kind: "binary",
      event: view.getUint32(0),
      format: view.getUint32(4),
      bytes: bytes.subarray(8),
    });
  }

  #record(message: WsMessage): void {
    this.messages.push(message);
    for (const waiter of [...this.#waiters]) {
      if (waiter.match(message)) waiter.resolve();
    }
  }
}
