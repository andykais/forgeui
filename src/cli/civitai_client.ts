/**
 * The half of `forge models` that touches the network
 * (DESIGN-MODEL-IMPORT §4).
 *
 * Every mapping this makes lives in `src/models/civitai.ts`, under unit test;
 * what is here is the fetching, the fallback and the retries. The order when
 * the input does not name a site is **civitai.red, then civitaiarchive.com**:
 * the first is the same API `.com` serves with a wider default filter, and
 * the second is the only one of the two that answers for a model Civitai has
 * deleted. Tensor.Art and Hugging Face come after, and only when the archive
 * knows the hash as their copy with no Civitai model behind it (§4.5, §4.6);
 * Tensor.Art is read from the archive's mirror of it, which is the only part
 * of it a script can ask.
 *
 * Nothing here opens `app.db` or imports anything that does.
 */

import {
  type CivitaiEndpoint,
  type LookupResult,
  normalizeHash,
  pinToHash,
  sourceRecordFromArchive,
  sourceRecordFromCivitai,
  visibilityParams,
} from "../models/civitai.ts";
import {
  type HuggingFaceRef,
  parseHuggingFaceUrl,
} from "../models/huggingface.ts";
import {
  archivePagePath,
  pageModel,
  sourceRecordFromTensorArt,
  tensorArtModelUrl,
  type TensorArtRef,
} from "../models/tensorart.ts";
import type { HuggingFaceClient } from "./huggingface_client.ts";

/**
 * Why a lookup failed, in a word `fetched/failure/<sha256>/error.txt` carries
 * (§3.2) — so the ones worth trying again can be told from the ones that
 * are not, and pruned by grepping for `failure: rate-limited`.
 */
export type FailureKind =
  /** The sources answered, and the answer was no. */
  | "not-found"
  /** 429: asked too often; try again later. */
  | "rate-limited"
  /** 401 / 403: gated, private or paid, and no key that works. */
  | "needs-login"
  /** 5xx: the source is having a bad time. */
  | "server-error"
  /** No answer at all: a timeout, a refused connection, DNS. */
  | "unreachable"
  /** The download started and did not finish. */
  | "download-failed"
  | "error";

export class LookupError extends Error {
  override readonly name: string = "LookupError";
  readonly kind: FailureKind;
  constructor(message: string, kind: FailureKind = "error") {
    super(message);
    this.kind = kind;
  }
}

/**
 * A lookup whose answer was *no* — nobody knows this hash, no model page
 * stands behind it, the bytes cannot match — as opposed to one that failed
 * to get an answer.
 */
export class NotFoundError extends LookupError {
  override readonly name = "NotFoundError";
  constructor(message: string) {
    super(message, "not-found");
  }
}

/** Kind of an HTTP status that is not a success. */
export function statusKind(status: number): FailureKind {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "needs-login";
  if (status >= 500) return "server-error";
  return "error";
}

/** A file the archive indexes, which is identified by its hash. */
export interface ArchiveFile {
  name: string;
  sha256: string;
  platform: string;
  baseModel: string | null;
  deleted: boolean;
}

/** One row of a name search: enough to choose by, and the link to choose it. */
export interface Candidate {
  /** Civitai's search carries the whole answer; Hugging Face's, a link. */
  result?: LookupResult;
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
  timeoutMs: number;
  /**
   * A Civitai API key. Sent to Civitai and to nothing else — not the archive,
   * which is a different service, and not the image CDN, which is public.
   */
  token?: string | null;
  /** Where a hash the archive knows only as a Hugging Face copy goes. */
  huggingface?: HuggingFaceClient | null;
  /** The choice made when a hash has several copies. */
  say?: (line: string) => void;
  /** Injected by the tests, which point it at a local fake (§10). */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * `auto` is the order above; the others pin a lookup to one source, which is
 * what `--import-source` sets. `civitai` is whichever Civitai host the client
 * was built for — `civitai.red` and `civitai.com` are the same API (§4.0).
 */
export type LookupSource =
  | "auto"
  | "civitai"
  | "archive"
  | "huggingface"
  | "tensorart";

function asks(source: LookupSource, site: Exclude<LookupSource, "auto">) {
  return source === "auto" || source === site;
}

export class CivitaiClient {
  #civitai: string;
  #archive: string;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;
  #now: () => Date;
  #token: string | null;
  /**
   * The URLs this client built for Civitai, which are the only ones the token
   * goes to. Decided by who built the URL rather than by comparing hosts,
   * because the hosts are configuration: point both at one server and a host
   * check would happily hand a Civitai key to the archive.
   */
  #forCivitai = new Set<string>();
  #huggingface: HuggingFaceClient | null;
  #say: (line: string) => void;

