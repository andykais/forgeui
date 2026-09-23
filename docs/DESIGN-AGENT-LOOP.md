# Design — an LLM drives ForgeUI, and they take turns with the GPU

**Status:** part built. §5 — the bridge, `forge mcp` — is implemented and
tested; the runbook is `MCP-BRIDGE.md`. §6 (the batch API, job `origin`, the
two routes, the manifest field) and §7 (the gallery) are still proposals, and
the bridge is written against today's API until they land: it submits one job
per call and watches `job` events rather than a `batch` event, and sends
`origin` in the body, which ForgeUI currently ignores.
**Touches:** DESIGN.md §4.6 (manifest), §6.2 (sidecar), §7 (schema), §11.2
(gallery filters), §12 (API).
**Lands in ForgeUI the server:** the batch API, job origin, two routes, one
manifest field. No MCP, no auth, no knowledge of any LLM.
**Lands beside it:** `forgeui-mcp`, a separate process — the bridge. It holds
everything about the model and the GPU handoff.

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
runtime.

So the arbitration goes in a **third process that is nobody's dependency**, and
which happens to be the MCP server the model already talks to.

---

## 1. The shape

| Component | Where | Owns |
| --- | --- | --- |
| **ForgeUI** | 5090 box | ComfyUI, the gallery, a REST + WS API. Knows nothing about LLMs |
| **llama-swap** | 5090 box | loading and evicting the VLM |
| **the bridge** (`forgeui-mcp`) | 5090 box | the MCP server, and the GPU handoff |
| **the harness** | anywhere | the conversation, the tool loop |

The bridge is the only component that can see both tenants, so it is the only
one that sequences them. It talks plain REST and WebSocket to ForgeUI, plain
HTTP to llama-swap, and MCP to the harness. Neither of the two things it
arbitrates knows it exists.

**Every verb the model has is an MCP tool, including `generate`.** There is no
second mechanism, no local script, nothing to describe by hand. See §5.

---

## 2. The hinge: a tool call is when the model is idle

The thing that makes this tractable, and the reason it needs so little code:

**When the model emits a tool call, its turn is over.** The harness is holding
a tool result it has not produced yet; the model is not generating, is not
being sampled, and is doing nothing but occupying VRAM. That is exactly the
moment it is safe to evict — and it is true whether the tool takes 50ms or four
minutes.

And llama-swap already handles the way back. It loads a model on demand when a
request arrives for one that is not running. So:

- **Unloading** is one POST from the bridge.
- **Waking the model back up** is *not implemented by anything*. The harness
  posts the next chat completion with the tool result attached, llama-swap sees
  a request for a model that is not loaded, and loads it. The bridge never
  "wakes" anything — it just returns.

The whole handoff is one explicit call and one thing that happens by itself.

---

## 3. Why the bridge, and not the two obvious alternatives

An earlier revision of this document had `generate` *not* be an MCP tool, on
the grounds that a tool call which blocks for four minutes holds the GPU
hostage. **That was wrong**, and §2 is the reason: the model is idle for the
whole of any tool call, so the duration of the call costs nothing. What was
actually true was narrower — *ForgeUI's in-process MCP server* could not evict
the model, because that would make ForgeUI depend on llama-swap.

Moving the MCP server out of ForgeUI dissolves the problem rather than working
around it:

| | MCP inside ForgeUI | A local runner script | **The bridge** |
| --- | --- | --- | --- |
| Can evict the LLM | no — would couple ForgeUI to llama-swap | yes | **yes** |
| `generate` is a normal tool | no | no — a second, hand-described mechanism | **yes** |
| Things to install | 1 | 2 | **1** |
| ForgeUI knows about LLMs | yes | no | **no** |

The runner-script version also had a subtler cost: two ways for the model to
act on the world, one discovered through MCP and one described in a prompt. The
described one drifts. This has one.

---

## 4. The round trip

