# Design — `forge models`: metadata, samples and weights from Civitai

**Status:** the backend is implemented; the model page's source panel (§7.5)
and the gallery badge (§7.3) are not. `forge serve` is the subcommand §3 calls
`gui` — the name the CLI shipped with, and the one that won.
**Touches:** DESIGN.md §3, §3.1, §6.2, §7, §8.1, §8.3, §11.2, §12, §13.
**Supersedes:** §12's `POST /api/models/:hash/fetch-info`, which is struck
(§9): the CLI is the fetcher, and a route that reached Civitai is the thing
§4.6 forbids.
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
3. **Civitai already ships a CLI**, and it looked like it handled the parts
   that are genuinely annoying. In the end it handles one of them — the login
   a gated model needs — and §4.0 records how little of the rest survived
   contact with the API. `forge models` uses it when it is installed and works
   without it, which is what "powered by the official CLI" had to become once
   it turned out most machines do not have it.

So the fetching lives in a subcommand of its own that the server never calls,
and the two halves meet on the filesystem rather than in a function call
(§3.1).

---

## 1. What this does

**`forge`** is the command line, with `gui` serving the app and `models`
fetching metadata (§3.1). **`forge models`** resolves a model — by URL, by
filename or by sha256 — against **civitai.red first and civitaiarchive.com
second** (§4.1), and writes what it finds into an **import folder** inside the
data directory. Metadata, samples and, with `--download-model`, the weights
themselves: everything it fetches goes into the same folder, and nothing it
fetches goes anywhere else. It writes files and nothing else. It never opens
`app.db`, never talks to the server, never touches a model folder, and does
not care whether the app is running.

**The app slurps that folder** on boot and at the end of every model rescan,
applies each batch to the model it names, and deletes the batch. A downloaded
weights file is moved into `<appdata>/models/<kind>/` — app-owned storage that
is scanned and hashed like any other model folder — so a model fetched by the
CLI simply appears on the Models page. An imported sample lands in
`samples/<model_hash>/` exactly as a dropped file does, with two additions: it
remembers **where it came from**, as a link, and it carries whatever
generation data could be parsed out of it.

That "where it came from" is the second half of the proposal and the reason to
do it now rather than bolt it on later: **provenance is a first-class field on
imported media**, in the sidecar and therefore in the index, on samples *and*
on gallery outputs. The next importers — SwarmUI's and ComfyUI's output
folders — are the same shape with a different fetcher, and they need the
gallery to be able to say "this one came from somewhere else, here is where"
before they can exist at all.

### 1.1 What it is not

- Not a model manager. It never deletes, moves, renames or reorganises a
  model you already have; the only file it puts anywhere is one it just
  fetched, and even that it hands to the app to file (§7.2).
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

      $ forge models --filename cyberrealistic_v90.safetensors --download-samples=8

    The CLI finds the file in a configured model folder, hashes it, asks
    civitai.red what that hash is, downloads eight images off the model's
    page, parses each one's generation data, and writes

      ~/.forgeui/import/9f3c…b1/

    It prints what it wrote and exits. Total elapsed: a few seconds plus the
    images.

4.  You hit **Rescan** on the Models page. (Or restart the app. Or wait for
    the next boot — the batch keeps.)

5.  The model page now has its family, its tags, its trigger words on a line
    you can copy, a **From Civitai** panel with the author's description in
    it, and eight samples in the strip (§5.5, §7.5). Each sample carries a
    `CIVITAI ↗` badge linking back to the image it came from, and shows its
    prompt, seed, sampler and steps read-only beside it.

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
  weights **into the batch**, like everything else it fetches. On ingest the
  app moves them into `<appdata>/models/<kind>/` and the ordinary scan picks
  them up: hashed, probed, on the Models page, loadable by ComfyUI through the
  generated `extra_model_paths.yaml` (§7.2, §8).

  Nothing — not the CLI, not the app — ever writes inside a folder
  `config.yaml` names. Those stay read-only, which is what AGENTS.md's rule
  has always meant and now means without an exception carved out of it. The
  data directory is app-owned storage and always has been; putting downloads
  there is the same claim as putting outputs there.

  The consequence worth naming: the app **does** now write a file it obtained
  over the network, which "never download anything at runtime" could be read
  as forbidding. It does not download it — `forge` did, deliberately,
  because you typed a flag — and the app only moves a file that is already on
  its own disk. A generation still cannot cause a transfer, which is the rule's
  actual subject (§4.6).
- **The model has not been hashed yet.** The batch names a sha256 the
  database has no row for. It stays in the folder, untouched, and is retried
  after the next hashing pass finishes. No error, no noise; it lands when the
  hash lands.
- **The CLI runs on another machine.** `import.dir` can point anywhere, so a
  shared folder makes the fetching host and the serving host different
  machines. Nothing in the format assumes otherwise.

---

## 3. Usage

`forge` is one binary with subcommands (§3.1). Its top-level help:

```
forge — ForgeUI: a workflow-first frontend for ComfyUI.

Usage:  forge <command> [options]

Commands:

  gui        Serve the UI and the API, and manage ComfyUI. (default)
  models     Fetch model metadata, samples and weights from Civitai.
  reindex    Rebuild app.db from the sidecars on disk.

Options:

  -h, --help     Show this help.
  -V, --version  Print the version.

`forge` with no command is `forge gui`. Every option after a command belongs
to that command; `forge gui --help` lists the server's flags.
```

`gui` and `reindex` take the flags `src/config/cli.ts` already defines and
pass them through untouched, so there is one definition of what the server
accepts and this document does not restate it.

The `models` help, which is the specification of that interface:

```
forge models — fetch model metadata, samples and weights into ForgeUI's
import folder, for the app to ingest on its next rescan.

Usage:  forge models [options]

Exactly one of --url, --filename or --sha256checksum says which model.

Options:

  -h, --help                  Show this help.
  -V, --version               Show the version.
  -d, --data-dir     <path>   ForgeUI data directory, whose config.yaml names the
                              model folders and the import folder.
                              (Default: $FORGEUI_DATA_DIR, else ~/.forgeui)

      --url          <url>    civitai.red, civitai.com or civitaiarchive.com link to
                              a model, a model version or an image. The site in the
                              link is tried first. Accepts every form in §4.1.
      --filename     <name>   Look up a model by filename on civitai.red and
                              civitaiarchive.com. A remote lookup: nothing on this
                              machine is read. Near misses are listed, not refused.
      --local-file   <path>   A model file on this machine: hash it and look that
                              hash up. Takes a path, or a filename in one of the
                              configured model folders.
      --sha256checksum <hex>  SHA256 of the model file — the identity ForgeUI uses.
      --search       <text>   List what Civitai has under this name and write nothing.
                              How you find the --url for something not on this
                              machine yet.

      --source       <name>   Where to look, when the input does not say:
                              auto (default) tries civitai.red, then
                              civitaiarchive.com. red | archive pin it to one.

      --download-samples <n>  Download up to <n> images from the model's page as
                              samples, newest first. (Default: 0)
      --download-model        Download the model weights into the batch. The app
                              files them under <appdata>/models/<kind>/ on ingest.
                              Public models need no login; see AUTH for the rest.
      --overwrite             Rewrite files already on disk. Without it every file
                              that exists is left exactly as it is.

      --dry-run               Print what would be fetched and written; touch nothing.
      --json                  Print the resulting model.json to stdout instead of a
                              human summary.
      --anon                  Never send credentials, even if a token is configured.
      --browsing-level <n>    Civitai's visibility bitmask, for what a lookup is
                              allowed to return. (Default: config import.browsing_level)
      --timeout      <ms>     Per-request timeout. (Default: 30000)

Examples:

  forge models --filename cyberrealistic_v90.safetensors --download-samples=8
  forge models --url https://civitai.red/models/4384?modelVersionId=128713
  forge models --sha256checksum 6ce0161689b3853acaa037… --download-samples=4 --overwrite
  forge models --url https://civitaiarchive.com/sha256/6ce0161689b3… --download-model

AUTH

  Lookups, sample images and public model downloads all work anonymously.
  A gated or paid model needs an account:

      export CIVITAI_TOKEN=<key>    a personal key from civitai.com/user/account
      civitai login                 or the official CLI's own device login,
                                    used automatically when it is installed

  ForgeUI stores no credential of its own and writes none into config.yaml,
  the import folder or any sidecar.

EXIT CODES

  0  wrote a batch (or, with --dry-run, would have)
  1  the model was not found on civitai.red or in the archive
  2  bad arguments, or none of --url/--filename/--sha256checksum
  3  a download failed, or --download-model without a login
  4  the import folder is not writable
```

