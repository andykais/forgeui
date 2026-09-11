import { join } from "@std/path";
import { LaunchError } from "../../comfy/launch.ts";
import { json } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

export interface StorageUse {
  files: number;
  bytes: number;
}

/** Files and bytes under one directory; a missing one reads as empty. */
async function measure(root: string): Promise<StorageUse> {
  const use: StorageUse = { files: 0, bytes: 0 };
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      try {
        const stat = await Deno.stat(path);
        use.files++;
        use.bytes += stat.size;
      } catch {
        // Removed between the listing and the stat; it is not there to count.
      }
    }
  };
  await walk(root);
  return use;
}

/** `app.db` and the two files WAL mode keeps beside it (§7). */
async function databaseUse(path: string): Promise<StorageUse> {
  const use: StorageUse = { files: 0, bytes: 0 };
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      use.bytes += (await Deno.stat(candidate)).size;
      use.files++;
    } catch {
      // Only `app.db` is always there.
    }
  }
  return use;
}

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
    {
      method: "GET",
      path: "/api/system/storage",
      handler: async () => {
        const [outputs, inputs, samples, staging, db, telemetry] = await Promise
          .all([
            measure(ctx.paths.outputs),
            measure(ctx.paths.inputs),
            measure(ctx.paths.samples),
            measure(ctx.paths.staging),
            databaseUse(ctx.paths.db),
            // The health log grows on its own and is safe to delete (§7.1),
            // so it is its own line rather than folded into `db`.
            databaseUse(ctx.paths.telemetryDb),
          ]);
        // Model folders are not measured: they are somebody else's disk, and
        // the app never writes there (§3).
        return json({
          data_dir: ctx.paths.root,
          outputs,
          inputs,
          samples,
          staging,
          db,
          telemetry,
          total: {
            files: outputs.files + inputs.files + samples.files +
              staging.files + db.files + telemetry.files,
            bytes: outputs.bytes + inputs.bytes + samples.bytes +
              staging.bytes + db.bytes + telemetry.bytes,
          },
        });
      },
    },
  ];
}