  constructor(options: CivitaiClientOptions) {
    this.#civitai = options.civitaiUrl.replace(/\/+$/, "");
    this.#archive = options.archiveUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#token = options.token ?? null;
    this.#huggingface = options.huggingface ?? null;
    this.#say = options.say ?? (() => {});
  }

  get huggingface(): HuggingFaceClient | null {
    return this.#huggingface;
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

    if (asks(source, "civitai")) {
      // A hash lookup needs no visibility parameter: it answers for what it
      // is given (§4.0).
      const version = await this.#json(
        this.#civitaiUrl(
          this.#civitai,
          `/api/v1/model-versions/by-hash/${normalized}`,
          "by-hash",
        ),
      );
      if (version !== null) {
        const modelId = (version as { modelId?: number }).modelId;
        const model = modelId === undefined ? null : await this.#json(
          this.#civitaiUrl(
            this.#civitai,
            `/api/v1/models/${modelId}`,
            "models",
          ),
        );
        return pinToHash(
          sourceRecordFromCivitai({
            model: (model ?? { id: modelId ?? null }) as Record<
              string,
              unknown
            >,
            version: version as Record<string, unknown>,
            baseUrl: this.#civitai,
            fetchedAt: this.#now(),
          }),
          normalized,
        );
      }
      tried.push(this.#civitai);
    }

    if (source !== "civitai") {
      // Hugging Face cannot be asked for a hash; the archive's index of its
      // copies is the only road there, so `huggingface` asks the archive too.
      let files: Record<string, unknown>[];
      try {
        files = await this.#archiveFiles(normalized);
      } catch (cause) {
        // A rate limit or an outage at the archive closes the road to
        // Hugging Face too, which the bare HTTP error would not say.
        if (!(cause instanceof LookupError)) throw cause;
        const before = tried.length > 0
          ? ` ${tried.join(" and ")} had no match first.`
          : "";
        const others = [
          ...(asks(source, "tensorart") ? ["Tensor.Art"] : []),
          ...(asks(source, "huggingface") && this.#huggingface !== null
            ? ["Hugging Face"]
            : []),
        ];
        const hub = others.length > 0
          ? ` ${others.join(" and ")} could not be checked either: the ` +
            `archive is the only index of ${
              others.length > 1 ? "their" : "its"
            } copies by hash.`
          : "";
        throw new LookupError(`${cause.message}.${before}${hub}`, cause.kind);
      }
      if (asks(source, "archive")) {
        const found = await this.#archiveModel(files);
        if (found !== null) return pinToHash(found, normalized);
      }
      // A Tensor.Art copy is a model page — description, trigger words,
      // images — so it comes before Hugging Face's README (§4.6).
      const tensorArt = tensorArtCopies(files);
      if (asks(source, "tensorart") && tensorArt.length > 0) {
        return await this.#bestTensorArt(tensorArt, normalized);
      }
      const copies = huggingFaceCopies(files);
      if (
        asks(source, "huggingface") && copies.length > 0 &&
        this.#huggingface !== null
      ) {
        return await this.#huggingface.byCopies(normalized, copies);
      }
      if (files.length > 0) throw mirrorOnly(files, copies.length, source);
      tried.push(
        source === "huggingface"
          ? `${this.#archive} (Hugging Face's only index by hash)`
          : source === "tensorart"
          ? `${this.#archive} (Tensor.Art's only index by hash)`
          : this.#archive,
      );
    }

    throw new NotFoundError(
      `nothing at ${tried.join(" or ")} knows the hash ${normalized}${
        source === "auto" && this.#huggingface !== null
          ? ". Hugging Face was not asked: it cannot be searched by hash, and " +
            "the archive, the only index of its copies, lists none of this file"
          : ""
      }`,
    );
  }

  /** `civitai.com/models/<id>[?modelVersionId=<v>]`, either host (§4.1). */
  async byModelId(
    modelId: number,
    versionId: number | null,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    civitaiOnly(source);
    if (asks(source, "civitai")) {
      const model = await this.#json(
        this.#civitaiUrl(this.#civitai, `/api/v1/models/${modelId}`, "models"),
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
    if (asks(source, "archive")) {
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
    civitaiOnly(source);
    if (asks(source, "civitai")) {
      const version = await this.#json(
        this.#civitaiUrl(
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
    if (asks(source, "archive")) {
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
    civitaiOnly(source);
    const images = await this.#json(
      this.#civitaiUrl(this.#civitai, "/api/v1/images", "images", {
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
   * A Tensor.Art model, through the archive's mirror of it (§4.6): the site
   * itself answers no script. `hash`, from a hash lookup, picks the file the
   * batch is about.
   */
  async byTensorArt(
    ref: TensorArtRef,
    hash: string | null = null,
  ): Promise<LookupResult> {
    const url = `${this.#archive}${archivePagePath(ref)}`;
    const html = await this.#html(url);
    if (html === null) {
      throw new NotFoundError(
        `the archive has no copy of Tensor.Art model ${ref.model_id}${
          ref.version_id === null ? "" : ` version ${ref.version_id}`
        } (${tensorArtModelUrl(ref.model_id)}). Tensor.Art itself cannot be ` +
          `asked by a script, so the archive's copy is the only one there is.`,
      );
    }
    const model = pageModel(html);
    if (model === null) {
      throw new LookupError(
        `${url} did not carry its model data — the archive's page has ` +
          `changed shape, which this build does not read`,
      );
    }
    const found = sourceRecordFromTensorArt({
      model,
      hash,
      fetchedAt: this.#now(),
    });
    return hash === null ? found : pinToHash(found, hash);
  }

  /**
   * One file, several Tensor.Art pages: re-uploads are as common there as on
   * Hugging Face (one FLUX file has two, the original at 1.8 million
   * downloads and a copy with no description). The most downloaded of the
   * first few is taken, and the choice is said with how to make another.
   */
  async #bestTensorArt(
    refs: TensorArtRef[],
    hash: string,
  ): Promise<LookupResult> {
    const distinct = [
      ...new Map(refs.map((ref) => [ref.model_id, ref])).values(),
    ];
    if (distinct.length === 1) {
      return await this.byTensorArt(distinct[0]!, hash);
    }
    const pages: { result: LookupResult; downloads: number }[] = [];
    for (const ref of distinct.slice(0, 6)) {
      try {
        const result = await this.byTensorArt(ref, hash);
        const downloads = result.record.stats?.downloads;
        pages.push({
          result,
          downloads: typeof downloads === "number" ? downloads : 0,
        });
      } catch (cause) {
        // A copy the archive has lost is not a candidate, and not an error.
        if (!(cause instanceof NotFoundError)) throw cause;
      }
    }
    if (pages.length === 0) {
      throw new NotFoundError(
        `the archive lists ${distinct.length} Tensor.Art copies of this file ` +
          `and has a page for none of them`,
      );
    }
    pages.sort((a, b) => b.downloads - a.downloads);
    const best = pages[0]!;
    if (pages.length > 1) {
      this.#say(
        `${pages.length} Tensor.Art models hold this file; using ${best.result.record.source.url} ` +
          `(${best.downloads.toLocaleString("en")} downloads). Pass --url to ` +
          `use another.`,
      );
    }
    return best.result;
  }

  /** `--search … --import-source tensorart`: the archive's Tensor.Art rows. */
  async searchTensorArt(query: string): Promise<Candidate[]> {
    const rows = await this.#archiveRows(query);
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.platform !== "tensorart" || row.kind !== "version") continue;
      const ref = tensorArtRow(row);
      if (ref === null || seen.has(ref.model_id)) continue;
      seen.add(ref.model_id);
      out.push({
        name: typeof row.name === "string" ? row.name : ref.model_id,
        url: tensorArtModelUrl(ref.model_id),
        kind: typeof row.type === "string" ? row.type : "model",
        baseModel: typeof row.base_model === "string" ? row.base_model : null,
        files: [],
      });
    }
    return out;
  }

  /**
   * A filename, through the archive's Tensor.Art file rows: each names the
   * version page it belongs to, and the page has the file's hash.
   */
  async #byTensorArtFilename(filename: string): Promise<LookupResult | null> {
    const wanted = filename.toLowerCase();
    const refs = new Map<string, TensorArtRef>();
    for (const row of await this.#archiveRows(filename)) {
      if (row.platform !== "tensorart" || row.kind !== "file") continue;
      if (String(row.name ?? "").toLowerCase() !== wanted) continue;
      const ref = tensorArtRow(row);
      if (ref !== null) refs.set(`${ref.model_id}/${ref.version_id}`, ref);
    }
    if (refs.size === 0) return null;
    if (refs.size > 1) {
      throw new LookupError(
        `the archive has ${refs.size} Tensor.Art models with a file named ` +
          `"${filename}"; pass --url with the one you mean:\n${
            [...refs.values()].map((ref) =>
              `  ${tensorArtModelUrl(ref.model_id)}`
            ).join("\n")
          }`,
      );
    }
    const found = await this.byTensorArt([...refs.values()][0]!);
    const file = found.files.find((entry) =>
      entry.name.toLowerCase() === wanted
    );
    return file?.sha256 ? pinToHash(found, file.sha256) : found;
  }

  /**
   * The name search `--filename` falls back to when nothing on disk matches
   * (§4.1). A result is accepted only when one of its version files carries
   * exactly that filename — two matches is an error listing them, not a guess.
   */
  async byFilename(
    filename: string,
    source: LookupSource = "auto",
  ): Promise<LookupResult> {
    const stem = filename.replace(/\.[^.]+$/, "");
    const near: Candidate[] = [];

    if (asks(source, "civitai")) {
      const items = await this.#searchItems(stem);
      // An exact filename match is the best answer there is: it means this is
      // the file, not something with a similar name. Every version is looked
      // in, not just the newest a listing shows — a model's older versions
      // are usually for other base models, and are exactly the files people
      // have on disk.
      const exact: Candidate[] = [];
      for (const model of items) {
        const versions = Array.isArray(model.modelVersions)
          ? model.modelVersions as Record<string, unknown>[]
          : [];
        for (const version of versions) {
          const files = Array.isArray(version.files)
            ? version.files as Record<string, unknown>[]
            : [];
          if (!files.some((file) => file.name === filename)) continue;
          exact.push(this.#candidate(model, version));
        }
      }
      if (exact.length === 1) {
        // Pinned to the file asked for, as a hash lookup is (§4.1): the
        // version may ship it beside a differently named primary.
        const found = exact[0]!.result!;
        const file = found.files.find((entry) => entry.name === filename);
        return file?.sha256 ? pinToHash(found, file.sha256) : found;
      }
      if (exact.length > 1) throw new LookupError(ambiguous(filename, exact));
      near.push(...items.map((model) => this.#newest(model)));
    }

    if (source !== "civitai") {
      // The archive indexes by filename directly, and answers for files
      // Civitai has deleted — and for Hugging Face's, which is the only way
      // to find one of those by name rather than by repo.
      const files = await this.filesOnArchive(filename);
      const wanted = filename.toLowerCase();
      const hashes = [
        ...new Set(
          files
            .filter((file) => file.name.toLowerCase() === wanted)
            .filter((file) =>
              source !== "huggingface" || file.platform === "huggingface"
            )
            .map((file) => file.sha256),
        ),
      ];
      if (source !== "tensorart" && hashes.length === 1) {
        return await this.byHash(hashes[0]!, source);
      }
      if (source !== "tensorart" && hashes.length > 1) {
        const rows = hashes.map((hash) => {
          const file = files.find((entry) => entry.sha256 === hash)!;
          return `  ${file.name} [${
            file.baseModel ?? "unknown"
          }, ${file.platform}]` +
            `${file.deleted ? " (deleted)" : ""}\n    --sha256checksum ${hash}`;
        });
        throw new LookupError(
          `the archive has ${hashes.length} different files named "${filename}". ` +
            `They are not the same model; pick one:\n${rows.join("\n")}`,
        );
      }
      // Tensor.Art's rows name a model page rather than a hash, so they are
      // a road of their own (§4.6).
      if (asks(source, "tensorart")) {
        const found = await this.#byTensorArtFilename(filename);
        if (found !== null) return found;
      }
    }

    // Civitai stores its own mangled filenames — `krea2_turbo_bf16.safetensors`
    // on your disk is `krea2TurboFP8_krea2TURBO.safetensors` there — so a near
    // miss is the normal case rather than a failure, and the useful answer is
    // the list.
    if (near.length > 0) {
      throw new LookupError(
        `no model on Civitai has a file named exactly "${filename}", and the ` +
          `archive has none either, but ${near.length} look close. Pick one ` +
          `and pass its --url:\n${near.map(describeCandidate).join("\n")}`,
      );
    }
    throw new LookupError(
      source === "tensorart"
        ? `the archive indexes no Tensor.Art file named "${filename}". ` +
          `Tensor.Art itself cannot be asked; pass --url with the model's ` +
          `tensor.art link, or --search to find it.`
        : source === "huggingface"
        ? `the archive indexes no Hugging Face file named "${filename}". ` +
          `Hugging Face itself cannot be searched by filename; pass --url ` +
          `with the repo, or --search to find it.`
        : `nothing on Civitai or the archive matches "${filename}". Try ` +
          `--url with a link, or --sha256checksum if you know the hash.`,
    );
  }

  /**
   * A name search, as its own operation (§4.1, amended): `forge models
   * --search` lists what is out there, and `--filename` uses it to say what
   * it nearly matched instead of dead-ending.
   */
  async search(query: string): Promise<Candidate[]> {
    return (await this.#searchItems(query)).map((model) => this.#newest(model));
  }

  async #searchItems(query: string): Promise<Record<string, unknown>[]> {
    const body = await this.#json(
      this.#civitaiUrl(this.#civitai, "/api/v1/models", "models", {
        query,
        limit: "20",
      }),
    );
    return Array.isArray((body as { items?: unknown[] })?.items)
      ? (body as { items: Record<string, unknown>[] }).items
      : [];
  }

  /**
   * A listing row shows the newest version only: a model with forty of them
   * would otherwise bury every other result.
   */
  #newest(model: Record<string, unknown>): Candidate {
    const versions = Array.isArray(model.modelVersions)
      ? model.modelVersions as Record<string, unknown>[]
      : [];
    return this.#candidate(model, versions[0] ?? null);
  }

  #candidate(
    model: Record<string, unknown>,
    version: Record<string, unknown> | null,
  ): Candidate {
    const result = sourceRecordFromCivitai({
      model,
      version,
      baseUrl: this.#civitai,
      fetchedAt: this.#now(),
    });
    return {
      result,
      name: result.display_name ?? "(unnamed)",
      url: result.record.source.url,
      kind: result.kind,
      baseModel: result.record.version.base_model,
      files: result.files.map((file) => ({ name: file.name })),
    };
  }

  /**
   * The archive's own filename search (§4.1). Its `kind: "file"` rows carry
   * `url: "/sha256/<hash>"`, which is the identifier everything else here
   * runs on — and it indexes files Civitai has deleted, which is the whole
   * reason the fallback exists.
   */
  async filesOnArchive(filename: string): Promise<ArchiveFile[]> {
    const out: ArchiveFile[] = [];
    for (const row of await this.#archiveRows(filename)) {
      if (row.kind !== "file") continue;
      const name = typeof row.name === "string" ? row.name : null;
      const url = typeof row.url === "string" ? row.url : "";
      const hash = normalizeHash(url.replace(/^.*\/sha256\//, ""));
      if (name === null || hash === null) continue;
      out.push({
        name,
        sha256: hash,
        platform: typeof row.platform === "string" ? row.platform : "unknown",
        baseModel: typeof row.base_model === "string" ? row.base_model : null,
        deleted: row.is_deleted === true || row.deleted_at != null,
      });
    }
    return out;
  }

  // ------------------------------------------------------------- archive

  /** One search per query per run: several roads read the same rows. */
  #rows = new Map<string, Promise<Record<string, unknown>[]>>();

  #archiveRows(query: string): Promise<Record<string, unknown>[]> {
    let rows = this.#rows.get(query);
    if (rows === undefined) {
      rows = this.#json(
        `${this.#archive}/api/search?q=${encodeURIComponent(query)}`,
      ).then((body) =>
        Array.isArray((body as { results?: unknown[] })?.results)
          ? (body as { results: Record<string, unknown>[] }).results
          : []
      );
      this.#rows.set(query, rows);
    }
    return rows;
  }

  /** A page, as text; a 404 is null, as `#json`'s is. */
  async #html(url: string): Promise<string | null> {
    const response = await this.#request(url, "text/html");
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      await response.body?.cancel();
      throw new LookupError(
        `GET ${url} answered ${response.status}${
          retry ? ` (retry after ${retry})` : ""
        }`,
        statusKind(response.status),
      );
    }
    return await response.text();
  }

  /** Every copy of a file the archive has seen: Civitai's and mirrors'. */
  async #archiveFiles(hash: string): Promise<Record<string, unknown>[]> {
    const found = await this.#json(
      `${this.#archive}/api/sha256/${hash}`,
    ) as { files?: Record<string, unknown>[] } | null;
    return found?.files ?? [];
  }

  /** The Civitai model behind those copies, if there is one. */
  async #archiveModel(
    files: Record<string, unknown>[],
  ): Promise<LookupResult | null> {
    if (files.length === 0) return null;
    // Civitai's copies only. A Tensor.Art copy has a `model_id` too — a
    // Tensor.Art id, which `/api/models/<id>` would read as Civitai's.
    const file = files.find((entry) =>
      (entry.source === undefined || entry.source === "civitai") &&
      entry.model_id != null
    );
    if (file === undefined) return null;
    // `Number(null)` is 0, not NaN, so a missing id has to be checked for
    // rather than inferred from the conversion.
    const modelId = file.model_id == null ? NaN : Number(file.model_id);
    const versionId = file.model_version_id == null
      ? NaN
      : Number(file.model_version_id);
    // Mirrors only: Hugging Face and ModelScope copies are recorded by hash
    // with no model record behind them. The caller decides what that means.
    if (!Number.isFinite(modelId)) return null;
    return await this.#archiveByModelId(
      modelId,
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
  /**
   * Images posted under a version — its gallery — newest first; with
   * `username`, only that account's, which for the model's creator is the
   * version's own showcase with the ids and pages the version object leaves
   * out.
   */
  async imagesFor(
    versionId: number,
    limit: number,
    username?: string,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.#json(
      this.#civitaiUrl(this.#civitai, "/api/v1/images", "images", {
        modelVersionId: String(versionId),
        limit: String(Math.min(Math.max(limit, 1), 200)),
        sort: "Newest",
        withMeta: "true",
        ...(username ? { username } : {}),
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

  #civitaiUrl(
    base: string,
    path: string,
    endpoint: CivitaiEndpoint,
    extra: Record<string, string> = {},
  ): string {
    const url = new URL(path, `${base}/`);
    for (
      const [key, value] of Object.entries({
        ...visibilityParams(endpoint),
        ...extra,
      })
    ) {
      url.searchParams.set(key, value);
    }
    const built = url.toString();
    this.#forCivitai.add(built);
    return built;
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
      const retry = response.headers.get("retry-after");
      throw new LookupError(
        `GET ${url} answered ${response.status}${
          detail.length > 0 ? `: ${detail}` : ""
        }${retry ? ` (retry after ${retry})` : ""}`,
        statusKind(response.status),
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

  async #request(url: string, accept = "application/json"): Promise<Response> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const headers: Record<string, string> = { accept };
    // A header rather than `?token=`: a query parameter would land in every
    // error message that prints the URL, and several here do.
    if (this.#token !== null && this.#forCivitai.has(url)) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    try {
      return await this.#fetch(url, { signal, headers });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new LookupError(`GET ${url} timed out`, "unreachable");
      }
      throw new LookupError(
        `GET ${url} failed: ${cause instanceof Error ? cause.message : cause}`,
        "unreachable",
      );
    }
  }
}

