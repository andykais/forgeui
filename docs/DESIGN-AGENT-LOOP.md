# Design — an LLM drives ForgeUI, and they take turns with the GPU

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §4.6 (manifest), §7.1 (telemetry), §12 (API), and a new
§13 for the MCP surface.
**Lands in this repo:** the MCP server, two routes, one manifest field, config.
**Does not land in this repo:** llama-swap, the runner, the harness. They are
described here so the whole loop is legible from one document, and so the
contract ForgeUI has to keep is written down next to the thing that keeps it.

---

## The problem

One 32GB card, two tenants. ForgeUI's ComfyUI wants all of it for a Flux-class
or video workflow; a 27B VLM at Q4 wants ~18GB and will not give it back. They
cannot both be resident, so the loop — *write a prompt, generate, look at the
result, write a better prompt* — has to be a loop in which **the GPU changes
hands twice per round**.

The naive fix is to make ForgeUI the arbiter: it already owns the ComfyUI child
process, already samples VRAM (§7.1), already has a config file. It would be a
natural home and it is the wrong one. ForgeUI would grow a scheduler, a policy
for a process it does not own, and a hard dependency on a particular LLM
runtime. This design keeps ForgeUI a media generation service that can *let go
of the GPU when asked*, and puts the sequencing outside.

---

## 1. The shape

Four processes, three of them already exist:

| Component | Where | Owns | In this repo |
| --- | --- | --- | --- |
| **ForgeUI** | 5090 box | ComfyUI, the gallery, the MCP surface | yes |
| **llama-swap** | 5090 box | loading and evicting the VLM | no |
| **The harness** | anywhere | the conversation, the tool loop | no |
| **The runner** | with the harness | one tool: the GPU-exclusive batch | no |

And the division that makes it work:

- **The MCP server is the catalogue and the media.** Every call is fast and
  happens while the model is resident: what workflows exist, what params they
  take, how to prompt this family, what is in the gallery, show me this output.
- **The runner is the long operation.** One tool, one job: evict the model,
  submit the batch, watch it finish, hand the GPU back. It is the only
  component that can see both tenants, so it is the only one that sequences
  them.

Nothing arbitrates. Each side can be *told to let go*, and the runner does the
telling.

---

## 2. The hinge: a tool call is when the model is idle

The thing that makes this tractable, and the reason it needs so little code:

**When the model emits a tool call, its turn is over.** The harness is holding
a tool result it has not produced yet; the model is not generating, is not
being sampled, and is doing nothing but occupying VRAM. That is exactly the
moment it is safe to evict.

And llama-swap already handles the way back. It loads a model on demand when a
request arrives for one that is not running. So:

- **Unloading** is one POST from the runner.
- **Waking the model back up** is *not implemented by anything*. The harness
  posts the next chat completion with the tool result attached, llama-swap sees
  a request for a model that is not loaded, and loads it. The runner never
  "wakes" anything — it just returns.

The whole handoff is therefore one explicit call and one thing that happens by
itself.

---

## 3. The round trip

```
 model          runner                 llama-swap            ForgeUI / Comfy
   │               │                       │                       │
   │ (resident, ~18GB)                     │                       │
   ├─ MCP: describe_workflow ──────────────┼──────────────────────▶│  fast
   │◀─ params + prompting guide ───────────┼───────────────────────┤  reads
   │                                       │                       │
   ├─ tool: render([p1..pN]) ─────────────▶│                       │
   │  ── turn over, model idle ──          │                       │
   │               ├─ POST /api/models/unload ─▶│                  │
   │               ├─ GET /running until empty ▶│                  │
   │            (GPU free)                 │                       │
   │               ├─ POST /api/jobs ×N ───┼──────────────────────▶│
   │               ├─ WS /ws: job events ──┼──────────────────────▶│  minutes
   │               │  …until N terminal    │                       │
   │               ├─ POST /api/system/free_vram ─────────────────▶│
   │               │                    (GPU free)                 │
   │◀─ tool result: ids, status, timings ──┤                       │
   │  ── harness posts next completion ──  │                       │
   │               │      llama-swap loads on demand ──▶(resident) │
   ├─ MCP: get_output_image(id, 768) ──────┼──────────────────────▶│
   │◀─ image content block ────────────────┼───────────────────────┤
   │  …critique, next batch                │                       │
```

