import { contentType } from "@std/media-types";
import { extname, fromFileUrl, join, normalize, resolve } from "@std/path";

/**
 * Serves the built Svelte app (§2: the frontend is built into `dist/` and
 * served by the Deno process). Unknown paths fall back to `index.html` so the
 * router owns the URL, which is what makes gallery filters linkable (§11.2).
 */

export function frontendDir(): string {
  return fromFileUrl(new URL("../frontend/dist", import.meta.url));
}

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ForgeUI</title></head>
<body style="background:#0d0d0d;color:#ededed;font-family:system-ui;padding:3rem">
<h1>ForgeUI</h1>
<p>The API is running, but the interface has not been built yet.</p>
<pre style="background:#1e1e1e;padding:12px;border-radius:6px">deno task ui:build</pre>
<p style="color:#8a8a8a">Or run <code>deno task ui:dev</code> for the dev server with hot reload.</p>
</body></html>
`;

async function file(path: string): Promise<Deno.FileInfo | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile ? stat : null;
  } catch {
    return null;
  }
}

export interface StaticOptions {
  /** Overridable so tests can point at a fixture build. */
  root?: string;
}

export async function serveFrontend(
  req: Request,
  url: URL,
  options: StaticOptions = {},
): Promise<Response> {
  const root = resolve(options.root ?? frontendDir());
  const requested = normalize(decodeURIComponent(url.pathname)).replace(
    /^\/+/,
    "",
  );
  const candidate = requested.length > 0 ? resolve(join(root, requested)) : "";
  const indexPath = join(root, "index.html");

  // A real asset, if the path names one inside the build.
  if (candidate.startsWith(`${root}/`)) {
    const stat = await file(candidate);
    if (stat) {
      const isHashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(candidate);
      return new Response(
        (await Deno.open(candidate, { read: true })).readable,
        {
          headers: {
            "content-type": contentType(extname(candidate)) ??
              "application/octet-stream",
            "content-length": String(stat.size),
            // Vite fingerprints its assets, so those can be cached hard.
            "cache-control": isHashed
              ? "private, max-age=31536000, immutable"
              : "private, no-cache",
          },
        },
      );
    }
  }

  const index = await file(indexPath);
  if (!index) {
    return new Response(NOT_BUILT_PAGE, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (req.method === "HEAD") {
    return new Response(null, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(await Deno.readTextFile(indexPath), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-cache",
    },
  });
}
