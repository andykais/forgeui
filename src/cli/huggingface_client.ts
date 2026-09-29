/**
 * Hugging Face, for `forge models` (DESIGN-MODEL-IMPORT §4.5).
 *
 * Built on `@huggingface/hub`, Hugging Face's own JavaScript client — the
 * `hf` CLI most people know is Python, and cannot be a dependency of this.
 * Everything it maps lives in `src/models/huggingface.ts`; what is here is
 * the asking.
 *
 * What Hugging Face cannot do is answer "which repo has the file with this
 * hash". The archive can: it indexes Hugging Face copies by hash, so a hash
 * reaches this through the archive's list of copies (`byCopies`), and a URL
 * reaches it directly (`byRef`).
 *
 * Nothing here opens `app.db` or imports anything that does.
 */

import * as hub from "@huggingface/hub";
import type { LookupResult } from "../models/civitai.ts";
import {
  type HuggingFaceModel,
  type HuggingFaceRef,
  sourceRecordFromHuggingFace,
  WEIGHT_FILE,
} from "../models/huggingface.ts";
import {
  type Candidate,
  LookupError,
  NotFoundError,
} from "./civitai_client.ts";

export interface HuggingFaceClientOptions {
  hubUrl: string;
  /** Sent to the Hub and nothing else; gated and private repos need one. */
  token?: string | null;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Progress, and the choice made when a hash has many copies. */
  say?: (line: string) => void;
}

/** A model card is text; one this size is not a card. */
const README_LIMIT = 512 * 1024;

/** How many copies' popularity is asked about at once. */
const CONCURRENCY = 8;

/** Past this many copies, the rest are unlikely to include the original. */
const MOST_COPIES = 60;

export class HuggingFaceClient {
  #hubUrl: string;
  #token: string | undefined;
  #fetch: typeof globalThis.fetch;
  #now: () => Date;
  #say: (line: string) => void;

  constructor(options: HuggingFaceClientOptions) {
    this.#hubUrl = options.hubUrl.replace(/\/+$/, "");
    this.#token = options.token ?? undefined;
    const base = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs;
    // The library takes a `fetch`, which is where the timeout goes: it has
    // none of its own, and a Hub that stops answering must not hang the CLI.
    this.#fetch = (input, init) =>
      base(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    this.#now = options.now ?? (() => new Date());
    this.#say = options.say ?? (() => {});
  }

  get hubUrl(): string {
    return this.#hubUrl;
  }

  /** A repo, or a file in one — what a `huggingface.co` link names. */
  async byRef(ref: HuggingFaceRef): Promise<LookupResult> {
    const info = await this.#call(
      `the repo ${ref.repo}`,
      () =>
        hub.modelInfo({
          name: ref.repo,
          ...(ref.revision === null ? {} : { revision: ref.revision }),
          additionalFields: [
            "author",
            "cardData",
            "library_name",
            "sha",
            "filePaths",
            "tags",
          ],
          ...this.#common(),
        }),
    ) as unknown as HuggingFaceModel & { filePaths?: string[] };
    const revision = ref.revision ?? info.sha ?? "main";
    const names = info.filePaths ?? [];
    const path = ref.path ?? this.#onlyWeightFile(ref.repo, revision, names);

    const [entry] = await this.#call(
      `${path} in ${ref.repo}`,
      () =>
        hub.pathsInfo({
          repo: { type: "model", name: ref.repo },
          paths: [path],
          revision,
          ...this.#common(),
        }),
    );
    if (entry === undefined || entry.type !== "file") {
      throw new NotFoundError(
        `${ref.repo} has no file ${path} at ${revision}`,
      );
    }
    if (!entry.lfs) {
      // Only LFS files carry a sha256 in the Hub's answer, and a batch is
      // named by one. Weights are always LFS; a small text file is not.
      throw new NotFoundError(
        `${path} in ${ref.repo} is not stored in LFS, so the Hub gives no ` +
          `sha256 for it`,
      );
    }

    const readme = names.includes("README.md")
      ? await this.#readme(ref.repo, revision)
      : null;

