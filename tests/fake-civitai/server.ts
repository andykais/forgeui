/**
 * A stand-in for Civitai, CivArchive and the Hugging Face Hub, in the shape of `tests/fake-comfy/`
 * and for the same reason: the default suite must need nothing, and the real
 * Civitai is not a dependency a test gets to have
 * (DESIGN-MODEL-IMPORT §10).
 *
 * It exists because `import.civitai_url` and `import.archive_url` are config
 * rather than constants, which is the other half of why they are settings.
 *
 * What it asserts on the way through matters as much as what it serves: every
 * request is recorded, so a test can check that the lookup sent the
 * visibility parameter §4.0's table says it should — the one parameter the
 * whole argument rests on.
 */

export interface FakeCivitaiOptions {
  /** Model id → the `/api/v1/models/<id>` body. */
  models?: Record<number, unknown>;
  /** sha256 (lower case) → the `by-hash` body. */
  versionsByHash?: Record<string, unknown>;
  /** Version id → the `/api/v1/images` items for it. */
  images?: Record<number, unknown[]>;
  /** sha256 → the archive's `/api/sha256/<hash>` body. */
  archiveByHash?: Record<string, unknown>;
  /** Model id → the archive's `/api/models/<id>` body. */
  archiveModels?: Record<number, unknown>;
  /** Query → the archive's `/api/search?q=` rows. */
  archiveSearch?: Record<string, unknown[]>;
  /**
   * Tensor.Art model id → the model the archive's
   * `/tensorart/models/<id>/versions/<vid>` page embeds in `__NEXT_DATA__`.
   * A link without the version redirects to the model's own, as the real
   * one does.
   */
  tensorArtModels?: Record<string, Record<string, unknown>>;
  /** Bytes served for any image URL under `/img/`. */
  imageBytes?: Uint8Array;
  /**
   * Bytes served for `/api/download/models/<id>`, with the filename Civitai
   * would put in `content-disposition` — the only place a usable name lives,
   * since the URL path holds an opaque storage key.
   */
  download?: { bytes: Uint8Array; filename: string };
  /** Answer downloads with this status instead, for the gated-model path. */
  downloadStatus?: number;
  /**
   * The JSON a refused download answers with — real Civitai's
   * `{"error":"Early Access","deadline":…,"message":…}` — instead of "no".
   */
  downloadRefusal?: Record<string, unknown>;
  /**
   * Hugging Face repos, by `owner/repo`: the Hub's `/api/models/<repo>` body
   * (`id`, `pipeline_tag`, `cardData`, `siblings`, …) and the files in it.
   * A file with `sha256` is an LFS file; `text` or `bytes` is what `resolve`
   * serves for it.
   */
  hubRepos?: Record<string, FakeHubRepo>;
  /** Answer every Hub request for this repo with this status: gated, gone. */
  hubStatus?: Record<string, number>;
  /**
   * Answer any request whose path contains the key with this instead: a 429
   * with the archive's own wording, a 503, whatever a test needs.
   */
  failWith?: Record<
    string,
    { status: number; body?: string; headers?: Record<string, string> }
  >;
}

export interface FakeHubRepo {
  info: Record<string, unknown>;
  files: Record<
    string,
    { sha256?: string; size?: number; text?: string; bytes?: Uint8Array }
  >;
}

export interface RecordedRequest {
  path: string;
  params: Record<string, string>;
  /**
   * The `authorization` header, or null. Recorded so a test can assert where
   * a Civitai key went — and, more to the point, where it did not.
   */
  authorization: string | null;
}

export interface FakeCivitai {
  url: string;
  requests: RecordedRequest[];
  /** Every request whose path contains this fragment. */
  matching(fragment: string): RecordedRequest[];
  /**
   * What it serves, after it is listening. Fixtures need the port to build
   * the absolute URLs Civitai puts in its own responses, so they are filled
   * in here rather than passed to a server that does not exist yet.
   */
  configure(options: FakeCivitaiOptions): void;
  close(): Promise<void>;
}

