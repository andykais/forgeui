# Design — `forgecli models`: model metadata and samples from Civitai

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3, §3.1, §6.2, §7, §8.1, §8.3, §11.2, §12, §13.
**Premise being extended:** §8.3 ("Import paths … paste a Civitai image/model
URL") and §11.2's gallery, which today can only show media this app made.

---

## The problem

A model arrives on disk as a file and nothing else. ForgeUI reads its header
for a family and hashes it for an identity, and that is the end of what a
`.safetensors` will tell you: no trigger words, no author's notes, no sense of
what it looks like when it works. The model page has the space for all of it —
§8.1 specifies family, tags, notes, a Civitai link and a Samples strip — and
Phase 2 shipped the page with the space empty, because the only way to fill it
was a "Fetch info" button the app does not have.

The obvious fix is to put a Civitai client in the server. This proposal does
not, for three reasons:

1. **The app must not download things.** §4.6 and AGENTS.md both say so, and
   they are right: a running app that reaches out to a third party on a
   timer is a running app whose behaviour depends on what a remote host served
   that day. The rule exists and should survive this feature.
2. **Fetching is bursty and interactive**; serving is neither. Pulling eight
   images and a 6 GB checkpoint wants a terminal you can watch, interrupt and
   re-run — not a request that either blocks a route for ten minutes or
   disappears into a background job whose only UI is a spinner.
3. **Civitai already ships a CLI**, and it handles the parts that are
   genuinely annoying: device login, token storage, hash lookup across five
   hash flavours, resumable authenticated downloads, SHA256 verification.
   Wrapping it is a day of work. Reimplementing it is a quarter of
   maintenance.

So the fetching lives in a second binary, and the two halves meet on the
filesystem.

---

## 1. What this does

**`forgecli models`** is a standalone Deno CLI that resolves a model on
Civitai — by URL, by filename or by sha256 — and writes what it finds into an
**import folder** inside the data directory. It writes files and nothing else.
It never opens `app.db`, never talks to the server, and does not care whether
the app is running.

**The app slurps that folder** on boot and at the end of every model rescan,
applies each batch to the model it names, and deletes the batch. An imported
sample lands in `samples/<model_hash>/` exactly as a dropped file does, with
two additions: it remembers **where it came from**, as a link, and it carries
whatever generation data could be parsed out of it.

That "where it came from" is the second half of the proposal and the reason to
do it now rather than bolt it on later: **provenance is a first-class field on
imported media**, in the sidecar and therefore in the index, on samples *and*
on gallery outputs. The next importers — SwarmUI's and ComfyUI's output
folders — are the same shape with a different fetcher, and they need the
gallery to be able to say "this one came from somewhere else, here is where"
before they can exist at all.

### 1.1 What it is not

- Not a model manager. It does not delete, move, organise or rename anything.
- Not a sync. There is no watcher, no polling, no "check for updates". You run
  it when you want something fetched.
- Not a parameter importer. Generation data from a sample is stored and shown,
  never mapped onto a workflow's params — §8.3's rule holds, for the reason
  §8.3 gives.

---

## 2. The workflow, alongside the app

The everyday case, with the app running the whole time:

```
1.  You put `cyberrealistic_v90.safetensors` in your checkpoints folder.

2.  The app scans it within the minute and hashes it in the background. The
    Models page shows it: filename, size, family from the header, nothing else.

3.  In a terminal:

      $ forgecli models --filename cyberrealistic_v90.safetensors --download-samples=8

    The CLI finds the file in a configured model folder, hashes it, asks
    Civitai what that hash is, downloads eight images off the model's page,
    parses each one's generation data, and writes

      ~/.forgeui/import/9f3c…b1/

    It prints what it wrote and exits. Total elapsed: a few seconds plus the
    images.

4.  You hit **Rescan** on the Models page. (Or restart the app. Or wait for
    the next boot — the batch keeps.)

5.  The model page now has its family, its tags, its trigger words in the
    notes, a Civitai link in the header, and eight samples in the strip. Each
    sample carries a `CIVITAI ↗` badge linking back to the image it came from,
    and shows its prompt, seed, sampler and steps read-only beside it.

6.  `~/.forgeui/import/9f3c…b1/` is gone.
```

Three properties of that sequence are load-bearing:

- **Step 3 does not need step 4 to have happened**, or the app to exist. You
  can run the CLI against a data directory whose app has never been started,
  fetch metadata for forty models, and have all of it appear the first time
  you launch.
- **Step 3 cannot corrupt step 5.** The CLI writes into
  `import/.staging/<id>/` and renames the finished directory into place, so
  the app either sees a complete batch or sees nothing. There is no lock, no
  handshake and no partially-read JSON.
- **Step 4 is idempotent.** Running the CLI twice writes the batch twice;
  ingesting it twice imports the samples once, because a sample is unique on
  `(model_hash, source_url)` (§7.3).

The less everyday cases:

- **The model is not on this machine yet.** `--download-model` fetches the
  weights into the configured folder for its kind. This is the one thing in
  the whole repository allowed to write inside a model folder, and it is
  allowed because you typed a flag whose entire meaning is "write inside a
  model folder". The app's rule is unchanged: *the app* never does.
- **The model has not been hashed yet.** The batch names a sha256 the
  database has no row for. It stays in the folder, untouched, and is retried
  after the next hashing pass finishes. No error, no noise; it lands when the
  hash lands.
- **The CLI runs on another machine.** `import.dir` can point anywhere, so a
  shared folder makes the fetching host and the serving host different
  machines. Nothing in the format assumes otherwise.

---

## 3. Usage

The `--help` output, which is the specification of the interface:

```
forgecli models — fetch model metadata and samples from Civitai into
ForgeUI's import folder, for the app to ingest on its next rescan.

Usage:  forgecli models [options]

Exactly one of --url, --filename or --sha256checksum says which model.

Options:

  -h, --help                  Show this help.
  -V, --version               Show the version.
  -d, --data-dir     <path>   ForgeUI data directory, whose config.yaml names the
                              model folders and the import folder.
                              (Default: $FORGEUI_DATA_DIR, else ~/.forgeui)

      --url          <url>    Civitai or civitaiarchive.com link to a model, a model
                              version or an image. Accepts every form in §4.1.
      --filename     <name>   Filename of the model as it sits in a configured model
                              folder; it is hashed there and looked up by hash.
      --sha256checksum <hex>  SHA256 of the model file — the identity ForgeUI uses.

      --download-samples <n>  Download up to <n> images from the model's page as
                              samples, newest first. (Default: 0)
      --download-model        Download the model weights into the configured folder
                              for its kind. Requires a Civitai login (see AUTH).
      --overwrite             Rewrite files already on disk. Without it every file
                              that exists is left exactly as it is.

      --dry-run               Print what would be fetched and written; touch nothing.
      --json                  Print the resulting model.json to stdout instead of a
                              human summary.
      --anon                  Never send credentials, even if a token is configured.
      --no-archive            Fail rather than fall back to civitaiarchive.com.
      --timeout      <ms>     Per-request timeout. (Default: 30000)

Examples:

  forgecli models --filename cyberrealistic_v90.safetensors --download-samples=8
  forgecli models --url https://civitai.com/models/4384?modelVersionId=128713
  forgecli models --sha256checksum 6ce0161689b3853acaa037… --download-samples=4 --overwrite
  forgecli models --url https://civitaiarchive.com/sha256/6ce0161689b3… --download-model

AUTH

  Lookups and sample images work anonymously. --download-model needs a Civitai
  account:

      civitai login                 browser device login (recommended)
      civitai login --token <key>   a personal key from civitai.com/user/account

  or set CIVITAI_TOKEN in the environment. ForgeUI stores no credential of its
  own and writes none into config.yaml, the import folder or any sidecar.

EXIT CODES

  0  wrote a batch (or, with --dry-run, would have)
  1  the model was not found on Civitai or in the archive
  2  bad arguments, or none of --url/--filename/--sha256checksum
  3  a download failed, or --download-model without a login
  4  the import folder is not writable
```

Built with [cliffy](https://github.com/c4spar/cliffy)
(`jsr:@cliffy/command@^1.3.1`), which is where the subcommand shape, the
`--help` rendering, the `<n>` type checking and the "exactly one of" conflict
rule come from rather than being hand-rolled as `src/config/cli.ts` does for
the server. `models` is a subcommand because the next ones —
`forgecli import swarmui <dir>`, `forgecli import comfyui <dir>` — are
siblings of it, not variations on it.

### 3.1 Why a second binary and not `forgeui models`

The server's entrypoint carries the whole app: SQLite through FFI, the ComfyUI
manager, the HTTP stack. `forgecli` needs none of it and must not have it — a
tool that can be pointed at a data directory belonging to a *running* app has
no business being able to open that app's database. Keeping them apart is what
makes "the CLI cannot corrupt anything" a structural claim rather than a
promise. They share code the ordinary way: `src/media/infotext.ts`,
`src/jobs/sidecar.ts` and `src/config/` are imported by both.

```
deno task cli models --filename …              # from the repo
deno install -A -n forgecli jsr:… / src/cli/main.ts   # or install it
```

---

## 4. Lookup

### 4.1 Resolving the identifier

One of three flags, each reduced to the same thing: a **model version**, which
is what actually has files, images and a `baseModel`.

**`--sha256checksum <hex>`** — the direct road, and the one the other two end
up on.

1. `civitai model-versions by-hash <hash> --json`
2. Fallback: `GET https://civitaiarchive.com/api/sha256/<hash>`, which answers
   with every file it has seen under that hash and their `model_id` /
   `model_version_id`, then
   `GET https://civitaiarchive.com/api/models/<id>?modelVersionId=<v>`.

The archive is the fallback specifically because it answers for **models
Civitai has deleted** — `deletedAt` is a field it returns rather than a 404 it
throws — which is a large fraction of the models people actually have on disk
and cannot identify.

**`--filename <name>`** — the everyday flag, because the filename is what you
know. It is resolved **locally**: the configured model folders are walked for
a file with that name (basename match, one folder deep past the root, as §3's
scan does), that file is hashed, and the run continues as
`--sha256checksum`. An exact hash beats every name-based search, and the
answer is about *your* file rather than a file with the same name.

If nothing matches on disk, fall back to a name search —
`civitai models search --query <stem> --json`, then
`GET https://civitaiarchive.com/api/search?q=<stem>` — and accept a result
only when one of its version files carries exactly that filename. Two or more
matches is an error listing the candidates with their URLs, not a guess.

**`--url <url>`** — parsed, never fetched as a page:

| form | reduces to |
|---|---|
| `civitai.com/models/<id>?modelVersionId=<v>` | that version |
| `civitai.com/models/<id>` | the model's latest version |
| `civitai.com/images/<id>` | the version that image was posted under |
| `civitaiarchive.com/models/<id>?modelVersionId=<v>` | that version, archive-first |
| `civitaiarchive.com/sha256/<hash>` | `--sha256checksum <hash>` |
| `civitai.com/api/download/models/<v>` | that version |

Anything else is exit 2 with the list above.

### 4.2 What a lookup yields

Whichever road, the result is normalised into one shape (§5.2) holding: the
version's `baseModel`, name and description, the model's name, type, tags and
creator, the file's name and sha256, the canonical URL, and the images posted
with the version.

The family is mapped from `baseModel` onto the hardcoded `FAMILIES` list of
§8.1 — `SD 1.5` → `sd15`, `SDXL 1.0`/`Pony`/`Illustrious`/`NoobAI` → `sdxl`,
`Flux.1 D`/`Flux.1 S` → `flux`, `Wan Video *` → `wan2`, and so on. The table
lives in `src/models/civitai.ts` beside the parser. A `baseModel` with no
mapping leaves the family alone rather than inventing one: the header probe's
answer is better than a wrong guess, and `unset` is better than either.

Civitai's model `type` maps onto a ForgeUI **kind** (`Checkpoint` →
`checkpoints`, `LORA`/`LoCon` → `loras`, `TextualInversion` → `embeddings`,
`VAE` → `vae`, `Controlnet` → `controlnet`, `Upscaler` → `upscale_models`),
which is what `--download-model` needs in order to know which configured
folder to write into. Without a mapping, or with no folder configured for the
mapped kind, `--download-model` is exit 3 naming the kind — it does not pick a
folder on your behalf.

### 4.3 Samples

`--download-samples=<n>` takes the version's images, newest first, and for
each one:

1. **The bytes** come from the CDN URL with a plain `fetch` — they are public
   and the Civitai CLI has no image-download command. The URL's
   `width=450,optimized=true` segment is rewritten to `original=true` so the
   sample is the full-size image rather than a card thumbnail.
2. **The generation data** comes from `civitai images search
   --model-version-id <v> --json`, whose `meta` is the A1111-style record
   (`prompt`, `negativePrompt`, `steps`, `sampler`, `cfgScale`, `seed`,
   `Size`, `Model`, `hashes`, `resources`, sometimes a `comfy` workflow).
   Where the API has no meta, the file itself is parsed (§6).
3. Images above `import.nsfw_level` are skipped and counted in the summary.

The archive fallback carries image URLs, dimensions and a `has_metadata` flag
but **not the metadata itself** — there is no image endpoint on it. A sample
imported through the archive therefore arrives with its source link, its
dimensions and whatever the file itself carries, and that is honest: the
fields it cannot fill are absent rather than empty.

`--download-samples` with no value is `import.samples` from `config.yaml`;
absent entirely it is 0. Samples are *always* accompanied by the metadata
batch — there is no way to fetch images without fetching what they are of.

---

## 5. Folders and formats

### 5.1 The import folder

```
<appdata>/import/                     ← new; `import.dir` may move it
  <sha256>/                           one batch, named by the model it is about
    model.json                        the manifest (§5.2)
    samples/
      0001.jpeg
      0002.png
      …
  .staging/<ulid>/                    a batch being written; renamed into place
  .failed/<sha256>/                   a batch ingest refused, plus error.txt
```

Chosen this way because:

- **Named by sha256** — the model's identity in this app (§8.1). Ingest is a
  primary-key lookup, two batches for one model collide loudly rather than
  quietly doubling up, and nothing has to be parsed to know what a directory
  is about.
- **One JSON per model, images beside it.** You can read it. You can hand-write
  it — which is the supported way to import a model the CLI cannot find, and
  is how the integration tests build fixtures.
- **`.staging` and `.failed` are dot-prefixed** so the ingest walk skips them
  by the same rule that skips everything else it does not understand.
- **The batch is deleted on success**, per the requirement, and the deletion is
  the last step after the database transaction commits. A crash between the
  two leaves a batch that re-ingests to the same state — which is exactly why
  sample import is keyed on the source URL.

`.failed/` is the answer to "what if a batch is broken". A batch that throws
is moved there with the error beside it, so one bad JSON cannot wedge every
boot from now on. Nothing ever retries it; it is yours to look at or delete.

### 5.2 `model.json`

```json
{
  "format": 1,
  "forgecli_version": "0.1.0",
  "created_at": "2026-09-18T20:14:03Z",
  "overwrite": false,
  "model": {
    "sha256": "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
    "filename": "v15PrunedEmaonly.safetensors",
    "kind": "checkpoints",
    "display_name": "SD 1.5 base",
    "family": "sd15",
    "tags": ["base model"],
    "notes": "Trigger words: none.\n\nStable Diffusion is a latent text-to-image…",
    "strength_min": null,
    "strength_max": null
  },
  "source": {
    "kind": "civitai",
    "label": "Civitai",
    "url": "https://civitai.com/models/62437?modelVersionId=66991",
    "model_id": 62437,
    "model_version_id": 66991,
    "fetched_at": "2026-09-18T20:14:01Z",
    "via": "civitai-cli/1.4.2"
  },
  "civitai": { "…": "the lookup response, verbatim and uninterpreted" },
  "samples": [
    {
      "file": "samples/0001.jpeg",
      "kind": "image",
      "width": 768,
      "height": 768,
      "source": {
        "kind": "civitai",
        "label": "Civitai",
        "url": "https://civitai.com/images/26534668",
        "fetched_at": "2026-09-18T20:14:02Z"
      },
      "raw": {
        "format": "civitai-meta",
        "fields": {
          "prompt": "a photograph of an astronaut riding a horse",
          "negative_prompt": "blurry, watermark",
          "seed": 2870305590,
          "steps": 30,
          "cfg": 7,
          "sampler": "DPM++ 2M Karras",
          "width": 768,
          "height": 768,
          "model": "v1-5-pruned-emaonly",
          "model_hash": "6ce0161689"
        },
        "source": { "…": "the untouched blob the fields were read out of" }
      }
    }
  ]
}
```

`format` is there so a newer CLI writing into an older app's folder is
rejected with a sentence rather than misread. `overwrite` carries the CLI's
`--overwrite` flag forward to ingest (§7.2) — the flag means "replace what is
there" at both ends of the pipe, and it would be strange for it to mean it
only at one.

### 5.3 `raw`, and what the app does with it

§8.3 is explicit that imported generation data is **not mapped onto params in
v1**: it is stored as `raw` in the sample's sidecar, shown read-only, and
offers no Edit in Generate. This proposal keeps that and only pins down the
shape, which §8.3 left open:

```
raw = { format, fields, source }
  format  "civitai-meta" | "a1111-infotext" | "comfyui-workflow" | "unknown"
  fields  the normalised subset the UI renders, all optional
  source  the original blob, untouched, for the day mapping arrives
```

`fields` is a closed list — prompt, negative_prompt, seed, steps, cfg,
sampler, scheduler, denoise, width, height, model, model_hash, loras[] — and
anything outside it stays in `source` only. The sample's sidecar keeps
`params: {}` and `workflow: null`, so "reusable" stays false and §8.3's rule
holds by construction rather than by care.

### 5.4 Provenance, as a sidecar field

New optional block in the §6.2 sidecar, on outputs and samples alike:

```json
"source": {
  "kind": "civitai",
  "label": "Civitai",
  "url": "https://civitai.com/images/26534668",
  "imported_at": "2026-09-18T20:14:09Z"
}
```

Absent or `null` means **this app made it**, which is every sidecar written to
date and every one the job pipeline will ever write. `kind` is an open string
— `civitai`, `civitai-archive`, `swarmui`, `comfyui`, `file` — because the
whole point is that the next importer adds a value rather than a schema.
`label` is what the badge says, so the UI needs no table of kinds.

This is the field the gallery reads (§8.2). Putting it in the sidecar rather
than only in a column is not optional: AGENTS.md's rule is that anything the
database knows about an output must be rebuildable from the sidecar, and a
`reindex` that dropped "this came from SwarmUI" would be a `reindex` that
loses data.

---

## 6. Parsing what an image carries

`src/media/infotext.ts` — new, pure, unit-tested, no I/O — reads generation
data out of image bytes, and is shared by this CLI, the sample drop zone that
already exists, and the SwarmUI/ComfyUI importers that do not.

| carrier | where | yields |
|---|---|---|
| A1111 infotext | PNG `tEXt`/`iTXt` key `parameters` | `a1111-infotext` |
| A1111 infotext | JPEG/WebP EXIF `UserComment` | `a1111-infotext` |
| ComfyUI | PNG `tEXt` keys `prompt` and `workflow` | `comfyui-workflow` |
| ForgeUI | PNG `tEXt` key `forgeui` (§6.2 already writes it) | a full sidecar |
| SwarmUI | PNG `tEXt` key `parameters`, JSON-shaped | `a1111-infotext` |
| nothing | — | `unknown`, `fields: {}` |

The A1111 infotext grammar is the only fiddly part: a prompt, an optional
`Negative prompt:` line, and a final comma-separated `Key: value` line whose
values may themselves contain commas inside quotes. It is parsed
best-effort — an unparseable tail leaves `fields` partly filled and the whole
text in `source`, because a prompt you can read beats a parse error.

A ForgeUI sidecar found embedded in a dropped file is a special case worth
having: importing your own output back out of a screenshot folder should
restore the real thing, params and all.

---

## 7. The app side

### 7.1 Where ingest runs

A new `src/models/import.ts` — `ImportInbox` — owned by `ModelLibrary`:

- **at the end of every `rescan()`**, which covers boot (`startBackground`)
  and the Rescan button (`POST /api/maintenance/rescan-models`);
- **when the background hasher drains its queue**, so a batch dropped for a
  model that was still hashing lands as soon as its hash does, without a
  second Rescan;
- never on a timer, and never on an HTTP request of its own.

Progress is broadcast on the existing `rescan_progress` channel with two added
counters (`imports_found`, `imports_applied`), so the Models page's existing
progress line says what is happening without a new socket message type.

### 7.2 What ingest applies

For each `import/<sha256>/model.json`, in one transaction:

1. **Find the model.** No `models` row for that hash → leave the batch alone
   and move on. This is the normal case for a not-yet-hashed file, not an
   error.
2. **Metadata.** `civitai_json` is set from `source` + `civitai` — the column
   has existed since §7 and has never been written. `family`, `display_name`,
   `tags` and `notes` are filled **only where the model's own value is null or
   empty**, unless the batch says `overwrite: true`, in which case they are
   replaced. A hand-typed display name surviving an import is the default
   because losing one is the kind of thing you only notice a week later.
3. **Samples.** Each entry is imported through the existing `SampleStore`,
   which already takes `sourceUrl` and `raw` and has never been given either.
   The file is moved rather than copied where the filesystem allows it.
   A sample whose `(model_hash, source_url)` already exists is skipped, which
   is what makes re-running the CLI free.
4. **Thumbnail.** If the model has no `thumb_path` and no samples before this
   batch, the first imported sample becomes the thumbnail. A model that had
   one keeps it.
5. **Delete the batch**, after the transaction commits.

Anything thrown moves the batch to `.failed/` with the message, and ingest
continues with the next one.

### 7.3 External media in the gallery

`outputs` and `samples` both gain `source_json`, written from the sidecar's
`source` block and rebuilt by `reindex` from the same place.

- `OutputView` and `SampleView` carry `source: {kind, label, url} | null`.
- A tile whose `source` is set draws a small corner badge with the label; the
  viewer's metadata panel shows **Imported from Civitai ↗** as a link, beside
  the existing model links.
- `GET /api/outputs?source=` filters on it, with `source=local` for the ones
  this app made — the filter chip row of §11.2 gains one chip, and it is the
  chip that makes an imported SwarmUI library usable at all once those
  importers land.
- `SamplesStrip`'s origin caption (`promoted` / `dropped file`) gains a third
  value: the source label, linked.

Nothing writes `outputs.source_json` in this phase — no importer produces
gallery outputs yet. It is specified and migrated now because the sidecar
field, the column, the view field and the `reindex` path are one change, and
splitting them means the SwarmUI importer starts with a migration and a
`reindex` rewrite instead of a fetcher. The cost of carrying it is one
nullable column.

### 7.4 Samples and `reindex`

Worth stating plainly, since this proposal is the first thing to write sample
rows from outside a user action: `deno task reindex` walks `outputs/` only. It
does not rebuild `samples`, and it does not delete sample rows, so an imported
sample survives a rebuild. That is today's behaviour and this proposal does
not change it — but it does mean the sample half of the database is **not**
rebuildable from disk, which is a quiet exception to §7's promise and should
be fixed by a separate change that walks `samples/` the way §7 says it should.
Flagging it here rather than fixing it here: it is a pre-existing gap and
bundling it would double this diff.

---

## 8. Config changes

One new top-level block in `config.yaml`, validated like every other:

```yaml
import:
  # Where forgecli drops batches and the app picks them up.
  # null → <appdata>/import. An absolute path may live on a share, which is
  # how the fetching machine and the serving machine can be different ones.
  dir: null

  # How to invoke the official Civitai CLI. A bare name is looked up on PATH;
  # null disables it entirely and every lookup goes to the archive.
  civitai_cli: civitai

  # The fallback, and the only source for models Civitai has deleted.
  archive_url: https://civitaiarchive.com

  # What --download-samples means with no number after it.
  samples: 4

  # Civitai's nsfwLevel scale: 1 is "safe". Images above this are skipped.
  nsfw_level: 1

  # Slurp the import folder during the boot rescan as well as on demand.
  ingest_on_boot: true
```

- `src/config/types.ts`: `ImportConfig`, added to `Config` and `PartialConfig`.
- `src/config/defaults.ts`: the block above.
- `src/config/validate.ts`: `"import"` added to the top-level `rejectUnknown`
  list, plus a `validateImport` in the shape of `validateUi`.
- `src/config/paths.ts`: `DataPaths.imports`, defaulting to
  `<root>/import` and overridden by `import.dir`, created by
  `ensureDataDirs`. Note that this is the first path in `DataPaths` that
  depends on the config rather than on the root alone, so `dataPaths()` grows
  an optional second argument and `ConfigStore` passes it.
- `GET`/`PATCH /api/config` carry it like every other block; Settings grows a
  read-only line for it rather than a form, because changing where the import
  folder is mid-run is not a thing worth making easy.

The CLI reads the same file through the same loader, which is why it is a
config entry at all rather than a flag: both halves have to agree on the
folder, and there is exactly one place that says where it is.

---

## 9. Migrations

One migration, version 8 — `imported media provenance` — following the
established pattern (every statement also in `schema.sql`, so a fresh database
gets it at version 1 and the migration is a no-op there):

```sql
ALTER TABLE outputs ADD COLUMN source_json TEXT;   -- §5.4; NULL = made here
ALTER TABLE samples ADD COLUMN source_json TEXT;

-- Re-importing the same image is a no-op rather than a duplicate (§7.2).
CREATE UNIQUE INDEX IF NOT EXISTS samples_source
  ON samples(model_hash, source_url) WHERE source_url IS NOT NULL;
```

Existing rows get `NULL`, which reads as "this app made it" and is true of
every row that exists. Nothing is backfilled and nothing needs to be.

The partial unique index is the only part that can fail on an existing
database — if two sample rows already share a model and a source URL. None
can: `source_url` has been `NULL` on every sample ever written, because
nothing has ever set it. The migration creates the index unconditionally and,
should that ever stop being true, fails loudly in a transaction that rolls
back, which is the right failure.

`models.civitai_json` needs no migration: the column has been in `schema.sql`
since version 1, waiting for this.

---

## 10. Testing

Everything the test suite already promises — no network, no GPU, hermetic.

**Unit**
- `infotext.ts`: A1111 with and without a negative prompt, quoted values with
  commas, ComfyUI PNG chunks, an embedded ForgeUI sidecar, EXIF UserComment,
  a file with nothing, a file that is not an image.
- `civitai.ts`: every URL form in §4.1 and a handful that are not;
  `baseModel` → family for each mapping and for an unknown one; model `type`
  → kind.
- The CLI's argument parsing: the "exactly one of" rule, `--download-samples`
  with and without a value, unknown flags.

**Integration**
- Ingest applies a hand-written batch to a hashed model and deletes it.
- Ingest leaves a batch for an unhashed model alone, then applies it once the
  hash lands.
- Re-ingesting the same batch imports no second sample.
- A malformed `model.json` lands in `.failed/` and the next batch still
  ingests.
- `overwrite: false` does not clobber a hand-typed display name;
  `overwrite: true` does.
- An imported sample's row, sidecar and `GET /api/models/:hash` all carry the
  source; the sidecar round-trips through `reindex` unchanged.

**The CLI end to end** runs against a fake Civitai: a local HTTP server
serving canned `model-versions/by-hash`, `models/<id>` and image responses,
plus a stub `civitai` executable on `PATH` that prints fixture JSON — the same
shape as `tests/fake-comfy/` and for the same reason. The real Civitai is
never called by the suite; a `tests/contract/` case behind an env var can be
added when someone wants to check the fixtures are still true, exactly as
`FORGEUI_COMFY_URL` gates the ComfyUI contract tests.

---

## 11. What lands, in what order

1. `src/media/infotext.ts` + unit tests. Useful on its own: the existing drop
   zone starts filling `raw` the day it exists.
2. Migration 8, the sidecar `source` block, `source` on both views, the badge
   and the `?source=` filter. Useful on its own: promoted and dropped samples
   get an origin line that is not a guess.
3. `src/models/import.ts` + the config block + the ingest hooks, driven by
   hand-written batches. The whole app side, testable with no network at all.
4. `src/cli/main.ts` — cliffy, lookup, the archive fallback, sample download,
   batch writing.
5. `--download-model`, which is the only part that needs auth and the only
   part that writes into a model folder.

Steps 1–3 are independently shippable and none of them can reach the network.

---

## 12. Open questions

1. **Should `notes` take the Civitai description?** It is HTML, often long,
   and `notes` is a plain-text field a person types into. The proposal puts
   the trigger words plus a stripped-down description in and keeps the full
   HTML in `civitai_json`; the alternative is to leave `notes` alone entirely
   and render the description as its own read-only block on the model page.
2. **`--download-model` into which folder**, when a kind has several
   configured? The proposal takes the first, which is arbitrary. A
   `--into <path>` override is the obvious out, and it is left out of v1
   deliberately — one flag is easier to add later than to remove.
3. **Should ingest be able to create a `models` row** for a model whose file
   is not on disk, so metadata can be fetched ahead of a download? It would
   make `--download-model` and metadata one step, but a `models` row with no
   file behind it is a new state for every screen that lists models to handle.
   The proposal says no and requires the file first.
4. **Video samples.** Civitai posts them, `SampleStore` handles them, and
   their metadata lives in the same `meta` field. The only open part is
   whether the CDN's `original=true` rewrite works for video as it does for
   images; the proposal assumes it does and falls back to the URL as given.