```
 model            bridge (forgeui-mcp)      llama-swap          ForgeUI / Comfy
   │                    │                       │                      │
   │ (resident, ~18GB)  │                       │                      │
   ├─ describe_workflow ▶│─ GET /api/workflows/:id ─────────────────────▶│
   │◀─ params + guide ──┤                       │                      │
   │                    │                       │                      │
   ├─ generate([…]) ───▶│                       │                      │
   │  ── turn over, model idle ──               │                      │
   │                    ├─ POST /api/models/unload ─▶│                 │
   │                    ├─ GET /running until empty ▶│                 │
   │                 (GPU free)                 │                      │
   │                    ├─ POST /api/jobs/batch ─────────────────────▶ │
   │  (model unloaded — sees nothing until the call returns)           │
   │                    │◀─ WS: one `batch` event ───────────────────── │
   │                    ├─ POST /api/system/free_vram ───────────────▶ │
   │                 (GPU free)                 │                      │
   │◀─ tool result: batch_id, counts, ids ──────┤                      │
   │  ── harness posts next completion ──       │                      │
   │                    │   llama-swap loads on demand ─▶ (resident)    │
   ├─ get_output_image ▶│─ GET …/media?max_edge=768 ──────────────────▶│
   │◀─ image block ─────┤                       │                      │
   │  …critique, next generate()                │                      │
```

Two evictions per round, not per image — which is why `generate` takes a
**batch**. Six variants cost the same two handoffs as one.

---

## 5. The bridge — `forgeui-mcp`

A CLI that starts an MCP server and nothing else. One process, started by hand
or by systemd, pointed at ForgeUI and llama-swap:

```
forgeui-mcp --http 127.0.0.1:7801 \
            --forgeui http://127.0.0.1:7860 \
            --llama-swap http://127.0.0.1:8080 --llm-model qwen-vlm
```

`--stdio` instead of `--http` when the harness runs on the same box and would
rather launch it as a subprocess. The same server implementation serves both
bindings; the protocol is identical either way.

### 5.1 Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_workflows` | proxies `GET /api/workflows` | fast |
| `describe_workflow` | params with types, ranges, defaults, **and the prompting guide** (§6.4) | fast |
| `list_models` | checkpoints and LoRAs by display name (§8.1) | fast |
| `search_gallery` | outputs under the §11.2 filters, including `project` and `source` | fast |
| `get_output` | the sidecar: params, seed, models, timings, origin | fast |
| `get_output_image` | an **image content block**, downscaled | fast |
| `gpu_status` | what is resident, and how much VRAM is free | fast |
| **`generate`** | the round: evict, submit the batch, wait, free, report | **minutes** |

Only the last one is special, and only in how long it takes.

`gpu_status` exists because the bridge is the only thing that can answer it,
and because a model that can ask *"is there room for a video workflow right
now"* makes better choices than one that submits and finds out.

### 5.2 `generate`

*Built.* Two things learned from making it run that the design had wrong:
media is fetched via the output row's own `media_url` (§12 serves everything
from `/api/media/<path>`, so a constructed URL 404s), and a rollback has to
*wait* for its cancellations — `POST /cancel` returns before ComfyUI has torn
the job down, so returning on the ask hands back a GPU that is still busy.


```jsonc
generate({
  project: "kitchen-lighting",          // groups the round (§6.2)
  note: "round 3 — LoRA ceiling",
  jobs: [
    { workflow_id: "illustrious", params: {…}, note: "0.7" },
    { workflow_id: "illustrious", params: {…}, note: "0.9" }
  ],
  wait: true,                            // default
  timeout_s: 900
})
→ { batch_id, counts: {done, failed, cancelled}, jobs: [{job_id, status, output_ids, error?}] }
```

**No `source` parameter, on purpose.** The bridge adds it on the way out
(§6.2); there is no argument here through which the model could set it.

In order, the bridge:

1. `POST /api/models/unload` to llama-swap.
2. Polls `GET /running` until empty, or fails loudly. Submitting while the VLM
   still holds 18GB is how you get an OOM that looks like a ComfyUI bug.
3. Opens ForgeUI's WebSocket **before** submitting. After is a race that loses
   the completion of a fast job.
4. `POST /api/jobs/batch` once, adding its own `source` — all-or-nothing
   (§6.1), one `batch_id` back.
5. Waits for the single `batch` event. Nothing to relay and nobody to relay
   it to — the model is unloaded until this call returns (§5.3).
6. `POST /api/system/free_vram`.
7. Returns ids, statuses and errors — **not images**. The model asks for the
   pictures it wants with `get_output_image` once it is resident again, which
   keeps the context small and lets it choose.