/** A Civitai link names a Civitai model; Hugging Face cannot answer for it. */
function civitaiOnly(source: LookupSource): void {
  if (source === "huggingface" || source === "tensorart") {
    const site = source === "huggingface" ? "Hugging Face" : "Tensor.Art";
    throw new LookupError(
      `that names a Civitai model, which ${site} cannot look up; drop ` +
        `--import-source, or pass a ${
          source === "huggingface" ? "huggingface.co" : "tensor.art"
        } link`,
    );
  }
}

/** The archive's Tensor.Art copies of a file, as model references. */
export function tensorArtCopies(
  files: Record<string, unknown>[],
): TensorArtRef[] {
  const out: TensorArtRef[] = [];
  for (const file of files) {
    if (file.source !== "tensorart") continue;
    // Strings, always: these ids are past what a number holds (§4.6).
    const model = typeof file.model_id === "string" ? file.model_id : null;
    if (model === null || !/^\d+$/.test(model)) continue;
    const version = typeof file.model_version_id === "string" &&
        /^\d+$/.test(file.model_version_id)
      ? file.model_version_id
      : null;
    out.push({ model_id: model, version_id: version });
  }
  return out;
}

/** The archive's Hugging Face copies of a file, as repo references. */
export function huggingFaceCopies(
  files: Record<string, unknown>[],
): HuggingFaceRef[] {
  const out: HuggingFaceRef[] = [];
  for (const file of files) {
    if (file.source !== "huggingface" || typeof file.url !== "string") continue;
    try {
      const ref = parseHuggingFaceUrl(file.url);
      if (ref !== null && ref.path !== null) out.push(ref);
    } catch {
      // A dataset or a space: not a model card to read.
    }
  }
  return out;
}