Two evictions per round, not per image — which is why the runner takes a
**batch**. Six variants cost the same two handoffs as one.

---

## 4. What ForgeUI gains

Small, and all of it in ForgeUI's existing idiom.

### 4.1 The MCP server — `src/mcp/`

Served by the same Deno process on the same port, at `/mcp`, over Streamable
HTTP. Not stdio: ForgeUI is a long-running server, not something a harness
spawns as a child, and the harness may be on another machine.

| Tool | Returns | Why |
| --- | --- | --- |
| `list_workflows` | id, name, family, kind | what can be made |
| `describe_workflow` | params with types, ranges, defaults, **and the prompting guide** | the model cannot guess that Illustrious wants tags and Krea wants prose |
| `list_models` | checkpoints and LoRAs, by display name (§8.1) | so a prompt can name a LoRA |
| `search_gallery` | outputs under the §11.2 filters | find prior work to compare against |
| `get_output` | the sidecar: params, seed, model, timings | read back exactly what produced a take |
| `get_output_image` | an **image content block**, downscaled | this is what "look at it" means |

`get_output_image` takes `max_edge` (default 768) and serves a resized JPEG.
This is not a nicety: vision tokens land in the same VRAM budget as the model,
and a 1024² image is several times the tokens of a 768px one for no critique
value. ForgeUI already makes thumbnails, so the machinery exists.

**`generate` is deliberately not an MCP tool.** Submitting is easy; *waiting*
is the problem, and a tool call that blocks for four minutes while holding the
GPU hostage is the thing this design exists to avoid. Generation belongs to the
runner, which can evict first. See §7.

### 4.2 `POST /api/system/free_vram`

Asks ComfyUI to drop its models (`POST /free` with `unload_models` and
`free_memory`). ForgeUI owns that child process, so ForgeUI owns the verb — but
it is a verb, not a policy. The runner decides *when*; ForgeUI only knows how.

A later convenience could be `comfy.free_vram_when_idle` in `config.yaml`,
firing when the queue drains. It is not needed for this design and should not
be added before someone wants it.

### 4.3 `prompting` on the manifest — DESIGN.md §4.6 first

The per-family guidance is the genuinely valuable half of this work and it
belongs next to the workflow it describes, in `workflows/bundled/<id>/`, not in
a skill file that drifts from the manifest. `describe_workflow` serves it, so
any client gets it without a separate install.

Per the repo's own rule: the field goes in DESIGN.md before it goes in code.

### 4.4 Config

```yaml
mcp:
  enabled: false        # off by default; it is a control surface
  token: null           # shared secret, required when enabled
```

`/mcp` is an unauthenticated control surface on a listening port if we are not
careful. A bearer token checked in the router is the minimum; binding to
localhost or the LAN interface is the operator's job, as with `server.host`.

### 4.5 Tests

Per the repo's convention — through the interface, not the internals:

- an integration test that speaks MCP over `/mcp` and lists workflows;
- `get_output_image` returns an image block within `max_edge`;
- `free_vram` calls the fake ComfyUI's `/free` (a new scenario in
  `tests/fake-comfy/`);
- `/mcp` 401s without the token.

---

## 5. What llama-swap does — as it works today

A proxy in front of `llama-server` with the model defined in its config:

```yaml
models:
  qwen-vlm:
    cmd: >
      llama-server --port ${PORT}
      --model /models/Qwen3.5-9B-Q4_K_M.gguf
      --mmproj /models/mmproj-F16.gguf
      -c 16384 -ctk q8_0 -ctv q8_0
    ttl: 0            # never unload on idle; the runner decides
    unloadTimeout: 30 # seconds to stop gracefully
```

The endpoints the runner uses:

| Call | Effect |
| --- | --- |
| `POST /api/models/unload` | unload everything running |
| `POST /api/models/unload/:model_id` | unload one |
| `GET /running` | what is resident — the runner polls this to confirm |
| any `/v1/chat/completions` | **loads the model if it is not running** |

`ttl: 0` is deliberate. An idle timeout would race the runner: the model could
evict itself mid-conversation and reload during a batch. Explicit control from
one place is easier to reason about than two timers.