Built with [cliffy](https://github.com/c4spar/cliffy)
(`jsr:@cliffy/command@^1.3.1`), which is where the subcommand shape, the
`--help` rendering, the `<n>` type checking and the "exactly one of" conflict
rule come from rather than being hand-rolled as `src/config/cli.ts` does for
the server. `models` is a subcommand because the next ones —
`forge import swarmui <dir>`, `forge import comfyui <dir>` — are
siblings of it, not variations on it.

### 3.1 One binary, and the invariant that actually holds

An earlier draft of this document made `forge` a *second* binary, on the
argument that a tool which can be pointed at a running app's data directory
has no business being able to open that app's database — and that keeping the
two apart made "the CLI cannot corrupt anything" structural rather than a
promise.

**That argument does not survive contact with the permission list.** Since
`node:sqlite` replaced the FFI driver, the server runs on `--allow-env
--allow-net --allow-read --allow-run --allow-write`. `forge models` needs
exactly those five: env for `FORGEUI_DATA_DIR` and `CIVITAI_TOKEN`, net for
the lookups, read for `config.yaml` and the model folders, write for the
import folder, run for the `civitai` binary. Two binaries were never granted
different authority, so separating them enforced nothing. The isolation was
always a property of which code paths the `models` command takes, and that
property is identical whether or not the server is linked into the same
executable.

So: **one binary**, and the invariant is stated as something testable instead
of something architectural —

> `forge models` never opens `app.db`. A test runs it end to end against a
> fresh data directory and asserts that no `app.db` is created, and against a
> populated one that the file's mtime does not move.

That is a stronger guarantee than the file layout ever gave, because it fails
the build when someone breaks it.

Mechanically it is small. `src/main.ts` already guards its entrypoint with
`import.meta.main`, so importing it starts nothing — it exports `startApp` and
that is all. The `gui` action takes its arguments raw (cliffy's
`useRawArgs()`) and hands them to the server's own parser, so the flag surface
is defined once. The import is dynamic, so `forge models` never loads the
server's module graph at all; measured cost if it did: 57 ms warm.

The one change inside `src/main.ts` is exporting the dozen lines its start
branch already has — the signal listeners and the never-resolving promise — as
`serve(argv)`, which `main()` then calls too.

What this buys: one thing on `PATH`, one `--help` that lists everything
ForgeUI does, and one artifact for Phase 5's `deno compile` instead of two.

Two costs, both accepted:

- `forge gui --help` forwards `--help` to the server's parser, so it prints
  `src/config/cli.ts`'s usage text in a different visual style from cliffy's.
  It is accurate, just inconsistent. Porting those flags into cliffy would fix
  it and delete the hand-rolled parser, but that is a rewrite of working,
  tested code for a cosmetic gain, and it is not in this proposal.
- The name. `forge` rather than `forgeui` or `forgecli`: `forge gui` and
  `forge models` both read as verbs on a tool, which neither of the others
  managed.

```
deno task cli models --filename …                   # from the repo
deno install -A -n forge jsr:… / src/cli/main.ts    # or install it
deno task start                                      # unchanged; still src/main.ts
```

---

## 4. Lookup

### 4.0 civitai.red, civitai.com, and where the official CLI fits

**On the websites, `.red` is the superset and you are right.** Civitai's own
announcement of the split says it plainly: one account, one database, two
front doors, and "Civitai.com is locked to PG content, so anything above that
simply won't show up there. Civitai.red lets you choose what you see." SFW
uploads appear on both; mature content appears only on `.red`. Nothing moved
or forked — a visibility filter is applied per domain.

**On the REST API it does not work that way, and this is worth knowing before
building on it.** The same API is served from both hostnames, and what it
returns is governed by the `browsingLevel` (integer bitmask) or legacy `nsfw`
query parameter rather than by which host you asked. Checked against both:

```
GET https://civitai.red/api/v1/images?browsingLevel=31&limit=20&sort=Newest
GET https://civitai.com/api/v1/images?browsingLevel=31&limit=20&sort=Newest
    → identical results, nsfwLevel in {None, Soft, Mature, X} from both
```

So `civitai.com` is not a narrower *API* than `civitai.red`; an unparameterised
request is narrower than a parameterised one, on either host. Which means the
subset/superset question has a different answer than the domains suggest, and
the thing that actually decides what you can see is a query parameter.

**Which parameter is not uniform across endpoints**, and this is the kind of
detail that costs an afternoon if it is not written down:

| endpoint | what widens it |
|---|---|
| `/api/v1/images` | `browsingLevel=31` **or** `nsfw=true` — both accepted |
| `/api/v1/models` | `nsfw=true` only; `browsingLevel=31` is rejected with a `ZodError` ("expected number, received string"), and `browsingLevel[]=31` parses but changes nothing |
| `/api/v1/model-versions/by-hash/…` | neither; a hash lookup answers for what it is given |

So the client sends `nsfw` to `/models`, `browsingLevel` to `/images`, and
nothing to `by-hash`. `import.browsing_level` is the one setting behind all
three, translated per endpoint in `src/models/civitai.ts` — one place that
knows this, rather than three call sites each getting it wrong differently.

**That is what demotes the official CLI.** Its documented interface has no
base-URL option and no `browsingLevel` or `nsfw` flag, so it asks with the
default filter and cannot be made to ask for anything else. A tool whose whole
job is identifying the models you already have must be able to identify the
mature ones, so lookups go to the API directly:

| job | who does it |
|---|---|
| lookups, image lists, `by-hash` | `civitai.red/api/v1/*` directly, with `browsingLevel` |
| deleted models | `civitaiarchive.com/api/*` |
| `--download-model` | a direct streaming GET; the official CLI when installed |
| credentials | `CIVITAI_TOKEN`, or the CLI's own login when it is there |

If it grows a `--browsing-level` flag, the lookups can move back behind it;
the normalising layer of §4.2 is what makes that a one-file change.

**Downloads moved off the CLI too, and for a plainer reason.** This document
argued that device login, token storage and resumable verified transfers were
the hard part and not worth reimplementing. That was right about the hard part
and wrong about the common case:

```
$ curl -sSI https://civitai.com/api/download/models/128713
HTTP/2 307
location: https://civitai-delivery-worker-prod…/dreamshaper8Pruned.safetensors?X-Amz-…
```

A public model answers an anonymous GET with a redirect to a signed URL. The
official CLI is a separate install almost nobody has — requiring it made
`--download-model` fail out of the box on any machine without it, which is the
one thing that flag must not do. So the download is a streaming `fetch` that
hashes as it writes, `CIVITAI_TOKEN` is sent when the environment has one, and
the official CLI is used when it is installed and configured, because it does
handle the gated and paid models a plain GET cannot.

One caveat to carry into implementation: the download endpoints are
`civitai.com`'s, and there are reports of API tokens not authenticating
against `civitai.red/api/`. `--download-model` therefore stays on `.com` via
the CLI, which is where the token is known to work. Lookup and download
talking to different hosts is fine — they are the same database.

### 4.1 Resolving the identifier

One of three flags, each reduced to the same thing: a **model version**, which
is what actually has files, images and a `baseModel`.

**`--sha256checksum <hex>`** — the direct road, and the one the other two end
up on. When the input does not name a site, the order is civitai.red, then
the archive; `--source` pins it to one.

1. `GET https://civitai.red/api/v1/model-versions/by-hash/<hash>`, which
   answers with the version, its files and its `baseModel` in one call and
   needs no visibility parameter — a hash lookup answers for what it is
   given. Civitai matches AutoV1, AutoV2, SHA256, CRC32 and BLAKE3 here,
   case-insensitively, so the same road serves a hash copied out of another
   tool. The version names its `modelId`, and
   `GET /api/v1/models/<modelId>` is the second call, for the description,
   tags and creator that §5.5 keeps.
2. Fallback: `GET https://civitaiarchive.com/api/sha256/<hash>`, which answers
   with every file it has seen under that hash and their `model_id` /
   `model_version_id`, then
   `GET https://civitaiarchive.com/api/models/<id>?modelVersionId=<v>`.

The archive is second rather than absent because it answers for **models
Civitai has deleted** — `deletedAt` is a field it returns rather than a 404 it
throws — which is a large fraction of the models people actually have on disk
and cannot identify. It also indexes HuggingFace, ModelScope and TensorArt
under the same hash, so its answer can name a mirror when the original is
gone.

**`--local-file <path>`** — "identify the file I already have". The path is
hashed and the run continues as `--sha256checksum`. An exact hash beats every
name-based search, and the answer is about *your* file rather than one that
happens to share its name. A bare filename is accepted too and resolved
against the configured model folders (basename match, one folder deep past the
root, as §3's scan does), because that is how anyone will actually type it.

**`--filename <name>`** — "find me this by name, wherever it is". A **purely
remote** lookup: nothing on this machine is read, because the case this exists
for is a model that is not here yet. Civitai first, then the archive:

1. `GET /api/v1/models?query=<stem>` — a result is taken when one of its
   version files carries exactly that filename.
2. `GET https://civitaiarchive.com/api/search?q=<filename>`, whose
   `kind: "file"` rows carry `url: "/sha256/<hash>"`. One distinct hash under
   that exact name is an answer; several are listed as `--sha256checksum`
   options, because files sharing a name are not the same model.
3. Otherwise the near misses from step 1 are listed with their URLs and their
   real filenames.

The two flags were one flag in an earlier draft, and that was wrong in both
directions: it read the disk when asked about something remote, and it had no
way to say "this exact file" when a name was ambiguous.

Step 3 matters more than it looks. Civitai mangles the filenames it stores —
what you downloaded as `krea2_turbo_bf16.safetensors` is
`krea2TurboFP8_krea2TURBO.safetensors` there — so a near miss is the ordinary
case rather than a failure:

```
$ forge models --filename krea2_turbo_bf16.safetensors
no model on Civitai has a file named exactly "krea2_turbo_bf16.safetensors",
and the archive has none either, but 20 look close. Pick one and pass its --url:
  Krea2 Turbo_FP8 [Krea 2]
    https://civitai.red/models/2723583?modelVersionId=3060999
    krea2TurboFP8_krea2TURBO.safetensors
  …
```

An earlier draft failed with "nothing named X was found" while holding twenty
candidates, which was false and left nowhere to go.

**A hash the archive only mirrors is not a model.** CivArchive indexes
HuggingFace and ModelScope copies by hash with no model record behind them, so
a lookup can find the bytes and still have no description, tags or samples to
import. That is said plainly rather than reported as "nothing knows this
hash", which would send someone hunting for a bug that is not there.

**`--url <url>`** — parsed, never fetched as a page. The host decides which
source is tried first; `.com` and `.red` are the same database, so a `.com`
link is honoured and then looked up with a `browsingLevel` that a `.com`
browser session would not have given you:

| form | reduces to |
|---|---|
| `civitai.red/models/<id>?modelVersionId=<v>` | that version |
| `civitai.red/models/<id>` | the model's latest version |
| `civitai.red/images/<id>` | the version that image was posted under |
| `civitai.com/…` (any of the three above) | the same, `.red` API |
| `civitaiarchive.com/models/<id>?modelVersionId=<v>` | that version, archive first |
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
which is what a downloaded file is filed under in `<appdata>/models/<kind>/`.
The CLI only records the kind; the app does the filing (§7.2). An unmapped
`type` files under `other`, which is scanned like every other kind and is
visible on the Models page — a model in the wrong drawer is a nuisance, and a
refused download is worse.

Note that the kind is a *Civitai* claim about the file, and the app does not
take its word for anything that matters: the family still comes from the
header probe where the probe has an answer, and the hash still comes from
hashing the bytes.

### 4.3 Samples

`--download-samples=<n>` takes the version's images, newest first, and for
each one:

1. **The bytes** come from the CDN URL with a plain `fetch` — they are public
   and the Civitai CLI has no image-download command. The URL's
   `width=450,optimized=true` segment is rewritten to `original=true` so the
   sample is the full-size image rather than a card thumbnail.
2. **The generation data** comes from
   `GET https://civitai.red/api/v1/images?modelVersionId=<v>&withMeta=true`
   with `browsingLevel`, whose `meta` is the A1111-style record (`prompt`,
   `negativePrompt`, `steps`, `sampler`, `cfgScale`, `seed`, `Size`, `Model`,
   `hashes`, `resources`, sometimes a `comfy` workflow). Where the API has no
   meta, the file itself is parsed (§6). `withMeta=true` is what keeps the
   list to images there is something to show for.
3. Images above `import.nsfw_level` are skipped and counted in the summary.
   This is ForgeUI's own ceiling and is separate from
   `import.browsing_level`, which is what the *lookup* was allowed to see:
   asking broadly and filing narrowly means the model is still found when its
   only images are ones you did not want downloaded.

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
    model/                            only with --download-model
      cyberrealisticV90.safetensors
  .staging/<ulid>/                    a batch being written; renamed into place
  .failed/<sha256>/                   a batch ingest refused, plus error.txt

<appdata>/models/<kind>/              ← new; where ingest files downloaded weights
  checkpoints/
  loras/
  …
```

`<appdata>/models/` is an ordinary model folder as far as everything else is
concerned: the scan walks it, the hasher hashes it, and
`extra_model_paths.yaml` lists it under its kind so ComfyUI can load from it.
The only thing special about it is who may write there, and the answer is the
app — because it is inside the data directory, which the app has always
owned. The folders `config.yaml` names stay read-only, with no exception.

Chosen this way because:

- **Named by sha256** — the model's identity in this app (§8.1). Ingest is a
  primary-key lookup, two batches for one model collide loudly rather than
  quietly doubling up, and nothing has to be parsed to know what a directory
  is about. It also means a `--download-model` batch is **self-verifying**:
  the folder's name is what the bytes inside it must hash to, so a truncated
  or substituted download is caught by the pass that files it, not by a
  loader failing at generate time.
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
  "forge_version": "0.1.0",
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
    "url": "https://civitai.red/models/62437?modelVersionId=66991",
    "model_id": 62437,
    "model_version_id": 66991,
    "fetched_at": "2026-09-18T20:14:01Z",
    "via": "civitai.red/api/v1"
  },
  "civitai": { "…": "the lookup response, verbatim and uninterpreted" },
  "files": [
    {
      "file": "model/v15PrunedEmaonly.safetensors",
      "kind": "checkpoints",
      "sha256": "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
      "size": 4265146304,
      "source": {
        "kind": "civitai",
        "label": "Civitai",
        "url": "https://civitai.com/api/download/models/66991",
        "fetched_at": "2026-09-18T20:16:44Z",
        "via": "civitai-cli/1.4.2"
      }
    }
  ],
  "samples": [
    {
      "file": "samples/0001.jpeg",
      "kind": "image",
      "width": 768,
      "height": 768,
      "source": {
        "kind": "civitai",
        "label": "Civitai",
        "url": "https://civitai.red/images/26534668",
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

`files` is absent without `--download-model` and is a list rather than a
single entry because a version can ship more than one file worth having (a
checkpoint and its VAE, a LoRA and its config). Each entry names its own
kind, so a two-file batch can file into two folders.

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
  "url": "https://civitai.red/images/26534668",
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

### 5.5 The source record: what Civitai knows about a model

Everything Civitai holds about a model that is worth keeping — the
description, the trigger words, the creator, the upstream tags — lands in one
**source record**, and the shape of it is set by two requirements that pull in
opposite directions: a future MCP wants it small, plain and structured, and
the model page wants it rendered the way its author wrote it.

**The description is real HTML, not fancy text.** This was worth checking
rather than assuming, so: across the descriptions of two popular models, the
tags present were

```
p 107  strong 53  br 43  a 32  li 27  span 8  h2 6  code 6
u 5  ul 5  h3 3  em 3  h1 1  s 1  img 1  pre 1
```

— the output of a rich-text editor (the `id="heading-133"` anchors and
`rel="ugc"` links give away ProseMirror), including headings, lists, code
blocks, emoji, inline images and a great many links to Patreon and Ko-fi. It
is 6–8 KB for a well-documented model. You cannot flatten it to plain text
without losing the structure that makes it readable, and you cannot render it
raw. So both renditions are kept:

- **`description_html`** — verbatim, exactly as served. The archival copy, and
  what the model page renders *after sanitising* (§7.5).
- **`description_text`** — derived at ingest: headings become `#` lines, lists
  become `-` lines, links become `[text](url)`, images are dropped, everything
  else is unwrapped. Markdown, in other words. This is what the API returns by
  default and what an MCP would put in front of a model, because 8 KB of
  `<strong>`-wrapped Patreon pitch is not a useful tool response.

Deriving one from the other at ingest rather than at read time means the
expensive, fiddly part happens once, in the CLI, where a bad parse is visible
in a diff rather than in a route.

**Trigger words are promoted out of the blob.** They are the one part of this
the *app* acts on rather than displays: they go into a prompt. So they become
a first-class field on the model — `trigger_words`, a list of strings — with
the rest of the record staying read-only reference material. The upstream data
needs cleaning first: `trainedWords` lives on the *version*, not the model,
and is inconsistent in a way that will bite anyone who trusts it —

```json
["shuimobysim", "wuchangshuo", "bonian"]          // a clean list
["abstractionism, brush stroke, traditional media, "]  // one string, comma-separated, trailing comma
[]                                                 // very common
```

so ingest splits every entry on commas, trims, drops empties and
de-duplicates case-insensitively.

**Collections are not available.** Civitai's public API has
`/api/v1/collections`, which lists public collections globally, but there is
no reverse lookup from a model to the collections containing it
(`/api/v1/models/<id>/collections` is a 404, and the model response carries no
collection field). Getting it would mean enumerating collections and their
items until you found the ones that mention this model, which is a crawl
rather than a lookup and is not something this tool should do. The field is
**left out rather than stubbed**, and the record's `format` version is how it
gets added later if Civitai ever exposes it.

The record as stored:

```json
{
  "format": 1,
  "source": {
    "kind": "civitai",
    "label": "Civitai",
    "url": "https://civitai.red/models/4384?modelVersionId=128713",
    "model_id": 4384,
    "model_version_id": 128713,
    "fetched_at": "2026-09-23T09:12:44Z"
  },
  "creator": { "username": "Lykon", "url": "https://civitai.red/user/Lykon" },
  "model": {
    "name": "DreamShaper",
    "type": "Checkpoint",
    "tags": ["photorealistic", "base model", "anime"],
    "description_html": "<h1 id=\"heading-133\">DreamShaper - V∞!</h1>…",
    "description_text": "# DreamShaper - V∞!\n\n…"
  },
  "version": {
    "name": "8",
    "base_model": "SD 1.5",
    "published_at": "2023-10-30T…",
    "description_html": "<ul><li><p>Better at handling Character LoRA</p></li>…",
    "description_text": "- Better at handling Character LoRA\n…"
  },
  "trigger_words": ["shuimobysim", "wuchangshuo"],
  "license": {
    "allow_commercial_use": ["Image"],
    "allow_derivatives": true,
    "allow_no_credit": true
  },
  "stats": { "downloads": 1207233, "thumbs_up": 24408 }
}
```

**Where it lives.** §8.1 already says a model's Civitai metadata lives "in
`models-meta/<hash>/` and the DB", and `models.civitai_json` has been in
`schema.sql` since version 1 without ever being written. So: the raw upstream
response is written to `models-meta/<hash>/civitai.json`, the normalised
record above goes in `models.civitai_json`, and `trigger_words` gets a column
of its own. The on-disk copy is what a rebuild reads, which keeps the
database derived exactly as §7 promises — and unlike samples (§7.4), this half
*is* rebuildable from disk from the start.

**It never merges into the fields you edit.** `notes`, `display_name` and
`tags` are yours — §8.1 makes them edit-in-place. The source record is a
cached copy of somebody else's document with its own lifecycle: replaced
wholesale on a re-fetch, never diffed, never merged. Dumping 8 KB of an
author's promotional HTML into `notes` would destroy the field it landed in
and then clobber whatever you typed the next time `--overwrite` ran. Two
different lifecycles, two different homes. The upstream `tags` are the one
borderline case, and they stay in the record rather than joining ForgeUI's
`tags`, which are your taxonomy and drive the `?tags=` filter: importing forty
models should not silently add two hundred tags to your filter list. Promoting
a tag from the record to a real tag is a click on the model page, not
something ingest decides.

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

A new `src/models/import.ts` — `ImportInbox` — owned by `ModelLibrary`, in
**two phases around the scan** rather than one pass after it. Weights force
that: a batch that carries a file the library has never seen cannot be applied
until the file has been filed, scanned and hashed, and the hash is what the
batch is keyed on.

- **Phase A — file, at the start of `rescan()`.** Every batch carrying a
  `files` entry has it verified against the batch's own sha256 and moved into
  `<appdata>/models/<kind>/`. Nothing else in the batch is touched; the batch
  stays.
- the scan and the hashing queue then run exactly as they do today, and the
  file Phase A moved is just another new model to them.
- **Phase B — apply, when the hasher drains.** §7.2, for every batch whose
  hash now has a row.

`rescan()` therefore ends with the metadata not yet applied, and Phase B
follows a beat later when hashing finishes. That is the same shape the rest of
the library already has — a scan makes a model appear, hashing gives it an
identity — so a downloaded model shows up on the Models page immediately and
fills in its family, tags and samples when its hash lands, which is the
behaviour §8.1 already describes for a model you copied in by hand.

Neither phase runs on a timer or on an HTTP request of its own. Progress is
broadcast on the existing `rescan_progress` channel with three added counters
(`imports_found`, `imports_filed`, `imports_applied`), so the Models page's
existing progress line says what is happening without a new socket message
type.

### 7.2 What ingest applies

**Phase A**, for each batch with a `files` entry, before anything is scanned:

1. **Verify.** The file is hashed and must match the entry's `sha256`, which
   must in turn be the batch's own directory name for the primary file. A
   mismatch is a failed batch (`.failed/`), not a filed model — half a
   checkpoint on the Models page is worse than an error.
2. **File it.** Moved to `<appdata>/models/<kind>/<filename>`, created if
   absent. A name already taken by different bytes gets ` (2)` before the
   extension; a name already taken by *these* bytes means a previous run
   already filed it, and the batch's copy is dropped.
3. The entry is marked filed in `model.json`, rewritten in place, so a crash
   between the move and the scan does not file it twice.

**Phase B**, for each `import/<sha256>/model.json`, in one transaction:

1. **Find the model.** No `models` row for that hash → leave the batch alone
   and move on. This is the normal case for a not-yet-hashed file, not an
   error, and it is the case a `--download-model` batch is in until the hasher
   reaches the file Phase A just filed.
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
5. **Delete the batch**, after the transaction commits. By now it holds only
   `model.json` and whatever sample files could not be moved; the weights left
   in Phase A.

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

### 7.5 The source panel, and the API an MCP will read

`GET /api/models/:hash` grows one block, which is the record of §5.5 with its
HTML halves left out by default:

```
GET /api/models/:hash                → …, trigger_words[], source { … }
GET /api/models/:hash?html=1         → the same, plus description_html
```

Plain by default is the important half of that. An MCP asking "what is this
LoRA and how do I trigger it" wants `trigger_words` and `description_text`;
serving it 8 KB of markup by default would make every caller strip tags, and
some of them would do it wrong. The browser is the one caller that wants the
HTML and the one that can ask for it.

Nothing about this is MCP-specific — it is an HTTP route returning normalised
JSON, which is what an MCP server would wrap. Keeping the wrapping out of
scope costs nothing as long as the shape is right now, and the shape being
right now is the entire reason §5.5 normalises at ingest instead of at read.

On the model page, a **From Civitai** panel below the header: creator, upstream
tags, published date, license summary, the rendered description, and the link
out. Collapsed by default past a few lines, because a description can be eight
kilobytes and the samples strip is what people came for.

Two rules for rendering it, both non-negotiable:

- **Sanitise.** The HTML is written by a stranger. Allow the tag set §5.5
  measured (`h1`–`h3`, `p`, `br`, `strong`, `em`, `u`, `s`, `a`, `ul`, `ol`,
  `li`, `code`, `pre`, `blockquote`) and strip everything else, attributes
  included, with `href` kept only for `http(s):` and every link forced to
  `target="_blank" rel="noopener noreferrer nofollow"`.
- **Drop `<img>` entirely**, replacing each with a plain link. Those point at
  `image.civitai.com`, and rendering them would make opening a model page
  issue requests to a third party every time — in an app whose whole premise
  is that it does not talk to anyone you did not ask it to. The description
  images are decoration; the samples strip is the images that matter, and
  those are on disk.

The trigger words get their own line above the panel, monospaced, each one a
click to copy — the one piece of this that is an input rather than a document.

---

## 8. Config changes

One new top-level block in `config.yaml`, validated like every other:

```yaml
import:
  # Where forge drops batches and the app picks them up.
  # null → <appdata>/import. An absolute path may live on a share, which is
  # how the fetching machine and the serving machine can be different ones.
  dir: null

  # Where ingest files weights fetched with --download-model.
  # null → <appdata>/models. Point it at a disk with room on it; it is a
  # model folder like any other and is scanned as one (§5.1).
  model_dir: null

  # Looked up first. civitai.com is the same API with a narrower default
  # filter (§4.0), so this is the .red host and browsing_level does the
  # filtering rather than the hostname.
  civitai_url: https://civitai.red

  # Civitai's visibility bitmask. 1 is PG only; 31 is everything. This is
  # what a *lookup* may return — nsfw_level below is what may be downloaded.
  # Which query parameter carries it differs per endpoint (§4.0); one place
  # translates it, and this is the only knob.
  browsing_level: 31

  # The fallback, and the only source for models Civitai has deleted.
  archive_url: https://civitaiarchive.com

  # How to invoke the official Civitai CLI, which owns credentials and
  # --download-model. A bare name is looked up on PATH; null disables
  # downloads and leaves lookups working.
  civitai_cli: civitai

  # What --download-samples means with no number after it.
  samples: 4

  # Civitai's nsfwLevel scale: 1 is "safe". Images above this are skipped.
  nsfw_level: 1

  # Slurp the import folder during the boot rescan as well as on demand.
  ingest_on_boot: true
```

`browsing_level` and `nsfw_level` are two settings rather than one because
they answer different questions — what a lookup may *see* versus what may be
*kept*. Defaulting the first to 31 and the second to 1 means a mature model is
still identified, named and filed correctly while none of its images land on
your disk, which is the behaviour someone who has models they did not
advertise actually wants. Setting both to 1 is the strict reading and is one
edit away.

- `src/config/types.ts`: `ImportConfig`, added to `Config` and `PartialConfig`.
- `src/config/defaults.ts`: the block above.
- `src/config/validate.ts`: `"import"` added to the top-level `rejectUnknown`
  list, plus a `validateImport` in the shape of `validateUi`.
- `src/config/paths.ts`: `DataPaths.imports` (`<root>/import`) and
  `DataPaths.downloads` (`<root>/models`), overridable by `import.dir` and
  `import.model_dir`, both created by `ensureDataDirs`. These are the first
  paths in `DataPaths` that depend on the config rather than on the root
  alone, so `dataPaths()` grows an optional second argument and `ConfigStore`
  passes it.
- `src/config/extra_model_paths.ts`: `<appdata>/models/<kind>` is appended to
  every kind's folder list in the generated file, so ComfyUI resolves a
  downloaded model by name like any other. The same list is what
  `ModelScanner` walks, so the Models page and ComfyUI keep agreeing about
  what exists.
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

-- What the model wants in a prompt (§5.5). A list of strings, or NULL for
-- "nobody has told us", which is every row today.
ALTER TABLE models ADD COLUMN trigger_words_json TEXT;

-- Re-importing the same image is a no-op rather than a duplicate (§7.2).
CREATE UNIQUE INDEX IF NOT EXISTS samples_source
  ON samples(model_hash, source_url) WHERE source_url IS NOT NULL;
```

`trigger_words_json` is the only part of §5.5's record to get a column. The
rest goes in `models.civitai_json`, which `schema.sql` has carried since
version 1 and nothing has ever written — so the source record needs no
migration at all, only a first writer. The column's name predates
civitaiarchive being a source too; the record's own `source.kind` says which
one answered, and renaming a column for tidiness is not worth a migration.

Existing rows get `NULL`, which reads as "this app made it" and is true of
every row that exists. Nothing is backfilled and nothing needs to be.

The partial unique index is the only part that can fail on an existing
database — if two sample rows already share a model and a source URL. None
can: `source_url` has been `NULL` on every sample ever written, because
nothing has ever set it. The migration creates the index unconditionally and,
should that ever stop being true, fails loudly in a transaction that rolls
back, which is the right failure.

**Not a database migration, but spec changes that belong with them.** Per
AGENTS.md, DESIGN.md is edited first and this document does not get to
contradict it, so these land with the steps of §11 that need them:

- §3's directory layout gains two entries, `import/` and `models/`, and §3's
  line "Model folders … are **never written to**" needs the word *configured*
  in it, since `<appdata>/models/` is now a model folder the app writes.
- §8.1's "optional Civitai metadata (fetched by hash **only when the user
  clicks Fetch info**; never automatic)" describes a button that was never
  built. It becomes: fetched by `forge models`, applied on ingest, never by
  the app on its own — which keeps the "never automatic" promise it was making
  and names the thing that actually does the fetching.
- §12's route table gains `?html=1` on `GET /api/models/:hash`, and
  `POST /api/models/:hash/fetch-info` — listed there since Phase 3 and never
  implemented — is struck. There is no such route in this design; the CLI is
  the fetcher, and a route that reached Civitai would be the thing §4.6
  forbids.

There is no migration for what is already on disk, and none is needed: an
existing install has no `import/` and no `<appdata>/models/`, both are created
empty on the next boot, and an install that never runs `forge` sees no
change at all.

---

## 10. Testing

Everything the test suite already promises — no network, no GPU, hermetic.

**Unit**
- `infotext.ts`: A1111 with and without a negative prompt, quoted values with
  commas, ComfyUI PNG chunks, an embedded ForgeUI sidecar, EXIF UserComment,
  a file with nothing, a file that is not an image.
- `civitai.ts`: every URL form in §4.1 and a handful that are not;
  `baseModel` → family for each mapping and for an unknown one; model `type`
  → kind; `import.browsing_level` translated to the right parameter per
  endpoint (§4.0's table).
- `trainedWords` normalisation (§5.5): a clean list, the one-string
  comma-separated form with its trailing comma, `[]`, `null`, and duplicates
  differing only in case.
- HTML → text (§5.5): headings, nested lists, links, `<br>`, code blocks,
  entities, and a description that is not valid HTML at all.
- The sanitiser (§7.5): `<script>` and `<iframe>` removed, `<img>` replaced by
  a link, `javascript:` hrefs dropped, `rel`/`target` forced on what survives.
  This one is security-relevant, so it gets the ugly inputs.
- The CLI's argument parsing: the "exactly one of" rule, `--download-samples`
  with and without a value, unknown flags, and `forge gui --help` reaching the
  server's parser rather than cliffy's.

**Integration**
- Ingest applies a hand-written batch to a hashed model and deletes it.
- Ingest leaves a batch for an unhashed model alone, then applies it once the
  hash lands.
- A batch carrying a weights file is filed into `<appdata>/models/<kind>/`,
  scanned, hashed, and then applied — the whole Phase A → scan → Phase B
  sequence, driven by a small fake `.safetensors` and `app.models.rescan()`.
- A weights file whose bytes do not hash to the batch's name is refused and
  nothing is filed.
- `<appdata>/models/<kind>` appears in the generated `extra_model_paths.yaml`
  under that kind.
- Re-ingesting the same batch imports no second sample.
- A malformed `model.json` lands in `.failed/` and the next batch still
  ingests.
- `overwrite: false` does not clobber a hand-typed display name;
  `overwrite: true` does.
- An imported sample's row, sidecar and `GET /api/models/:hash` all carry the
  source; the sidecar round-trips through `reindex` unchanged.
- `GET /api/models/:hash` returns `trigger_words` and `description_text` and
  **no** `description_html`; `?html=1` returns it (§7.5).
- `forge models` run against a fresh data directory creates no `app.db`, and
  against a populated one does not touch its mtime — §3.1's invariant, which
  is the one test that keeps the two halves honest now they share a binary.

**The CLI end to end** runs against a fake Civitai: a local HTTP server
serving canned `model-versions/by-hash`, `models/<id>`, `images` and archive
responses — `import.civitai_url` and `import.archive_url` point at it, which
is the other reason those are config rather than constants — plus a stub
`civitai` executable on `PATH` that writes a fixture file where a download
would land. The same shape as `tests/fake-comfy/`, for the same reason.

Two cases the fake exists to cover: the archive fallback fires when the
primary 404s, and a lookup sends the configured `browsingLevel` (asserted on
the request, since it is the one parameter the whole §4.0 argument rests on).

The real Civitai is never called by the suite; a `tests/contract/` case behind
an env var can be added when someone wants to check the fixtures are still
true, exactly as `FORGEUI_COMFY_URL` gates the ComfyUI contract tests. That
case is worth writing eventually — §4.0's claim about the two hosts was true
on the day it was measured and is not a promise anyone made us.

---

## 11. What lands, in what order

1. `src/media/infotext.ts` + unit tests. Useful on its own: the existing drop
   zone starts filling `raw` the day it exists.
2. Migration 8, the sidecar `source` block, `source` on both views, the badge
   and the `?source=` filter. Useful on its own: promoted and dropped samples
   get an origin line that is not a guess.
3. The source record (§5.5): the HTML→text conversion, the sanitiser,
   `trigger_words` and its column, the `From Civitai` panel and the
   `GET /api/models/:hash` block. Pure functions plus a read path, driven by
   canned fixtures — no network, no CLI, and it is what the future MCP reads.
4. `src/models/import.ts` + the config block + the ingest hooks, driven by
   hand-written batches. The whole app side, testable with no network at all.
5. `src/cli/main.ts` — cliffy, the `gui`/`reindex` passthrough and the
   `serve(argv)` export, then `models`: lookup against civitai.red, the
   archive fallback, sample download, batch writing.
6. `--download-model`: the CLI half (the one part that needs auth) and the
   Phase A half (`<appdata>/models/`, the `extra_model_paths.yaml` entry, the
   DESIGN.md §3 edit).

Steps 1–4 are independently shippable and none of them can reach the network.
Step 6 is last because it is the only step that can put six gigabytes
somewhere, and it should land on top of a pipeline that is already known to
work for the parts that cannot.

---

## 12. Open questions

1. **Should `description_text` be searchable?** DESIGN.md §12 has carried the
   question ("should notes / Civitai description be searchable anywhere")
   since before there was a description to search. There is one now, and it is
   the best prose anyone will ever write about a model — but `?q=` today means
   "name, filename and tags", and quietly widening it to eight kilobytes of
   Patreon pitch per model would make every search noisier. A separate
   `?describes=`, or an FTS table over `description_text` alone, are both
   defensible. The proposal stores the text and searches none of it, which is
   the reversible choice.
2. **Does `<appdata>/models/` want a size ceiling or a sweep?** Weights are
   the largest thing the data directory will ever hold, and nothing in this
   proposal ever deletes one — `GET /api/system/storage` would start
   reporting a number that only goes up. The obvious answer is a line in the
   storage report and a delete action on the model page for models filed
   there, which is a small feature and not this one. Raised because "the app
   now accumulates gigabytes" is worth deciding on purpose.
3. **Should ingest be able to create a `models` row** for a model whose file
   is not on disk, so metadata can be fetched ahead of a download? It would
   make `--download-model` and metadata one step, but a `models` row with no
   file behind it is a new state for every screen that lists models to handle.
   The proposal says no and requires the file first.
4. **Video samples.** Civitai posts them, `SampleStore` handles them, and
   their metadata lives in the same `meta` field. The only open part is
   whether the CDN's `original=true` rewrite works for video as it does for
   images; the proposal assumes it does and falls back to the URL as given.
