/**
 * A stand-in for Civitai and CivArchive, in the shape of `tests/fake-comfy/`
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
}

export interface RecordedRequest {
  path: string;
  params: Record<string, string>;
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

  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
    });
    const parts = url.pathname.split("/").filter((part) => part.length > 0);

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
        return new Response("no", { status: options.downloadStatus });
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
        return ok({ items: options.images?.[versionId] ?? [] });
      }
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