### 5.3 Long calls: two different timeouts, and who is watching

A four-minute tool call is fine for the *model* — §2, it is idle throughout —
and awkward for the machinery around it. Two distinct things can cut the call
off, they have different fixes, and conflating them produces mechanisms that
do not help:

**The transport idle timeout.** A reverse proxy, or the OS, closes a
connection that has carried no bytes for N seconds. Fixed at the transport
layer: the bridge writes an SSE comment every 15s on the response stream.
Standard practice, invisible to the JSON-RPC layer, costs nothing. Always on.

**The client's own request timeout.** The MCP client has a deadline for
`tools/call`. Nothing the server sends can *make* it wait longer — so the fix
is configuration: **the harness's MCP timeout must exceed the longest batch you
intend to run.** This is a documented requirement of running the bridge, not
something to engineer around. Where it cannot be configured, `wait: false`
returns `{batch_id}` immediately and `generate_status(id)` polls; it costs a
round of model time per poll, which is why it is not the default.

**Progress notifications are not a timeout mechanism, and the model never sees
them.** They go to the MCP *client*, and the model is unloaded for the whole
call. The spec defines `notifications/progress` against a `progressToken` but
does not require a client to extend any deadline on receiving one, so relying
on that would be relying on a behaviour nobody promised. They are therefore
**off by default and exist for one audience: a human watching a harness that
renders them.** `--progress` turns them on, the bridge relays ForgeUI's per-job
events as `3/6`, and if your harness prints nothing, leave them off — the
bridge does not need per-job events for anything else. It waits on the single
`batch` event.

**Cancellation is real and is not optional.** On Streamable HTTP a client
abandons a request by closing the response stream; when that happens the bridge
calls `POST /api/jobs/batch/:id/cancel`. Without it, a client that timed out
leaves the GPU working on results nobody will read — which matters far more
here than anywhere else, because that GPU is also the one the model needs back.

### 5.4 Where it lives, and what it depends on

*Built as described.* `src/mcp/`, run as `forge mcp`, sharing the repo and
nothing else — `deno task test` does not need llama-swap, and the fake in the
tests stands in for it.

Two dependencies came with it, both deviations from "Deno std only": **Cliffy**
for the command line, and **`@modelcontextprotocol/server`** for the protocol.
The second was going to be hand-rolled — the surface used here is small — until
the spec's 2026-07-28 revision turned out to have dropped the `initialize`
handshake for per-request `_meta` and a mandatory `server/discover`, with a
dual-era compatibility matrix behind it. That is a protocol implementation, not
a hundred lines of JSON-RPC, and it is exactly what an SDK is for.



Same repository, separate entrypoint (`deno task mcp`), separate process. The
alternative — its own repo — buys independence that one person on one box does
not need yet, and costs a second clone and a second update path.

The line that keeps this honest is the test suite: **`deno task test` must
never need llama-swap.** The bridge's arbitration goes behind an interface with
a fake in tests, exactly as `tests/fake-comfy/` stands in for ComfyUI. If that
ever becomes hard to hold, the bridge has earned its own repo and should move.

---

## 6. What ForgeUI gains

Smaller than the previous revision, because the MCP server left.

### 6.1 The batch API

`POST /api/jobs` stays one job per call — the UI wants it that way. The bridge
gets a second door:

```
POST /api/jobs/batch
{
  "origin": {
    "source": "llm:qwen3.5-9b",
    "project": "kitchen-lighting",
    "note": "round 3 — LoRA ceiling"
  },
  "jobs": [
    { "workflow_id": "illustrious", "params": {…}, "note": "0.7" },
    { "workflow_id": "illustrious", "params": {…}, "note": "0.9" }
  ]
}
→ 201 { "batch_id": "01J…", "job_ids": ["01J…", "01J…"] }
```

**All or nothing.** Every job's params are coerced and validated before any of
them is enqueued; one bad value fails the whole call, naming the index and the
param. That is the reason for the endpoint to exist — six separate `POST
/api/jobs` calls can leave three jobs running and three rejected, and then the
bridge has to decide what half a round means. It should never have to.

