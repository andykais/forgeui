/**
 * Serving the bridge (DESIGN-AGENT-LOOP §5).
 *
 * Two bindings, one server: stdio when the harness launches the bridge as a
 * subprocess, Streamable HTTP when it is on another machine or wants to point
 * at a long-lived process. The protocol is identical either way.
 */

import type { McpServer, McpServerFactory } from "@modelcontextprotocol/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/** Keeps a proxy from closing a connection that a long round has left idle. */
const KEEPALIVE_MS = 15_000;

export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stdio ends when the harness closes our stdin; nothing to await but that.
  await new Promise<void>(() => {});
}

export interface HttpOptions {
  hostname: string;
  port: number;
  signal?: AbortSignal;
  onListen?: (address: { hostname: string; port: number }) => void;
}

/**
 * `createMcpHandler` builds a fresh server per request rather than sharing
 * one, which is why this takes a factory. The clients it closes over — ForgeUI
 * and llama-swap — are shared; only the protocol object is per-request.
 */
export function serveHttp(
  factory: McpServerFactory,
  options: HttpOptions,
): Deno.HttpServer<Deno.NetAddr> {
  const handler = createMcpHandler(factory);
  return Deno.serve({
    hostname: options.hostname,
    port: options.port,
    signal: options.signal,
    onListen: (address) => options.onListen?.(address),
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/mcp") {
      return new Response("not found\n", { status: 404 });
    }
    const response = await handler.fetch(request);
    return keepAlive(response);
  });
}

/**
 * Write an SSE comment every 15s on a streaming response.
 *
 * §5.3: a round takes minutes and sends nothing while it runs, which is how a
 * reverse proxy decides the connection is dead. A comment line is ignored by
 * every SSE parser and costs two bytes. This is a transport fix and has
 * nothing to do with the client's own request deadline — that one is the
 * harness's to configure.
 */
function keepAlive(response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") || response.body === null) {
    return response;
  }
  const encoder = new TextEncoder();
  const source = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch { /* closed under us */ }
      }, KEEPALIVE_MS);
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await source.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (cause) {
          controller.error(cause);
        } finally {
          clearInterval(timer);
        }
      };
      void pump();
    },
    cancel(reason) {
      void source.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
