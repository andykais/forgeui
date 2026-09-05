import type { Database } from "@db/sqlite";
import type { ConfigStore } from "../config/config.ts";
import { ConfigError } from "../config/validate.ts";
import type { DataPaths } from "../config/paths.ts";
import { ManifestError } from "../workflows/manifest.ts";
import { ParamError } from "../workflows/coerce.ts";
import { RewriteError } from "../workflows/rewrite.ts";
import {
  WorkflowConflictError,
  WorkflowNotFoundError,
  type WorkflowStore,
} from "../workflows/loader.ts";
import { BodyError, error, methodNotAllowed, notFound } from "./json.ts";
import { configRoutes } from "./routes/config.ts";
import { workflowRoutes } from "./routes/workflows.ts";

export interface AppContext {
  config: ConfigStore;
  db: Database;
  paths: DataPaths;
  workflows: WorkflowStore;
}

export interface RouteMatch {
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (
  req: Request,
  match: RouteMatch,
) => Response | Promise<Response>;

export interface Route {
  method: string;
  /** `URLPattern` pathname, e.g. `/api/workflows/:id`. */
  path: string;
  handler: RouteHandler;
}

interface CompiledRoute extends Route {
  pattern: URLPattern;
}

export function routeTable(ctx: AppContext): Route[] {
  return [...configRoutes(ctx), ...workflowRoutes(ctx)];
}

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ForgeUI</title></head>
<body style="background:#0d0d0d;color:#ededed;font-family:system-ui;padding:3rem">
<h1>ForgeUI</h1>
<p>The API is running. The Svelte app is served from here once it is built.</p>
</body></html>
`;

export function createHandler(
  routes: Route[],
): (req: Request) => Promise<Response> {
  const compiled: CompiledRoute[] = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }));

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const methodsForPath: string[] = [];
    for (const route of compiled) {
      const result = route.pattern.exec({ pathname: url.pathname });
      if (!result) continue;
      if (route.method !== req.method) {
        methodsForPath.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(result.pathname.groups)) {
        if (value !== undefined) params[key] = decodeURIComponent(value);
      }
      try {
        return await route.handler(req, { params, url });
      } catch (cause) {
        return handlerError(cause, req);
      }
    }
    if (methodsForPath.length > 0) return methodNotAllowed(methodsForPath);
    if (url.pathname.startsWith("/api/")) return notFound(url.pathname);
    if (req.method === "GET" || req.method === "HEAD") {
      return new Response(PLACEHOLDER_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return notFound(url.pathname);
  };
}

function handlerError(cause: unknown, req: Request): Response {
  if (cause instanceof WorkflowNotFoundError) {
    return error(404, "not_found", cause.message);
  }
  if (cause instanceof WorkflowConflictError) {
    return error(409, "conflict", cause.message);
  }
  if (
    cause instanceof ConfigError || cause instanceof BodyError ||
    cause instanceof ManifestError || cause instanceof ParamError ||
    cause instanceof RewriteError
  ) {
    return error(400, "bad_request", cause.message);
  }
  console.error(`${req.method} ${req.url} failed:`, cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  return error(500, "internal_error", message);
}

export interface HttpServer {
  hostname: string;
  port: number;
  url: string;
  shutdown(): Promise<void>;
}

export function startHttpServer(
  ctx: AppContext,
  options: { hostname?: string; port?: number; signal?: AbortSignal } = {},
): Promise<HttpServer> {
  const handler = createHandler(routeTable(ctx));
  const hostname = options.hostname ?? ctx.config.config.server.host;
  const port = options.port ?? ctx.config.config.server.port;

  return new Promise((resolve, reject) => {
    let server: Deno.HttpServer<Deno.NetAddr>;
    try {
      server = Deno.serve({
        hostname,
        port,
        signal: options.signal,
        onListen: (addr) => {
          resolve({
            hostname: addr.hostname,
            port: addr.port,
            url: `http://${formatHost(addr.hostname)}:${addr.port}`,
            shutdown: () => server.shutdown(),
          });
        },
        onError: (cause) =>
          handlerError(cause, new Request("http://internal/")),
      }, handler);
    } catch (cause) {
      reject(cause);
      return;
    }
    server.finished.catch(reject);
  });
}

function formatHost(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}