| Route | |
| --- | --- |
| `POST /api/jobs/batch` | submit; 201 with the batch id and the job ids |
| `GET /api/jobs/batch/:id` | the batch and every job in it |
| `POST /api/jobs/batch/:id/cancel` | cancel whatever is left |

**One WebSocket event, at the end.** A `batch` event fires when every job in it
has reached a terminal state, carrying exactly what `GET /api/jobs/batch/:id`
returns — the §12 rule that websocket payloads share the API's shapes.

```json
{ "type": "batch", "data": {
  "batch_id": "01J…", "status": "complete",
  "counts": { "done": 4, "failed": 2, "cancelled": 0 },
  "origin": { … },
  "jobs": [ { "id": "01J…", "status": "done", "outputs": ["01J…-0"] }, … ]
} }
```

Three things that matter more than they look:

- **It fires when every job is terminal, not when every job succeeds.** A batch
  where all six fail still fires. Anything else is a bridge that hangs holding
  the GPU, which is the failure this design is organised against.
- **It fires exactly once.** The check runs on every job transition, so the
  batch row carries the fact that it has been announced, and the second
  transition to arrive finds it already set.
- **`counts` rather than a verdict.** "4 done, 2 failed" is a fact; "partial"
  is a judgement, and the bridge is better placed to make it than we are.

Per-job `job` events keep firing as they do today — the batch event is in
addition, not instead. The UI still wants to watch a queue drain. The bridge
does not: it waits on the one event and ignores the rest, unless `--progress`
is on for a human's benefit (§5.3).

### 6.2 Where a job came from, and what it was for

```json
"origin": {
  "source": "llm:qwen3.5-9b",
  "batch_id": "01J…",
  "project": "kitchen-lighting",
  "note": "round 3 — pushing the LoRA past 0.9 to find where it breaks",
  "meta": { }
}
```

A **sidecar** field (DESIGN.md §6.2), not only a column. The repo's rule is
that anything stored only in the database about an output must also go in the
sidecar, and provenance is the clearest case there will ever be: a note saying
why a take exists is worthless if `deno task reindex` throws it away. The
outputs table gets `source` and `project` as derived, indexed columns because
they are filtered on; the sidecar holds all of it.

Pleasant consequence: since each sidecar carries `batch_id`, batch membership
is rebuildable from disk too.

#### `source` is an ordinary field, sent by whoever calls

Every client names itself. The web UI sends `"webui"`; the bridge sends
`"llm:qwen3.5-9b"`, hardcoded in the bridge. **Absent means `"unknown"`** — not
`"webui"`, because a script that forgets to identify itself must not be
recorded as you. Same reasoning as the pre-existing outputs in §11: the record
says what it knows and no more.

ForgeUI trims it, caps its length and stores it. There is no allow-list, no
token, and no authentication — **ForgeUI has none at all**, and adding some for
this one field would have been theatre: anyone who can POST a job can already
delete the gallery. Protecting the label while leaving the door open protects
nothing.

**What keeps the model from setting it is the bridge's tool schema, not the
server.** `generate` (§5.2) exposes `project`, `note` and `jobs`. It does not
expose `source`, so there is no argument through which the model could set it;
the bridge fills it in as code, on the way out. A model cannot pass a parameter
that does not exist.

So `source` is a claim, and on a single-user LAN box that is the right trade:
the job is **labelling**, not attribution under attack. If ForgeUI ever grows
real auth, deriving `source` from the credential is the upgrade — but it should
arrive with the auth, not before it.

#### `project` gets a column, `note` does not

"iteration #3 on kitchen-project" is two fields wearing one sentence. The
grouping key is what you filter and navigate by; the prose is what you read.

- **`project`** — indexed, a gallery filter chip (§11.2), normalised on write
  (trimmed, length-capped), because a grouping key has to be stable to group.
- **`note`** — free text, capped at 2KB, shown in the metadata sidebar and
  covered by the gallery's existing `q` search. Being able to find *"where was
  I testing the LoRA limits"* is most of the value.
- **`meta`** — an opaque object for whatever the bridge wants to keep, capped
  at 8KB, never indexed, never parsed. An escape hatch, so the schema does not
  have to guess right the first time.