---

## 6. What the runner does — the one thing not in this repo

A script, ~150 lines, next to the harness. It exposes one tool to the model:

```
render(prompts: [{workflow_id, params}], timeout_s) -> [{job_id, status, output_ids, error?}]
```

and does, in order:

1. `POST /api/models/unload` to llama-swap.
2. Poll `GET /running` until empty, or give up and fail loudly — submitting
   while the VLM still holds 18GB is how you get an OOM that looks like a
   ComfyUI bug.
3. Open the ForgeUI WebSocket **before** submitting. Opening it after is a race
   that loses the completion of a fast job.
4. `POST /api/jobs` once per prompt (§12 — one job per call), collecting ids.
5. Read `job` events until every id is terminal. Terminal means `status` is
   `done`, `failed` or `cancelled`; `done` carries `outputs[]`.
6. `POST /api/system/free_vram`.
7. Return a compact result. **Not images** — ids, statuses, timings, errors.
   The model asks for the pictures it wants via `get_output_image` once it is
   resident again, which keeps the context small and lets it choose.

The model writes no scripts. `render` is a fixed tool with a schema, because a
model that writes a fresh WebSocket client each round will eventually write one
that hangs, and it will hang holding the GPU.

---

## 7. Why `render` is not MCP

Worth stating plainly, because putting everything behind one protocol is
tempting.

The runner must evict the model that is calling it. An MCP server inside
ForgeUI cannot do that without ForgeUI taking a dependency on llama-swap —
which is exactly the coupling this design refuses. The runner sits on the
harness side because that is the only vantage point from which both tenants are
visible.

The consequence is two consumers speaking two protocols: the **model** speaks
MCP (catalogue and media), the **runner** speaks plain REST and WebSocket
(submit and watch). That is not duplication — they want different things, at
different times, with different lifetimes.

---

## 8. Failure modes

| What happens | Result | What handles it |
| --- | --- | --- |
| WS drops mid-batch | runner reconnects, then reconciles each id with `GET /api/jobs/:id` | jobs have terminal state in the DB; nothing is lost by a dropped socket |
| A job fails | returned as `failed` with the error text | the model can retry smaller, or change workflow |
| Batch exceeds `timeout_s` | runner cancels via `POST /api/jobs/:id/cancel`, returns partial | never hang holding the GPU |
| Something pings llama-server mid-batch | llama-swap loads the model → OOM | **the main operational hazard.** One client only; a lock file the runner holds is the cheap mitigation |
| ComfyUI OOMs anyway | job fails with Comfy's error | surfaced to the model; retry at a smaller size |
| Runner crashes while the model is unloaded | harmless | next completion reloads it |
| Model reload cost | seconds, not minutes | llama.cpp mmaps; with RAM to spare the weights stay in page cache |

The one that will actually bite is row four. It is worth a line in the runner's
README: **while a batch is running, nothing else may talk to llama-swap.**

---

## 9. What this does not solve

- **Latency.** Two evictions and two loads per round. Batching amortises it;
  nothing removes it. If the loop needs to feel interactive, the answer is a
  second GPU, not a better scheduler.
- **Taste.** A 9B VLM will spot a sixth finger and miss that the composition is
  boring. The prompting guides (§4.3) carry more of the quality than the model
  size does.
- **Concurrent use.** While a loop is running, the human cannot generate from
  the UI without joining the queue — which is correct, but means the loop is a
  thing you start and leave, not something running in the background while you
  work.

---

## 10. Order of work

1. §4.3 — `prompting` on the manifest, DESIGN.md first. Useful on its own, and
   independent of everything else here.
2. §4.1 — the MCP server, read-only tools plus `get_output_image`. Testable
   against any MCP client with vision, with no VRAM dance at all.
3. §4.2 — `free_vram`, with a fake-comfy scenario.
4. The runner and the llama-swap config, outside this repo.

Steps 1–3 are worth having whether or not the local VLM ever works out: they
are what lets *any* model drive ForgeUI. Step 4 is the part that is specific to
sharing one card, and it is the part that can be thrown away and replaced with
a hosted model, a second GPU, or a second machine without touching the rest.
