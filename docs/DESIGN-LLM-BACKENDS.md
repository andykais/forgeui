# Design — the bridge hands the GPU to llama-swap *or* Strata

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1 (a sixth `config.yaml` block), DESIGN-AGENT-LOOP
§5.2, §5.4, §8, §10, MCP-BRIDGE.md §2–§3, AGENTS.md (the "never needs
llama-swap" rule).
**Inspiration:** [vhotseat](https://github.com/wandermyz/vhotseat), which makes
[Strata](https://github.com/niko1221/strata) and ComfyUI take turns on one GPU.

---

## The problem

`forge mcp` knows one LLM server. `src/mcp/llama.ts` asks llama-swap what is
resident (`GET /running`), unloads it (`POST /api/models/unload[/:id]`), polls
until nothing is running, and lets the harness's next completion reload it.
The class is passed straight into `runRound` and the `gpu_status` tool, and the
only way to turn it on is `--llama-swap <url>` on the command line.

Strata is a different kind of server for the same job: one model (a large MoE
with experts offloaded to RAM), served directly rather than behind a proxy, with
its own load/unload API. It cannot sit behind llama-swap usefully — llama-swap
would kill and restart the whole process, throwing away a 1–3 minute cold start
that Strata's own unload avoids (it ends only the engine; the HTTP server and
the OS file cache stay, and a reload measures about 5 s). So the bridge has to
speak to it directly.

## What Strata gives us

From Strata's `docs/DETAILS.md` and vhotseat's working config for it
(`config.example.yaml`, `drivers/http.py`):

| Call | Effect |
| --- | --- |
| `GET /health` | `{"status":"ok","model":…,"loaded":true,…}` — what is loaded, and its name |
| `POST /unload` | ends the engine process, releasing its VRAM and RAM; **409** while a request is running |
| `POST /unload?wait=<s>` | waits up to `s` seconds for the running turn first (`wait=1` means up to 300 s) |
| `POST /load` | loads ahead of a request; synchronous |
| any `/v1/chat/completions`, `/v1/messages` | **loads the model if it is not loaded** |
| `Authorization: Bearer <key>` | required on everything when Strata has an `api_key` |

vhotseat treats an unload as done on HTTP 200 with `status` in
`["unloaded", "not loaded"]`, as busy on 409 or `status: "busy"`, and then
confirms by watching the process's VRAM reach zero. Strata also has two knobs
on its side that matter to us: `min_free_vram_mib` (an unloaded model refuses
to load with **503 + `Retry-After`** unless that much VRAM is free) and
`before_load` (a command run before every load; with `before_load_strict` a
non-zero exit refuses the load).

The response bodies of `/load` and `/unload` are not documented beyond what
vhotseat checks. The client below reads them the way `parseRunning` reads
llama-swap's — tolerantly — and decides on status codes and `/health` first.

## What vhotseat teaches, and what we take

vhotseat is a general arbiter: a GPU lock file, per-process VRAM via NVML, a
driver per workload, systemd restarts, a ComfyUI custom node that blocks each
job until the GPU is switched. Most of that solves a problem the bridge does
not have — the bridge is already the one place that both submits ComfyUI work
and knows when the LLM is idle (DESIGN-AGENT-LOOP §2). Four ideas transfer:

1. **A backend is a small contract, chosen by config.** vhotseat's `Workload`
   is `probe / active / release` plus optional `load / busy / model`, and a new
   server joins by config rather than by code. We need the same seam with two
   implementations.
2. **Release means "confirmed free", not "the POST returned".** vhotseat polls
   until the workload's VRAM is at its floor. We already do this for
   llama-swap (poll `/running`); Strata gets the same, via `/health`.
3. **Busy is an answer, not an error to retry blindly.** A 409 means another
   request is mid-turn. vhotseat waits a bounded time (`?wait=`), then refuses
   with a message that says why. A round should do exactly that — and submit
   nothing.
4. **A gate on the LLM's load closes the hazard we documented and left open.**
   DESIGN-AGENT-LOOP §10 lists "something else pings the LLM mid-batch → it
   loads → OOM" as *the main operational hazard*. vhotseat closes it by having
   the LLM server's pre-load hook ask permission. Strata has that hook
   (`before_load`); llama-swap does not. This is optional and comes last (§6).

What we do **not** take: the lock file, NVML, systemd management, restarts,
admission by RAM, or the ComfyUI guard node. ForgeUI never manages the LLM's
process, and ComfyUI's side is already ours.

---

## 1. The seam — `LlmHost`

`src/mcp/llm.ts` (new):

```ts
export type LlmBackend = "llama-swap" | "strata";

export interface LlmHost {
  readonly backend: LlmBackend;
  readonly url: string;
  /** What is resident now — `gpu_status`'s `llm_resident`. Never throws. */
  resident(): Promise<string[]>;
  /** The name a round is attributed to (`origin.source`, §6.2). */
  currentModel(): Promise<string | null>;
  /** Make the GPU free and confirm it, or throw `LlmHostError`. */
  release(): Promise<{ was: string | null }>;
  /** Called once the round is over. A no-op unless `reload: eager`. */
  restore(): Promise<void>;
}
export class LlmHostError extends Error {}
export function createLlmHost(config: LlmConfig, fetch?: typeof fetch): LlmHost | null;
```

- `LlamaSwap` (`src/mcp/llama.ts`) implements it with no behaviour change:
  `running()` → `resident()`, `unload()` → `release()`, `restore()` empty.
  `LlamaSwapError` becomes a subclass of `LlmHostError`.
- `Strata` (`src/mcp/strata.ts`, new) is §2.
- `RoundDeps.llama` and `BridgeToolOptions.llama` become `llm: LlmHost | null`.
  `runRound` calls `llm.release()` where it calls `llama.unload()` today, and
  `llm.restore()` in its `finally`, **after** `free_vram` (order matters — see
  §2, reload).
- `gpu_status` gains `llm_backend` beside `llm_resident` and `llm_model`
  (additive; nothing reads its shape but the model).

`sourceFor` stays as it is: `llm:<model>` regardless of backend.

## 2. The Strata client

`resident()` / `currentModel()`: `GET /health`. Resident is `[model]` when
`loaded` is true, else `[]`. The model name is `config.model` when set (an
operator label wins, as `--llm-model` does today), else `/health`'s `model`,
else the last one seen — same fallback rule as `LlamaSwap.#lastSeen`, and for
the same reason: after an unload there is nothing loaded to ask.

`release()`:

1. Read `currentModel()` first, for the label.
2. `POST /unload?wait=<busy_wait_s>` with an empty JSON body and the bearer
   header. Timeout `busy_wait_s + 30 s` (vhotseat's rule).
3. Outcome by status, then body:
   - 200 and `status` ∈ {`unloaded`, `not loaded`} or no readable body → step 4.
   - 409, or `status: "busy"` → throw `LlmHostError("Strata is still answering
     another request after <n>s; nothing was submitted")`. The round has
     submitted nothing yet, so this costs nothing but the call.
   - 401/403 → throw, naming `llm.api_key`.
   - anything else → throw with code and body.
4. Poll `GET /health` every 250 ms until `loaded` is false, up to
   `unload_timeout_s`. Strata ends the engine process on unload, so this should
   be immediate; the poll is the same floor llama-swap gets, not a guess.

`restore()`, when `reload: eager`: `POST /load`, timeout `max(300 s,
unload_timeout_s)`, errors logged to stderr and never thrown — a failed
pre-warm still leaves Strata's own load-on-request behind it. The default is
`lazy`, which matches llama-swap: return the tool result and let the harness's
next completion load the model.

Why `eager` exists at all: with `min_free_vram_mib` set on Strata's side, a
completion that arrives while ComfyUI is still letting go gets a 503 with
`Retry-After`, and whether the harness retries that is the harness's business.
Loading from the bridge, after `free_vram` has returned, moves that wait to the
one place that knows the GPU has just been handed back. It costs the tool call
~5 s and saves the same on the next completion.

## 3. Configuration — a sixth `config.yaml` block

DESIGN.md §3.1 first (it names "five top-level blocks"; this makes six), then
`src/config/types.ts`, `defaults.ts`, `validate.ts`, `config.ts` merge:

```yaml
llm:
  backend: none          # none | llama-swap | strata
  url: null              # e.g. http://127.0.0.1:8080
  model: null            # llama-swap: the id to unload (all running if null)
                         # strata: a label for origin.source (else /health's model)
  api_key: null          # strata only; bearer token. Never served by GET /api/config
  unload_timeout_s: 60   # how long a release may take to be confirmed
  busy_wait_s: 30        # strata only: ?wait= for a turn already running
  reload: lazy           # lazy | eager (strata only; llama-swap is always lazy)
```

Rules, enforced in `validate.ts`:

- `backend` other than `none` requires `url`.
- `api_key`, `busy_wait_s` and `reload: eager` with `backend: llama-swap` are an
  error rather than silently ignored — a key in the wrong block is a typo
  worth hearing about.
- `api_key` joins `civitai_token` and `huggingface_token` in
  `src/http/routes/config.ts`'s redaction list, and `FORGEUI_LLM_API_KEY` in
  the environment wins over the file, as `CIVITAI_TOKEN` does.

**Who reads it.** `forge mcp` today knows ForgeUI only by URL. It gains
`--data-dir` (default: `resolveDataDir()`, so `FORGEUI_DATA_DIR` works) and
reads `config.yaml` through `loadConfig` — the file, never `app.db`, the same
constraint `forge models` already has and is tested for. If there is no
`config.yaml` the bridge runs with the defaults (`backend: none`) rather than
writing one; the server owns first-run.

Reading the file rather than `GET /api/config` is deliberate: the bridge may
start before ForgeUI, and the endpoint (rightly) never returns the key.

The block is not shown in Settings in this change. `PATCH /api/config` will
accept it because it accepts any valid block; the UI can follow if it is wanted.

## 4. The `forge mcp` flags

| Flag | Meaning |
| --- | --- |
| `--llm-backend <none\|llama-swap\|strata>` | overrides `llm.backend` |
| `--llm-url <url>` | overrides `llm.url` |
| `--llm-model <id>` | overrides `llm.model` (exists today) |
| `--llm-api-key <key>` | overrides `llm.api_key` (prefer the env var) |
| `--llm-reload <lazy\|eager>` | overrides `llm.reload` |
| `--llama-swap <url>` | kept: shorthand for `--llm-backend llama-swap --llm-url <url>` |
| `--strata <url>` | new shorthand for `--llm-backend strata --llm-url <url>` |
| `--data-dir <path>` | where `config.yaml` is |

Precedence is the server's: flags > `config.yaml` > defaults, applied as a
`PartialConfig` override layer through `effectiveConfig`, never written back.
`--llama-swap` together with `--strata`, or either together with a
contradicting `--llm-backend`, exits 2. Existing launchers that pass only
`--llama-swap` keep working unchanged. The startup line names the backend:
`…, strata at http://127.0.0.1:2335`.

## 5. Tests — `deno task test` needs neither server

- `tests/unit/mcp_strata_test.ts`, with a scripted fake `fetch` in the style
  of `mcp_llama_test.ts`: 200 `unloaded`; 200 `not loaded`; 200 with no body;
  409 → refused with the busy message; `status: "busy"` in a 200; 401 names
  the key; `/health` still `loaded: true` past the timeout → refused; the
  bearer header is sent on every call; the model label comes from config, then
  `/health`, then the last seen; `?wait=` carries `busy_wait_s`; `reload:
  eager` posts `/load` and a failing `/load` does not throw.
- `tests/integration/mcp_round_test.ts`: the existing ordering test
  (unload before the first submit) runs once per backend; a busy Strata
  submits **nothing**; with `reload: eager` the calls read
  `unload, …submits…, free_vram, load` in that order.
- `tests/unit/config_test.ts`: the `llm` block's defaults, merge, and each
  validation rule; `tests/integration`: `GET /api/config` never contains
  `api_key`.
- A CLI-resolution test (a pure function from flags + `PartialConfig` to
  `LlmConfig | null`, so it needs no process): precedence, the shorthands, the
  conflicts.
- `tests/unit/mcp_llama_test.ts` unchanged apart from the renamed methods —
  the proof the refactor changed no llama-swap behaviour.

There is no contract test against a real Strata; it needs a GPU and a 30 GB
model, which is outside what `docs/HARDWARE-CHECKLIST.md` provisions. Instead
MCP-BRIDGE.md gets a "check it the way the bridge will" block for Strata
(`curl /health`, `curl -X POST '/unload?wait=30'`), as §2 has for llama-swap.

## 6. Later, optional — a load gate for Strata

The cheap mitigation §10 asks for, done the vhotseat way. `forge mcp gate`
(a subcommand, exits 0 to allow, 1 to refuse, in under a second) asks the
bridge `GET /gate` on its HTTP listener, which answers "refuse" while a round
is between `release()` and `free_vram`, and — the part the bridge cannot do
today — asks ForgeUI `GET /api/system/status` and refuses while ComfyUI has
jobs running or queued, which covers the web-UI row in §10 as well. Wired in
Strata's model config:

```json
"before_load": "forge mcp gate --bridge http://127.0.0.1:7801",
"before_load_timeout_s": 10,
"before_load_strict": true
```

A refused load is Strata's 503 with `Retry-After`; the harness retries it. The
bridge's own `restore()` load bypasses the gate, because the gate allows while
no round is held and `restore()` runs after the hold ends. This is its own
change, after 1–5, and stays out of the default path: a gate that fails closed
on a misconfiguration stops the LLM from loading at all.

Also later: Strata's `POST /v1/vram {"reserve_mib": N}` (partial release, with
`vram_elastic`) would let a small SDXL round run without unloading the model at
all. Worth a look once rounds carry a VRAM estimate; not before.

## 7. Order of work

1. DESIGN.md §3.1 and this doc's decisions into DESIGN-AGENT-LOOP (§5.2's
   step 1–2 become backend-neutral, §8 gains a Strata table, §10's hazard row
   names the gate).
2. The `LlmHost` seam; `LlamaSwap` behind it; all existing tests green with no
   behaviour change.
3. The `llm` config block, validation, redaction, env var.
4. `forge mcp` reads `config.yaml` and the new flags; `--llama-swap` stays.
5. `Strata`, its unit tests, the per-backend round tests.
6. MCP-BRIDGE.md: a Strata section beside §2, and the launcher examples using
   `config.yaml` instead of flags. AGENTS.md: "never needs llama-swap" becomes
   "never needs llama-swap or Strata".
7. (Optional) §6, the gate.

## Open questions

- **Should the bridge read `config.yaml` at all**, or keep the whole LLM side
  on its command line? Reading it is what was asked for and keeps the API key
  out of process listings; the cost is that the bridge now needs the data dir,
  which ties it to running on the same machine as ForgeUI's files.
- **Default for `busy_wait_s`.** 30 s keeps a round from hanging on someone
  else's long completion; vhotseat lets the caller choose up to 300 s. With one
  harness and `--parallel 1` the LLM is idle by construction when a tool call
  arrives (DESIGN-AGENT-LOOP §2), so this only matters with a second client.