**No `iteration` field, deliberately.** A batch already orders its own jobs and
`project` plus `created_at` already orders the rounds. An integer the model has
to remember to increment is one it will eventually get wrong, and then the
record is worse than no record.

Batch `origin` applies to every job in it; a job's own `note` is appended
rather than replacing the batch's. `batch_id` is the server's and is never
settable; `source` is set once for the batch, not per job — one call comes from
one client.

### 6.3 Two routes

- **`POST /api/system/free_vram`** — asks ComfyUI to drop its models (`POST
  /free` with `unload_models` and `free_memory`). ForgeUI owns that child
  process, so ForgeUI owns the verb. It is a verb, not a policy: the bridge
  decides when.
- **`?max_edge=` on the media route** — serves a resized frame. Not a nicety:
  vision tokens land in the same VRAM budget as the model, and a 1024² image
  costs several times a 768px one for no critique value. The existing
  `thumb_url` is not a substitute — tile thumbnails are square-cropped, and
  cropping out the composition is exactly wrong for a model being asked about
  composition. ffmpeg is already a dependency.

### 6.4 `prompting` on the manifest — DESIGN.md §4.6 first

The per-family guidance is the genuinely valuable half of this work, and it
belongs next to the workflow it describes, in `workflows/bundled/<id>/`, not in
a prompt file that drifts from the manifest. `describe_workflow` serves it, so
the model gets it at the moment it needs it without a separate install.

Per the repo's own rule: the field goes in DESIGN.md before it goes in code.

### 6.5 Tests

Through the interface, not the internals:

- a batch with one invalid param enqueues **nothing**, and says which job and
  which param;
- the `batch` event fires once when the last job lands — with a scenario where
  every job fails, because that is the case a naive implementation drops;
- `origin` round-trips: submit with a project and a note, rebuild the database
  from the sidecars with `reindex`, and the filters still find it. This is the
  test that proves the sidecar rule was honoured rather than described;
- a job submitted without a `source` records `unknown`, not `webui`;
- `free_vram` calls the fake ComfyUI's `/free` (a new scenario in
  `tests/fake-comfy/`);
- `?max_edge=` returns an image within the bound, uncropped.

And for the bridge, against a fake llama-swap and the existing fake ComfyUI:
`generate` unloads before submitting, cancels the batch when the MCP request is
abandoned, and returns counts when every job fails.

---

## 7. What the gallery gains

Metadata nobody can see is metadata nobody writes correctly. The payoff is in
§11.2 and it is small:

- **filter chips for `source` and `project`** beside the existing ones — *show
  me only what the model made*, *show me this project*;
- **a mark on the tile** for outputs that were not made by hand;
- **the note, the project and the source in the metadata sidebar**, with the
  batch's siblings reachable from it — lineage (§11.2) records parents and
  children, and a batch is the sibling relationship it has no way to express.

Without those, `origin` is a write-only field and will rot.

---

## 8. llama-swap — as it works today

```yaml
models:
  qwen-vlm:
    cmd: >
      llama-server --port ${PORT}
      --model /models/Qwen3.5-9B-Q4_K_M.gguf
      --mmproj /models/mmproj-F16.gguf
      -c 16384 -ctk q8_0 -ctv q8_0
    ttl: 1800          # a backstop, not the mechanism
    unloadTimeout: 30
```

| Call | Effect |
| --- | --- |
| `POST /api/models/unload` | unload everything running |
| `POST /api/models/unload/:model_id` | unload one |
| `GET /running` | what is resident — the bridge polls this to confirm |
| any `/v1/chat/completions` | **loads the model if it is not running** |

`ttl` is a **backstop**, deliberately generous. The bridge evicts explicitly,
so the timer is never the mechanism — but a loop you walked away from leaves
the model resident, and then your own first generation from the web UI OOMs.
Half an hour is long enough never to race a round of thinking and short enough
to have let go by the time you sit back down. `ttl: 0` would be purer and would
leave that footgun armed.

---

## 9. How the model learns to use any of this

Three layers, and only the third is a "skill":

1. **The tools are discovered, not described.** The harness calls `tools/list`
   at connect and gets names, descriptions and JSON schemas. Nothing is
   explained by hand, nothing is re-pasted per session, and a tool that changes
   shape cannot drift out of sync with its description because the description
   *is* the server's.