/**
 * The archive knows the bytes, but no model page stands behind them. Saying
 * "nothing knows this hash" when the archive plainly does would send someone
 * hunting for a bug, so this says what it does know and what would help.
 */
function mirrorOnly(
  files: Record<string, unknown>[],
  huggingFace: number,
  source: LookupSource,
): LookupError {
  const where = [
    ...new Set(
      files
        .map((entry) => typeof entry.source === "string" ? entry.source : null)
        .filter((entry): entry is string => entry !== null),
    ),
  ];
  const hint = source === "tensorart"
    ? " None of the copies are on Tensor.Art."
    : huggingFace > 0 && source === "archive"
    ? ` ${huggingFace} of the copies are on Hugging Face: --import-source ` +
      `huggingface reads the model card from one of them.`
    : source === "huggingface"
    ? " None of the copies are on Hugging Face."
    : " Mirrors are indexed by hash; only models carry metadata.";
  return new NotFoundError(
    `the archive has a file with that hash${
      where.length > 0 ? ` on ${where.join(", ")}` : ""
    }, but no model page for it — so there is no description, no tags and ` +
      `no samples to import.${hint}`,
  );
}

/** The model and version a Tensor.Art search row's archive URL names. */
function tensorArtRow(row: Record<string, unknown>): TensorArtRef | null {
  const match = String(row.url ?? "").match(
    /^\/tensorart\/models\/(\d+)(?:\/versions\/(\d+))?/,
  );
  return match ? { model_id: match[1]!, version_id: match[2] ?? null } : null;
}
