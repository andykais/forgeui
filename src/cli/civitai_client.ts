/**
 * The half of `forge models` that touches the network
 * (DESIGN-MODEL-IMPORT §4).
 *
 * Every mapping this makes lives in `src/models/civitai.ts`, under unit test;
 * what is here is the fetching, the fallback and the retries. The order when
 * the input does not name a site is **civitai.red, then civitaiarchive.com**:
 * the first is the same API `.com` serves with a wider default filter, and
 * the second is the only one of the two that answers for a model Civitai has
 * deleted.
 *
 * Nothing here opens `app.db` or imports anything that does.
 */

import {
  type CivitaiEndpoint,
  type LookupResult,
  normalizeHash,
  sourceRecordFromArchive,
  sourceRecordFromCivitai,
  visibilityParams,
} from "../models/civitai.ts";

export class LookupError extends Error {
  override readonly name = "LookupError";
}

/** One row of a name search: enough to choose by, and the link to choose it. */
export interface Candidate {
  result: LookupResult;
  name: string;
  url: string;
  kind: string;
  baseModel: string | null;
  files: { name: string }[];
}

/** One candidate as a terminal line, with the filenames that disambiguate. */
export function describeCandidate(candidate: Candidate): string {
  const files = candidate.files.map((file) => file.name).slice(0, 3);
  return [
    `  ${candidate.name}`,
    candidate.baseModel === null ? null : ` [${candidate.baseModel}]`,
    `\n    ${candidate.url}`,
    files.length === 0 ? null : `\n    ${files.join(", ")}`,
  ].filter((part) => part !== null).join("");
}

function ambiguous(filename: string, matches: Candidate[]): string {
  return `"${filename}" matches ${matches.length} model versions; pass --url ` +
    `or --sha256checksum:\n${matches.map(describeCandidate).join("\n")}`;
}

export interface CivitaiClientOptions {
  civitaiUrl: string;
  archiveUrl: string;
  browsingLevel: number;
  timeoutMs: number;
  /** Injected by the tests, which point it at a local fake (§10). */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** `auto` is the order above; the others pin it to one source. */
export type LookupSource = "auto" | "red" | "archive";

export class CivitaiClient {
  #civitai: string;
  #archive: string;
  #browsingLevel: number;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;
  #now: () => Date;

  constructor(options: CivitaiClientOptions) {
    this.#civitai = options.civitaiUrl.replace(/\/+$/, "");
    this.#archive = options.archiveUrl.replace(/\/+$/, "");
    this.#browsingLevel = options.browsingLevel;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  get civitaiUrl(): string {
    return this.#civitai;
  }

  get archiveUrl(): string {
    return this.#archive;
  }

  // ------------------------------------------------------------- lookups

  /** The direct road, and the one every other input ends up on (§4.1). */
  async byHash(
    hash: string,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    const normalized = normalizeHash(hash);
    if (normalized === null) {
      throw new LookupError(`"${hash}" is not a sha256`);
    }
    const tried: string[] = [];

    if (source !== "archive") {
      // A hash lookup needs no visibility parameter: it answers for what it
      // is given (§4.0).
      const version = await this.#json(
        this.#url(
          this.#civitai,
          `/api/v1/model-versions/by-hash/${normalized}`,
          "by-hash",
        ),
      );
      if (version !== null) {
        const modelId = (version as { modelId?: number }).modelId;
        const model = modelId === undefined ? null : await this.#json(
          this.#url(this.#civitai, `/api/v1/models/${modelId}`, "models"),
        );
        return sourceRecordFromCivitai({
          model: (model ?? { id: modelId ?? null }) as Record<string, unknown>,
          version: version as Record<string, unknown>,
          baseUrl: this.#civitai,
          fetchedAt: this.#now(),
        });
      }
      tried.push(this.#civitai);
    }

    if (source !== "red") {
      const found = await this.#archiveByHash(normalized);
      if (found !== null) return found;
      tried.push(this.#archive);
    }

    throw new LookupError(
      `nothing at ${tried.join(" or ")} knows the hash ${normalized}`,
    );
  }