    return sourceRecordFromHuggingFace({
      info,
      readme,
      file: { path, sha256: entry.lfs.oid.toLowerCase(), size: entry.size },
      revision,
      baseUrl: this.#hubUrl,
      fetchedAt: this.#now(),
    });
  }

  /**
   * A hash, through the copies the archive has seen of it (§4.5). Most are
   * re-uploads: one file here had forty-eight, one of them the original. The
   * original is the one people like, so the copies are ranked by likes and
   * then downloads, and the choice is said out loud with the way to override
   * it.
   */
  async byCopies(
    hash: string,
    copies: HuggingFaceRef[],
  ): Promise<LookupResult> {
    const byRepo = new Map<string, HuggingFaceRef>();
    for (const copy of copies) {
      // One path per repo: a repo holding the file twice is still one card.
      if (!byRepo.has(copy.repo)) byRepo.set(copy.repo, copy);
    }
    const distinct = [...byRepo.values()].slice(0, MOST_COPIES);

    const ranked = distinct.length === 1
      ? distinct.map((ref) => ({ ref, likes: 0, downloads: 0 }))
      : await this.#rank(distinct);
    if (ranked.length === 0) {
      throw new LookupError(
        `the archive knows ${distinct.length} Hugging Face copies of this ` +
          `file, and none of them answered: deleted, private, or gated`,
      );
    }

    // A repo can have changed since the archive saw it; the next is tried.
    for (const [at, candidate] of ranked.slice(0, 3).entries()) {
      let found: LookupResult;
      try {
        found = await this.byRef(candidate.ref);
      } catch (cause) {
        if (cause instanceof LookupError) continue;
        throw cause;
      }
      if (found.sha256 !== hash) continue;
      if (ranked.length > 1) {
        this.#say(
          `${ranked.length} Hugging Face repos hold this file; using ` +
            `${candidate.ref.repo} (${candidate.likes} likes${
              at > 0 ? `, after ${at} that no longer match` : ""
            }). Pass --url to use another.`,
        );
      }
      return found;
    }
    throw new NotFoundError(
      `none of the Hugging Face copies the archive lists still holds a file ` +
        `with this hash`,
    );
  }

  /** `forge models --search … --import-source huggingface`. */
  async search(query: string): Promise<Candidate[]> {
    const out: Candidate[] = [];
    await this.#call(`a search for "${query}"`, async () => {
      for await (
        const model of hub.listModels({
          search: { query },
          limit: 20,
          ...this.#common(),
        })
      ) {
        out.push({
          name: model.name,
          url: `${this.#hubUrl}/${model.name}`,
          kind: model.task ?? "model",
          baseModel: null,
          files: [],
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------ plumbing

  /**
   * The weight file a repo link means, when it means exactly one: the only
   * one at the root, or the only one anywhere. A diffusers repo holds a dozen
   * (`unet/`, `text_encoder/`, …) and a single-file repo often two precisions,
   * and picking would be a guess — so the answer is the list, as links.
   */
  #onlyWeightFile(repo: string, revision: string, names: string[]): string {
    const weights = names.filter((name) => WEIGHT_FILE.test(name));
    const root = weights.filter((name) => !name.includes("/"));
    if (root.length === 1) return root[0]!;
    if (root.length === 0 && weights.length === 1) return weights[0]!;
    if (weights.length === 0) {
      throw new LookupError(`${repo} holds no model weights`);
    }
    const shown = [...root, ...weights.filter((name) => name.includes("/"))];
    throw new LookupError(
      `${repo} holds ${weights.length} weight files; pass --url with the one ` +
        `you mean:\n${
          shown.slice(0, 20).map((name) =>
            `  ${this.#hubUrl}/${repo}/blob/${revision}/${name}`
          ).join("\n")
        }${shown.length > 20 ? `\n  … and ${shown.length - 20} more` : ""}`,
    );
  }

  async #rank(refs: HuggingFaceRef[]) {
    const ranked: { ref: HuggingFaceRef; likes: number; downloads: number }[] =
      [];
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const ref = refs[next++]!;
        try {
          const info = await hub.modelInfo({
            name: ref.repo,
            ...this.#common(),
          });
          ranked.push({ ref, likes: info.likes, downloads: info.downloads });
        } catch {
          // Deleted, private or gated: not a candidate, and not an error —
          // most of these are strangers' re-uploads.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker),
    );
    return ranked.sort((a, b) =>
      b.likes - a.likes || b.downloads - a.downloads ||
      Number(a.ref.path?.includes("/") ?? false) -
        Number(b.ref.path?.includes("/") ?? false)
    );
  }

  /**
   * The model card, as a plain GET of its `resolve` URL. The library's
   * `downloadFile` goes through Xet reconstruction, which is a lot of
   * machinery for six kilobytes of Markdown and a lot for the tests to fake.
   */
  async #readme(repo: string, revision: string): Promise<string | null> {
    const url = `${this.#hubUrl}/${repo}/resolve/${
      encodeURIComponent(revision)
    }/README.md`;
    try {
      const response = await this.#fetch(url, {
        // To the Hub only; a redirect elsewhere drops it, as fetch does.
        headers: this.#token === undefined
          ? {}
          : { authorization: `Bearer ${this.#token}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > README_LIMIT) {
        await response.body?.cancel();
        return null;
      }
      const text = await response.text();
      return text.length > README_LIMIT ? null : text;
    } catch {
      // A missing card is a model without a description, not a failed lookup.
      return null;
    }
  }

  #common() {
    return {
      hubUrl: this.#hubUrl,
      fetch: this.#fetch,
      ...(this.#token === undefined ? {} : { accessToken: this.#token }),
    };
  }

  /** The library's errors, as this command's: a status said in words. */
  async #call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      const status = (cause as { statusCode?: number }).statusCode;
      if (status === 404) {
        throw new NotFoundError(`Hugging Face has no ${what}`);
      }
      if (status === 401 || status === 403) {
        throw new LookupError(
          `Hugging Face refused ${what} (${status}): it is gated or private. ` +
            `Put a token from huggingface.co/settings/tokens in config.yaml ` +
            `as import.huggingface_token, or set HF_TOKEN — and for a gated ` +
            `repo, accept its terms on its page first.${
              this.#token === undefined ? "" : " A token was sent."
            }`,
        );
      }
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new LookupError(
          `Hugging Face did not answer about ${what} in time`,
        );
      }
      throw new LookupError(
        `asking Hugging Face about ${what} failed: ${
          cause instanceof Error ? cause.message : cause
        }`,
      );
    }
  }
}
