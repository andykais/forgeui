import { LaunchError } from "../../comfy/launch.ts";
import { json } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/** §12's `/api/system/*` group: what Settings and the queue strip read. */
export function systemRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/system/status",
      handler: async () => {
        await ctx.comfy.refreshStats();
        return json({
          comfy: ctx.comfy.status(),
          data_dir: ctx.paths.root,
        });
      },
    },
    {
      method: "POST",
      path: "/api/system/comfy/restart",
      handler: async () => {
        if (ctx.comfy.mode !== "managed") {
          throw new LaunchError(
            "the app does not own this ComfyUI: switch to managed mode to restart it",
          );
        }
        await ctx.comfy.restart();
        return json({ comfy: ctx.comfy.status() });
      },
    },
    {
      method: "GET",
      path: "/api/system/comfy/log",
      handler: (_req, { url }) => {
        const limit = Number(url.searchParams.get("lines") ?? "200");
        const lines = ctx.comfy.log(
          Number.isInteger(limit) && limit > 0 ? limit : 200,
        );
        return json({
          mode: ctx.comfy.mode,
          lines,
          // Only a managed child has a log the app can read (§11.2).
          available: ctx.comfy.mode === "managed",
        });
      },
    },
  ];
}