  /** `civitai.com/models/<id>[?modelVersionId=<v>]`, either host (§4.1). */
  async byModelId(
    modelId: number,
    versionId: number | null,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    if (source !== "archive") {
      const model = await this.#json(
        this.#url(this.#civitai, `/api/v1/models/${modelId}`, "models"),
      );
      if (model !== null) {
        const record = model as Record<string, unknown>;
        const versions = Array.isArray(record.modelVersions)
          ? record.modelVersions as Record<string, unknown>[]
          : [];
        const version = versionId === null
          ? versions[0] ?? null
          : versions.find((entry) => entry.id === versionId) ?? null;
        if (versionId !== null && version === null) {
          throw new LookupError(
            `model ${modelId} has no version ${versionId}`,
          );
        }
        return sourceRecordFromCivitai({
          model: record,
          version,
          baseUrl: this.#civitai,
          fetchedAt: this.#now(),
        });
      }
    }
    if (source !== "red") {
      const found = await this.#archiveByModelId(modelId, versionId);
      if (found !== null) return found;
    }
    throw new LookupError(`no model ${modelId} at Civitai or in the archive`);
  }

  /** A version id on its own — what a download URL names (§4.1). */
  async byVersionId(
    versionId: number,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    if (source !== "archive") {
      const version = await this.#json(
        this.#url(
          this.#civitai,
          `/api/v1/model-versions/${versionId}`,
          "by-hash",
        ),
      );
      if (version !== null) {
        const modelId = (version as { modelId?: number }).modelId ?? null;
        if (modelId !== null) return await this.byModelId(modelId, versionId);
      }
    }
    if (source !== "red") {
      const found = await this.#archiveByModelId(null, versionId);
      if (found !== null) return found;
    }
    throw new LookupError(`no model version ${versionId}`);
  }

  /** `civitai.red/images/<id>` → the version it was posted under (§4.1). */
  async byImageId(
    imageId: number,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    const images = await this.#json(
      this.#url(this.#civitai, "/api/v1/images", "images", {
        imageId: String(imageId),
        limit: "1",
      }),
    );
    const item = Array.isArray((images as { items?: unknown[] })?.items)
      ? (images as { items: Record<string, unknown>[] }).items[0]
      : undefined;
    const versionId = typeof item?.modelVersionId === "number"
      ? item.modelVersionId
      : null;
    if (versionId === null) {
      throw new LookupError(
        `image ${imageId} does not name a model version`,
      );
    }
    return await this.byVersionId(versionId, source);
  }

  /**
   * The name search `--filename` falls back to when nothing on disk matches
   * (§4.1). A result is accepted only when one of its version files carries
   * exactly that filename — two matches is an error listing them, not a guess.
   */
  async byFilename(filename: string): Promise<LookupResult> {
    const stem = filename.replace(/\.[^.]+$/, "");
    const found = await this.search(stem);

    // An exact filename match is still the best answer there is: it means
    // this is the file, not something with a similar name.
    const exact = found.filter((candidate) =>
      candidate.files.some((file) => file.name === filename)
    );
    if (exact.length === 1) return exact[0]!.result;
    if (exact.length > 1) {
      throw new LookupError(ambiguous(filename, exact));
    }

    // Nothing carries that exact name. Civitai stores its own mangled
    // filenames — `krea2_turbo_bf16.safetensors` on your disk is
    // `krea2TurboFP8_krea2TURBO.safetensors` there — so a near miss is the
    // normal case rather than a failure, and the useful answer is the list.
    if (found.length > 0) {
      throw new LookupError(
        `no model on Civitai has a file named exactly "${filename}", but ` +
          `${found.length} look close. Pick one and pass its --url:\n${
            found.map(describeCandidate).join("\n")
          }`,
      );
    }
    throw new LookupError(
      `nothing on Civitai matches "${stem}". Try --url with a link, or ` +
        `--sha256checksum if you know the hash.`,
    );
  }

  /**
   * A name search, as its own operation (§4.1, amended): `forge models
   * --search` lists what is out there, and `--filename` uses it to say what
   * it nearly matched instead of dead-ending.
   */
  async search(query: string): Promise<Candidate[]> {
    const body = await this.#json(
      this.#url(this.#civitai, "/api/v1/models", "models", {
        query,
        limit: "20",
      }),
    );
    const items = Array.isArray((body as { items?: unknown[] })?.items)
      ? (body as { items: Record<string, unknown>[] }).items
      : [];

    const candidates: Candidate[] = [];
    for (const model of items) {
      const versions = Array.isArray(model.modelVersions)
        ? model.modelVersions as Record<string, unknown>[]
        : [];
      // The newest version only: a model with forty of them would otherwise
      // bury every other result.
      const version = versions[0] ?? null;
      const result = sourceRecordFromCivitai({
        model,
        version,
        baseUrl: this.#civitai,
        fetchedAt: this.#now(),
      });
      candidates.push({
        result,
        name: result.display_name ?? "(unnamed)",
        url: result.record.source.url,
        kind: result.kind,
        baseModel: result.record.version.base_model,
        files: result.files.map((file) => ({ name: file.name })),
      });
    }
    return candidates;
  }

  // ------------------------------------------------------------- archive

  async #archiveByHash(hash: string): Promise<LookupResult | null> {
    const found = await this.#json(
      `${this.#archive}/api/sha256/${hash}`,
    ) as { files?: Record<string, unknown>[] } | null;
    const file =
      found?.files?.find((entry) =>
        entry.source === "civitai" && entry.model_id != null
      ) ?? found?.files?.[0];
    if (!file) return null;
    const modelId = Number(file.model_id);
    const versionId = Number(file.model_version_id);
    return await this.#archiveByModelId(
      Number.isFinite(modelId) ? modelId : null,
      Number.isFinite(versionId) ? versionId : null,
    );
  }

  async #archiveByModelId(
    modelId: number | null,
    versionId: number | null,
  ): Promise<LookupResult | null> {
    if (modelId === null) return null;
    const query = versionId === null ? "" : `?modelVersionId=${versionId}`;
    const model = await this.#json(
      `${this.#archive}/api/models/${modelId}${query}`,
    );
    if (model === null) return null;
    return sourceRecordFromArchive({
      model: model as Record<string, unknown>,
      baseUrl: this.#archive,
      fetchedAt: this.#now(),
    });
  }

  // -------------------------------------------------------------- images

  /**
   * The version's images with their generation data (§4.3). `withMeta` keeps
   * the list to images there is something to show for; the archive has no
   * image endpoint at all, so a lookup through it brings whatever it already
   * carried and this is not called.
   */
  async imagesFor(
    versionId: number,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.#json(
      this.#url(this.#civitai, "/api/v1/images", "images", {
        modelVersionId: String(versionId),
        limit: String(Math.min(Math.max(limit, 1), 200)),
        sort: "Newest",
        withMeta: "true",
      }),
    );
    const items = (body as { items?: unknown[] })?.items;
    return Array.isArray(items) ? items as Record<string, unknown>[] : [];
  }

  /** Sample bytes, straight off the CDN — public, and not the CLI's job. */
  async download(url: string): Promise<Uint8Array> {
    const response = await this.#request(url);
    if (!response.ok) {
      throw new LookupError(`GET ${url} answered ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  // ------------------------------------------------------------ plumbing

  #url(
    base: string,
    path: string,
    endpoint: CivitaiEndpoint,
    extra: Record<string, string> = {},
  ): string {
    const url = new URL(path, `${base}/`);
    for (
      const [key, value] of Object.entries({
        ...visibilityParams(endpoint, this.#browsingLevel),
        ...extra,
      })
    ) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /** A 404 is an answer — "not here" — and every other failure is an error. */
  async #json(url: string): Promise<unknown | null> {
    const response = await this.#request(url);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new LookupError(
        `GET ${url} answered ${response.status}${
          detail.length > 0 ? `: ${detail}` : ""
        }`,
      );
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new LookupError(
        `GET ${url} did not answer with JSON: ${
          cause instanceof Error ? cause.message : cause
        }`,
      );
    }
  }

  async #request(url: string): Promise<Response> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      return await this.#fetch(url, {
        signal,
        headers: { accept: "application/json" },
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new LookupError(`GET ${url} timed out`);
      }
      throw new LookupError(
        `GET ${url} failed: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  }
}