export function startFakeCivitai(
  initial: FakeCivitaiOptions = {},
): FakeCivitai {
  let options = initial;
  const requests: RecordedRequest[] = [];
  const notFound = () =>
    new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      authorization: request.headers.get("authorization"),
    });
    const parts = url.pathname.split("/").filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));

    for (const [fragment, failure] of Object.entries(options.failWith ?? {})) {
      if (!url.pathname.includes(fragment)) continue;
      return new Response(failure.body ?? "", {
        status: failure.status,
        headers: failure.headers,
      });
    }

    const hub = await hubRoute(request, url, parts, options);
    if (hub !== null) return hub;

    // The CDN: any path under /img/ serves the same bytes.
    if (parts[0] === "img") {
      const bytes = options.imageBytes ?? new Uint8Array([0, 1, 2, 3]);
      return new Response(bytes.buffer as ArrayBuffer, {
        headers: { "content-type": "image/jpeg" },
      });
    }

    // The weights. Real Civitai 307s to a signed URL; what matters to the
    // client is that it follows redirects and reads the header, and `fetch`
    // has already followed by the time this answers.
    if (parts[0] === "api" && parts[1] === "download") {
      if (options.downloadStatus !== undefined) {
        return options.downloadRefusal === undefined
          ? new Response("no", { status: options.downloadStatus })
          : Response.json(options.downloadRefusal, {
            status: options.downloadStatus,
          });
      }
      const file = options.download;
      if (file === undefined) return notFound();
      return new Response(file.bytes.buffer as ArrayBuffer, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${file.filename}"`,
        },
      });
    }

    // civitai: /api/v1/...
    if (parts[0] === "api" && parts[1] === "v1") {
      if (parts[2] === "model-versions" && parts[3] === "by-hash") {
        const hash = (parts[4] ?? "").toLowerCase();
        const found = options.versionsByHash?.[hash];
        return found === undefined ? notFound() : ok(found);
      }
      if (parts[2] === "model-versions" && parts[3] !== undefined) {
        const id = Number(parts[3]);
        for (const model of Object.values(options.models ?? {})) {
          const versions =
            (model as { modelVersions?: Record<string, unknown>[] })
              .modelVersions ?? [];
          const version = versions.find((entry) => entry.id === id);
          if (version) return ok(version);
        }
        return notFound();
      }
      if (parts[2] === "models" && parts[3] !== undefined) {
        const found = options.models?.[Number(parts[3])];
        return found === undefined ? notFound() : ok(found);
      }
      if (parts[2] === "models") {
        // The name search: every model this fake knows.
        return ok({ items: Object.values(options.models ?? {}) });
      }
      if (parts[2] === "images") {
        const versionId = Number(url.searchParams.get("modelVersionId"));
        // `username` narrows to one account's posts, as the real one does:
        // asked for the creator, it is the version's own showcase.
        const username = url.searchParams.get("username");
        const items = (options.images?.[versionId] ?? []).filter((item) =>
          username === null ||
          (item as { username?: string }).username === username
        );
        // "Most Reactions" ranks by the reaction counts in `stats`, as the
        // real one does; anything else keeps the listed order.
        if (url.searchParams.get("sort") === "Most Reactions") {
          const reactions = (item: unknown) =>
            Object.values(
              (item as { stats?: Record<string, number> }).stats ?? {},
            ).reduce((sum, count) => sum + count, 0);
          items.sort((a, b) => reactions(b) - reactions(a));
        }
        return ok({ items });
      }
    }

    // civitaiarchive's mirror of Tensor.Art: server-rendered pages.
    if (parts[0] === "tensorart" && parts[1] === "models" && parts[2]) {
      const model = options.tensorArtModels?.[parts[2]];
      const version = (model?.version ?? {}) as { id?: string };
      if (model === undefined) {
        return new Response("Error 404", { status: 404 });
      }
      if (parts[3] !== "versions") {
        return new Response(null, {
          status: 307,
          headers: {
            location: `/tensorart/models/${parts[2]}/versions/${version.id}`,
          },
        });
      }
      if (parts[4] !== version.id) {
        return new Response("Error 404", { status: 404 });
      }
      return new Response(
        `<!DOCTYPE html><html><body><div id="__next"></div>` +
          `<script id="__NEXT_DATA__" type="application/json">${
            JSON.stringify({ props: { pageProps: { model } }, buildId: "fake" })
          }</script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    // civitaiarchive: /api/sha256/<hash> and /api/models/<id>
    if (parts[0] === "api" && parts[1] === "sha256") {
      const found = options.archiveByHash?.[(parts[2] ?? "").toLowerCase()];
      return found === undefined ? notFound() : ok(found);
    }
    if (parts[0] === "api" && parts[1] === "models" && parts[2] !== undefined) {
      const found = options.archiveModels?.[Number(parts[2])];
      return found === undefined ? notFound() : ok(found);
    }
    if (parts[0] === "api" && parts[1] === "search") {
      const query = url.searchParams.get("q") ?? "";
      return ok({ results: options.archiveSearch?.[query] ?? [] });
    }

    return notFound();
  };

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, handler);
  const { port } = server.addr as Deno.NetAddr;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    matching: (fragment) =>
      requests.filter((entry) => entry.path.includes(fragment)),
    configure: (next) => {
      options = next;
      requests.length = 0;
    },
    close: async () => {
      await server.shutdown();
    },
  };
}

/**
 * The Hub's routes, as `@huggingface/hub` calls them: model info at
 * `/api/models/<owner>/<repo>/revision/<rev>`, `paths-info` as a POST, the
 * model search, and `/<owner>/<repo>/resolve/<rev>/<path>` for the bytes.
 * Null for anything else, which is Civitai's or the archive's.
 */
async function hubRoute(
  request: Request,
  url: URL,
  parts: string[],
  options: FakeCivitaiOptions,
): Promise<Response | null> {
  const repos = options.hubRepos ?? {};
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refused = (repo: string) => {
    const status = options.hubStatus?.[repo];
    return status === undefined
      ? null
      : json({ error: `status ${status}` }, status);
  };

  // The search: `/api/models?search=…`, no repo in the path.
  if (parts[0] === "api" && parts[1] === "models" && parts.length === 2) {
    const query = (url.searchParams.get("search") ?? "").toLowerCase();
    return json(
      Object.values(repos).map((repo) => repo.info).filter((info) =>
        String(info.id).toLowerCase().includes(query)
      ),
    );
  }

  if (parts[0] === "api" && parts[1] === "models" && parts.length >= 5) {
    const repo = `${parts[2]}/${parts[3]}`;
    const found = repos[repo];
    if (found === undefined) return null;
    const refusal = refused(repo);
    if (refusal !== null) return refusal;
    if (parts[4] === "revision") return json(found.info);
    if (parts[4] === "paths-info" && request.method === "POST") {
      const body = await request.json() as { paths: string[] };
      return json(
        body.paths.filter((path) => path in found.files).map((path) => {
          const file = found.files[path]!;
          return {
            type: "file",
            path,
            oid: "0".repeat(40),
            size: file.size ?? file.bytes?.byteLength ?? file.text?.length ?? 0,
            ...(file.sha256 === undefined
              ? {}
              : { lfs: { oid: file.sha256, size: file.size ?? 0 } }),
          };
        }),
      );
    }
    return null;
  }

  if (parts[2] === "resolve" && parts.length >= 5) {
    const repo = `${parts[0]}/${parts[1]}`;
    const found = repos[repo];
    if (found === undefined) return null;
    const refusal = refused(repo);
    if (refusal !== null) return refusal;
    const path = parts.slice(4).join("/");
    const file = found.files[path];
    if (file === undefined) return json({ error: "no such file" }, 404);
    const bytes = file.bytes ?? new TextEncoder().encode(file.text ?? "");
    return new Response(bytes.buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${
          path.split("/").pop()
        }"`,
      },
    });
  }
  return null;
}
