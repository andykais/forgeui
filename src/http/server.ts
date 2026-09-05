import type { Database } from "@db/sqlite";
import type { ConfigStore } from "../config/config.ts";
import { ConfigError } from "../config/validate.ts";
import type { DataPaths } from "../config/paths.ts";
import { ComfyHttpError } from "../comfy/client.ts";
import { LaunchError } from "../comfy/launch.ts";
import type { ComfyManager } from "../comfy/manager.ts";
import {
  COMFY_PREFIX,
  isWebSocketUpgrade,
  proxyHttp,
  proxyWebSocket,
} from "../comfy/proxy.ts";
import {
  ComfyOfflineError,
  JobNotFoundError,
  JobRequestError,
  type JobRunner,
  JobSubmitError,
} from "../jobs/pipeline.ts";
import { CursorError } from "../outputs/cursor.ts";
import { MediaPathError } from "./media.ts";
import {
  OutputGoneError,
  OutputNotFoundError,
  type OutputStore,
} from "../outputs/store.ts";
import type { ModelScanner } from "../models/scan.ts";
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
import { jobRoutes } from "./routes/jobs.ts";
import { maintenanceRoutes } from "./routes/maintenance.ts";
import { modelRoutes } from "./routes/models.ts";
import { outputRoutes } from "./routes/outputs.ts";
import { serveFrontend } from "./static.ts";
import { systemRoutes } from "./routes/system.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import type { WsHub } from "./ws.ts";

export interface AppContext {
  config: ConfigStore;
  db: Database;
  paths: DataPaths;
  workflows: WorkflowStore;
  comfy: ComfyManager;
  jobs: JobRunner;
  outputs: OutputStore;
  models: ModelScanner;
  hub: WsHub;
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
  return [
    ...configRoutes(ctx),
    ...workflowRoutes(ctx),
    ...jobRoutes(ctx),
    ...outputRoutes(ctx),
    ...modelRoutes(ctx),
    ...systemRoutes(ctx),
    ...maintenanceRoutes(ctx),
  ];
}

export function createHandler(
  ctx: AppContext,
  routes: Route[] = routeTable(ctx),
): (req: Request) => Promise<Response> {
  const compiled: CompiledRoute[] = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }));

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // The app's own event stream, and the ComfyUI proxy (§4.1).
    if (url.pathname === "/ws") {
      if (!isWebSocketUpgrade(req)) {
        return error(400, "bad_request", "/ws expects a websocket upgrade");
      }
      return ctx.hub.handle(req);
    }
    if (
      url.pathname === COMFY_PREFIX ||
      url.pathname.startsWith(`${COMFY_PREFIX}/`)
    ) {
      const target = () => ctx.comfy.client.url;
      try {
        return isWebSocketUpgrade(req)
          ? proxyWebSocket(req, url, { target })
          : await proxyHttp(req, url, { target });
      } catch (cause) {
        return handlerError(cause, req);
      }
    }

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
    // Everything else is the Svelte app; its router owns the URL (§11.2).
    if (req.method === "GET" || req.method === "HEAD") {
      try {
        return await serveFrontend(req, url);
      } catch (cause) {
        return handlerError(cause, req);
      }
    }
    return notFound(url.pathname);
  };
}

function handlerError(cause: unknown, req: Request): Response {
  if (
    cause instanceof WorkflowNotFoundError ||
    cause instanceof JobNotFoundError ||
    cause instanceof OutputNotFoundError
  ) {
    return error(404, "not_found", cause.message);
  }
  if (cause instanceof OutputGoneError) {
    // The undo window closed and the bytes are gone (§11.2).
    return error(410, "gone", cause.message);
  }
  if (cause instanceof WorkflowConflictError || cause instanceof LaunchError) {
    return error(409, "conflict", cause.message);
  }
  if (cause instanceof ComfyOfflineError) {
    return error(503, "comfy_offline", cause.message);
  }
  if (cause instanceof JobSubmitError) {
    // ComfyUI refused the graph: the job row records the attempt either way.
    const response = error(502, "comfy_rejected", cause.message);
    return new Response(
      JSON.stringify({
        error: { code: "comfy_rejected", message: cause.message },
        node_errors: cause.nodeErrors,
        job: cause.job,
      }),
      { status: response.status, headers: response.headers },
    );
  }
  if (cause instanceof ComfyHttpError) {
    return error(502, "comfy_error", cause.message);
  }
  if (
    cause instanceof ConfigError || cause instanceof BodyError ||
    cause instanceof ManifestError || cause instanceof ParamError ||
    cause instanceof RewriteError || cause instanceof JobRequestError ||
    cause instanceof CursorError || cause instanceof MediaPathError
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
  const handler = createHandler(ctx);
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