2. **The per-workflow knowledge arrives at call time**, from
   `describe_workflow` (§6.4) — that Illustrious wants tags and weights, that
   Krea wants prose, that ACE-Step wants structured lyrics. It travels with the
   workflow, so it is right for the workflow the model actually picked.
3. **A skill, if you want one, carries strategy** — and only strategy. *Ask for
   a batch of variants rather than one image at a time. Look before iterating.
   Give the round a project name and say what you were testing. Stop when two
   rounds stop improving.* That is a page of prose that has nothing to do with
   ForgeUI's API, applies to any media backend, and is the only part worth
   writing by hand.

So: not a script you describe each time, and not a skill that wraps the
mechanics. A skill is optional, and it is about taste.

---

## 10. Failure modes

| What happens | Result | What handles it |
| --- | --- | --- |
| WS drops mid-batch | bridge reconnects, reconciles with `GET /api/jobs/batch/:id` | one call instead of N; terminal state is in the DB, so a dropped socket loses nothing |
| A job fails | counted in the batch, returned with its error text | the model can retry smaller, or change workflow |
| **Every** job fails | the `batch` event still fires | terminal means terminal, not successful (§6.1) |
| Proxy closes an idle connection | SSE keepalive every 15s | §5.3, transport layer, always on |
| MCP client times out mid-`generate` | it closes the stream; the bridge cancels the batch | §5.3 — otherwise the GPU keeps working for nobody |
| Client's timeout is shorter than a batch | configure it longer — a requirement of running the bridge | §5.3; `wait: false` where it cannot be configured |
| Something else pings llama-swap mid-batch | it loads the model → OOM | **the main operational hazard.** One client only; a lock the bridge holds is the cheap mitigation |
| **You generate from the web UI while the model is resident** | ComfyUI OOMs | the bridge cannot help — it never sees that request. `ttl` (§8) is the backstop; a `gpu_status` glance before a big job is the habit |
| ComfyUI OOMs anyway | job fails with Comfy's error | surfaced to the model; retry at a smaller size |
| Bridge crashes while the model is unloaded | harmless | the next completion reloads it |
| Model reload cost | seconds, not minutes | llama.cpp mmaps; with RAM to spare the weights stay in page cache |

---

## 11. What this does not solve

- **Latency.** Two evictions and two loads per round. Batching amortises it;
  nothing removes it. If the loop needs to feel interactive, the answer is a
  second GPU, not a better scheduler.
- **Taste.** A 9B VLM will spot a sixth finger and miss that the composition is
  boring. The prompting guides (§6.4) carry more of the quality than the model
  size does.
- **Concurrent use.** While a loop is running you are sharing the queue, and
  the row above says what happens if you forget the model is resident.
- **The record starts today.** Every output already on disk has no `origin`,
  and nothing can invent one. `source` will read as unknown for everything
  generated before this lands; the gallery should say "unknown", not "webui",
  because guessing would put words in your mouth.

---

## 12. Order of work

1. **§6.2 — `origin`, sidecar first.** DESIGN.md §6.2 and §7, then the write
   path, then the reindex test. Everything hangs off it, and it is the one
   change that is expensive to retrofit: sidecars already on disk will never
   get an `origin` block, so the sooner it exists the smaller the silent gap.
2. **§7 — the gallery filters.** Immediately after, not later. A field with no
   reader rots, and `source` alone — *what did I make, what did the model
   make* — is worth the afternoon on its own.
3. **§6.1 — the batch API.** Wanted by the bridge, but the UI can use it too: a
   batch is what "generate four variants" should always have been.
4. **§6.3, §6.4** — `free_vram`, `max_edge`, `prompting`. Small, independent.
5. **§5 — the bridge**, read-only tools first. At that point any MCP client
   with vision can drive ForgeUI, with no VRAM dance at all — which is the
   milestone worth reaching, because it is testable by hand.
6. **§5.2 — `generate`**, and the llama-swap config with it.

Steps 1–4 improve the app for a human working alone and are worth having
whether or not any of the rest happens. Step 5 is what lets *any* model drive
ForgeUI — hosted, local, or on another machine. Only step 6 is specific to
sharing one card, and it is the part that can be deleted if you ever put a
second GPU in the box.
