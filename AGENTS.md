# AGENTS.md

ForgeUI — a workflow-first frontend for ComfyUI. Deno + SQLite + Svelte.

**This repository is under active development. Phase 1 is complete** (the core
generation loop: workflows, jobs, outputs, gallery, reindex, UI) and verified
against a real ComfyUI; Phase 2 is under way — M5 through M8 are done, so the
model library, samples and the node-timing ETA have a backend but no screen yet
(M9). The default suite still uses the in-process fake in `tests/fake-comfy/`
and needs nothing, but `deno task comfy:setup` provisions a real CPU-only
ComfyUI that `test:comfy` and `test:e2e:comfy` drive
(`docs/HARDWARE-CHECKLIST.md`).

## Read these first

| Document                     | Why                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/DESIGN.md`             | **Authoritative.** Architecture, schema (§7), API (§12), UI (§11). If your change disagrees with it, stop and ask rather than deviating. |
| `docs/PHASE-1-HANDOFF.md`    | What Phase 1 delivered and the decisions worth knowing.                                                                                  |
| `docs/PHASE-2-HANDOFF.md`    | What Phase 2 delivered, what it looks like, and where Phase 3 picks up.                                                                  |
| `docs/IMPLEMENT-PHASE-1.md`  | The Phase 1 work plan and its conventions.                                                                                               |
| `docs/IMPLEMENT-PHASE-2.md`  | The Phase 2 work plan, M5–M9. All of it is done; Phase 3 has no plan document yet.                                                       |
| `docs/HARDWARE-CHECKLIST.md` | What running against a real ComfyUI proves, how to run it, and what it does not cover.                                                   |
| `docs/MOCK-REVISIONS.md`     | Decided changes to the mocks; overrides the frames in `docs/mocks/`.                                                                     |

## Layout

```
src/main.ts     CLI, boot order, the App handle tests use
src/config/     config.yaml layers, CLI overrides, extra_model_paths.yaml
src/db/         schema.sql (verbatim DESIGN §7), migrations, all SQL
src/comfy/      http client, ws client, child process, launch flags, proxy
src/workflows/  manifest validation, param coercion, graph rewrite, loader
src/jobs/       submit/progress/completion pipeline, node timings, sidecar, png
src/outputs/    gallery queries, soft delete, reindex
src/models/     the folder scan, the background hasher, output_models backfill
src/samples/    per-model sample media: file drop, promote, thumbnails
src/http/       router, routes/*, /ws hub, media, static
src/frontend/   the Svelte app — npm + Vite, the only non-Deno toolchain
tests/          unit/ integration/ golden/ fake-comfy/ fixtures/ e2e/
workflows/bundled/<id>/   the eight workflows of §4.6 (+ README)
```

## Commands

```sh
deno task start --data-dir ./data   # serve the API and the built UI on one port
deno task test                      # unit + golden + server integration (no GPU)
deno task check / lint / fmt         # Deno side only
deno task ui:install                 # once: npm install in src/frontend
deno task ui:build                   # build the SPA into src/frontend/dist
deno task ui:dev                     # Vite dev server, proxying /api /ws /comfy
deno task ui:check / ui:fmt          # svelte-check / prettier
deno task test:ui                    # param-panel component tests (vitest)
deno task test:e2e                   # Playwright smoke test against the built app
UPDATE_GOLDEN=1 deno task test       # accept new golden files, never silently

deno task comfy:setup                # once: a pinned ComfyUI, CPU torch, SD 1.5
deno task comfy:serve                # run that ComfyUI in the foreground
deno task test:comfy                 # §14.1 contract check + the app-level run
deno task test:e2e:comfy             # the browser half, including the editor
```

`deno check`/`lint`/`fmt` exclude `src/frontend/` and the Playwright specs —
those use the npm toolchain. Run both sides before you call something green.

## Conventions

- TypeScript strict, Deno std + `@db/sqlite`, no ORM. Every SQL statement lives
  in `src/db/queries.ts`, one function per query.
- **Open SQLite only through `openDatabase()` / `DATABASE_OPTIONS`.** The driver
  truncates integers above 2³¹ without `int64`, which is every `created_at`.
- The sidecar is the source of truth; the database is a derived index that
  `deno task reindex` can rebuild. Anything you would store only in the DB about
  an output must also go in the sidecar — and in DESIGN.md first.
- No foreign keys point at workflows. Outputs must stay usable after a workflow
  is deleted; there is a test for it.
- Copy the exact JSON shapes from DESIGN.md (`progress_json`, sidecar,
  manifest). Add fields only by editing DESIGN.md first.
- Never write inside model folders. Never download anything at runtime.
- Every route in §12 that Phase 1 implements has an integration test that goes
  through the route, not the query.
- Websocket payloads share the API's shapes — broadcast what `GET` returns.
- UI: only the two keyboard bindings from `config.yaml` `keys`; no favorites, no
  batch count, no light theme.
- A model is named by its display name everywhere it appears, and is a link to
  its page wherever it has a hash (§8.1). Nothing Civitai exists yet: the URL
  field and Fetch info are Phase 3, and the space for them is left empty rather
  than stubbed.

## Testing

No GPU, no models, no real ComfyUI. `tests/fake-comfy/` is an HTTP + WebSocket
stand-in whose per-prompt behaviour is data in `scenarios.ts` (success,
multi-output, error mid-graph, cancel queued, cancel running, disconnect and
reconnect, death before `executed`). `tests/e2e/serve.ts` runs it as a managed
child process behind a stub interpreter, so the whole spawn path is exercised.

`tests/contract/` is the exception: it talks to a real ComfyUI and every test is
ignored unless `FORGEUI_COMFY_URL` is set, so `deno task test` still needs
nothing. `scripts/with_comfy.ts` sets that (and the rest of
`tests/contract/env.ts`) by starting the ComfyUI `scripts/setup-comfy.sh`
provisioned. When the contract check disagrees with the fake, the fake is what
changes.

`sd15` is the one bundled workflow that can actually run: its weights are a
download rather than a choice, so it is what the contract check generates with.
Keep it working.

Model hashing never blocks anything: pickers, generation and the gallery all
work with zero hashed models, and anything needing a hash degrades to a `path`
identity or a disabled control (§8.1). Tests drive the library with
`app.models.rescan()`; `startTestApp` leaves the boot pass off so fixtures
cannot race it.

Prefer a test that goes through the HTTP or WebSocket interface over one that
pokes the database. When a browser-visible change is involved, look at it:
`tests/e2e/shots.spec.ts` and `video.spec.ts` exist for that, and several real
bugs in Phase 1 were only found that way.
