/**
 * `/comfy/*` → the ComfyUI port, so the embedded editor runs same-origin and
 * the app can call `app.graphToPrompt()` on the iframe (§4.1). Both HTTP and
 * websocket traffic go through here.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export const COMFY_PREFIX = "/comfy";

/** `/comfy/view?x=1` → `/view?x=1`. */
export function comfyTargetPath(url: URL): string {
  const path = url.pathname.slice(COMFY_PREFIX.length) || "/";
  return `${path.startsWith("/") ? path : `/${path}`}${url.search}`;
}

function forwardHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of from) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  }
  return headers;
}

/** The referring page as ComfyUI would name it: its origin, its path. */
function rerootReferer(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname.startsWith(COMFY_PREFIX)
      ? comfyTargetPath(url)
      : `${url.pathname}${url.search}`;
    return `${origin}${path}`;
  } catch {
    return null;
  }
}

/**
 * Requests the browser makes in CORS mode — every `<script crossorigin>` in
 * ComfyUI's own index.html — carry this app's origin. ComfyUI answers 403
 * when `Origin` does not match the host it is serving on, so a proxy that
 * forwards it verbatim serves an editor whose scripts all fail. Present
 * ComfyUI's own origin instead, as a reverse proxy is expected to.
 */
function forwardRequestHeaders(from: Headers, target: string): Headers {
  const headers = forwardHeaders(from);
  const origin = new URL(target).origin;
  if (headers.has("origin")) headers.set("origin", origin);
  const referer = headers.get("referer");
  if (referer) {
    const rewritten = rerootReferer(referer, origin);
    if (rewritten) headers.set("referer", rewritten);
    else headers.delete("referer");
  }
  return headers;
}

export interface ProxyOptions {
  /** Origin of the running ComfyUI, e.g. `http://127.0.0.1:8188`. */
  target: () => string;
  fetch?: typeof fetch;
}

export async function proxyHttp(
  req: Request,
  url: URL,
  options: ProxyOptions,
): Promise<Response> {
  const target = new URL(comfyTargetPath(url), options.target());
  const init: RequestInit = {
    method: req.method,
    headers: forwardRequestHeaders(req.headers, target.href),
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(target.href, init);
  } catch (cause) {
    return new Response(
      `ComfyUI is not reachable at ${options.target()}: ${
        cause instanceof Error ? cause.message : cause
      }`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: forwardHeaders(response.headers),
  });
}

/** Pipe a websocket both ways; ComfyUI's editor keeps one open. */
export function proxyWebSocket(
  req: Request,
  url: URL,
  options: ProxyOptions,
): Response {
  const target = new URL(comfyTargetPath(url), options.target());
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  const upstream = new WebSocket(target.href);
  client.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";

  const pending: (string | ArrayBuffer)[] = [];
  let upstreamOpen = false;

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const message of pending.splice(0)) upstream.send(message);
  };
  upstream.onmessage = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(event.data);
  };
  upstream.onclose = (event) => {
    try {
      client.close(closeCode(event.code), event.reason);
    } catch {
      // Already closing.
    }
  };
  upstream.onerror = () => {
    try {
      client.close(1011, "ComfyUI websocket failed");
    } catch {
      // Already closing.
    }
  };

  client.onmessage = (event) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(event.data);
    } else {
      pending.push(event.data);
    }
  };
  client.onclose = () => {
    try {
      upstream.close();
    } catch {
      // Already closing.
    }
  };
  client.onerror = () => {
    try {
      upstream.close();
    } catch {
      // Already closing.
    }
  };

  return response;
}

/** Codes outside 1000–4999 cannot be passed on to the other socket. */
function closeCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
    ? code
    : 1000;
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
