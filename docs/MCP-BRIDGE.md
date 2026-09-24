# Running `forge mcp` — the bridge, llama-swap, and your harness

How to wire the three processes together on one box, and what each one has to
be told. The design and the reasoning are in `DESIGN-AGENT-LOOP.md`; this is
the runbook.

```
  harness ──MCP──▶ forge mcp ──REST+WS──▶ ForgeUI ──▶ ComfyUI ──┐
     │                  │                                       │ one GPU
     └──OpenAI API──▶ llama-swap ──▶ llama-server (the VLM) ─────┘
                          ▲
                          └── forge mcp evicts the VLM before it generates
```

---

## 1. Ports, and who talks to whom

| Process | Listens on | Talks to |
| --- | --- | --- |
| ForgeUI | `:7860` | ComfyUI (it manages that itself) |
| llama-swap | `:8080` | starts `llama-server` on a port it picks |
| `forge mcp` | `:7801` | ForgeUI, llama-swap |
| your harness | — | llama-swap (completions), `forge mcp` (tools) |

Nothing here is authenticated: ForgeUI has no auth, and the bridge adds none.
Bind everything to `127.0.0.1` unless the harness is on another machine, in
which case bind only the bridge wider and leave ForgeUI and llama-swap local.

---

## 2. llama-swap

```yaml
# llama-swap.yaml
models:
  qwen-vlm:
    cmd: >
      llama-server --port ${PORT}
      --model /models/Qwen3.5-9B-Q4_K_M.gguf
      --mmproj /models/mmproj-F16.gguf
      -c 16384 -ctk q8_0 -ctv q8_0
    ttl: 1800
    unloadTimeout: 30
```

Two things worth getting right:

- **`--mmproj` is not optional for vision.** The vision tower ships as its own
  GGUF and stays at F16; without it the model loads and simply cannot see, and
  `get_output_image` will hand it a picture it ignores.
- **`ttl` is a backstop, not the mechanism.** The bridge evicts explicitly, so
  the timer never runs during a round. It exists for the round you walked away
  from: without it the VLM stays resident, and your own next generation from
  the web UI meets a GPU that is already full. Thirty minutes is long enough
  never to interrupt thinking and short enough to have let go by the time you
  sit back down.

Start it:

```sh
llama-swap --config llama-swap.yaml --listen 127.0.0.1:8080
```

Check it the way the bridge will:

```sh
curl -s localhost:8080/running          # what is resident
curl -sX POST localhost:8080/api/models/unload   # make the GPU free
```

If `/running` returns a shape the bridge cannot read it falls back to the
configured `--llm-model` and carries on — a label is not worth failing a round
over — but it is worth looking at that output once, because it is where the
`source` on every generation comes from.

---

## 3. The bridge

```sh
deno task mcp -- \
  --http 127.0.0.1:7801 \
  --forgeui http://127.0.0.1:7860 \
  --llama-swap http://127.0.0.1:8080 \
  --llm-model qwen-vlm
```

Or build a binary once and run that:

```sh
deno task compile          # produces ./forge
./forge mcp --http 127.0.0.1:7801 --llama-swap http://127.0.0.1:8080 --llm-model qwen-vlm
```

| Flag | Why |
| --- | --- |
| `--forgeui` | default `http://127.0.0.1:7860` |
| `--llama-swap` | **omit it and the bridge never evicts anything** — correct when the LLM is not on this GPU (hosted, or another box) |
| `--llm-model` | the id to unload, and the name recorded as `source`. Without it the bridge asks `/running` and uses whatever it finds |
| `--http host:port` | Streamable HTTP |
| `--stdio` | the harness launches the bridge as a subprocess instead |
| `--no-free-vram` | skip asking ComfyUI to unload after a round |
| `--progress` | relay progress notifications. **The model never sees these** — it is unloaded for the whole call. Turn them on only if your harness renders them for you |
| `--timeout` | default ceiling for one round, seconds (900) |

A systemd unit, if you want it to come back after a reboot:

```ini
[Unit]
Description=ForgeUI MCP bridge
After=network.target

[Service]
ExecStart=/usr/local/bin/forge mcp --http 127.0.0.1:7801 \
  --forgeui http://127.0.0.1:7860 \
  --llama-swap http://127.0.0.1:8080 --llm-model qwen-vlm
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 4. Pointing the harness at it

The harness needs two connections, and they are unrelated to each other:

1. **Completions** go to llama-swap's OpenAI-compatible endpoint —
   `http://127.0.0.1:8080/v1`, model `qwen-vlm`. This is the connection that
   *reloads* the VLM after a round: llama-swap loads on demand, so the harness
   simply sending its next request is what brings the model back. Nothing has
   to ask for that.
2. **Tools** come from the bridge over MCP.

### If the harness takes an MCP server over HTTP

```json
{
  "mcpServers": {
    "forgeui": {
      "type": "http",
      "url": "http://127.0.0.1:7801/mcp"
    }
  }
}
```

### If it launches servers as subprocesses

```json
{
  "mcpServers": {
    "forgeui": {
      "command": "/usr/local/bin/forge",
      "args": [
        "mcp", "--stdio",
        "--forgeui", "http://127.0.0.1:7860",
        "--llama-swap", "http://127.0.0.1:8080",
        "--llm-model", "qwen-vlm"
      ]
    }
  }
}
```

On stdio, stdout belongs to the protocol — the bridge logs to stderr for
exactly that reason.

### The one setting that matters

**Raise the harness's MCP request timeout above your longest batch.** (In pi
that setting is `requestTimeoutMs` — §5.1.) A
`generate` of six Flux images can run for minutes, and nothing the bridge
sends can make a client wait longer than it has decided to. If your harness's
timeout is fixed and short, call `generate` with `wait: false` and poll
instead. Everything else here works out of the box; this one does not.

---

## 5. pi, end to end

[pi](https://github.com/earendil-works/pi) is the harness this was built
against. Four pieces have to line up; the rest of its setup is untouched.

### 5.1 MCP is an extension, not built in

```sh
pi install npm:pi-mcp-adapter
```

Then `~/.pi/agent/mcp.json` (or `.pi/mcp.json` to keep it per project):

```json
{
  "mcpServers": {
    "forgeui": {
      "url": "http://127.0.0.1:7801/mcp",
      "directTools": true,
      "lifecycle": "keep-alive",
      "requestTimeoutMs": 1800000
    }
  }
}
```

Three of those four keys matter:

- **`directTools: true`** registers each of the bridge's tools as a real pi
  tool. Left out, every call goes through one `mcp` proxy tool the model has to
  *search* first — an extra round trip, and it wastes the tool descriptions.
- **`requestTimeoutMs`** is §4's "one setting that matters", by its real name.
  A round runs for minutes; the adapter's default is far shorter. 30 minutes
  here.
- **`lifecycle: "keep-alive"`** stops the adapter hanging up between rounds —
  `idleTimeout` defaults to 10 minutes, and your thinking will exceed that.

The bridge serves both protocol eras (its handler defaults to
`legacy: 'stateless'`), so it does not matter which one the adapter speaks.

### 5.2 llama-swap has to own llama-server

This is the part that is easy to miss. **The bridge cannot evict a process
llama-swap does not own.** If pi keeps talking to a `llama-server` you started
yourself, eviction silently does nothing and ComfyUI meets a full GPU.

A launch script that starts `llama-server` directly:

```sh
llama-server --model "${MODEL_FILE}" --alias "${ALIAS}" \
  --host 127.0.0.1 --port "${LLAMA_PORT}" \
  --ctx-size "${LLAMA_CTX}" --no-context-shift \
  --n-gpu-layers 99 --flash-attn on --jinja &
```

becomes a llama-swap entry, with the same flags:

```yaml
# llama-swap.yaml
models:
  qwen3.8-27b:                     # this key is what pi asks for
    cmd: >
      llama-server
      --model /models/Qwen3.8-27B-UD-Q6_K_L.gguf
      --mmproj /models/Qwen3.8-27B-mmproj-F16.gguf
      --alias qwen3.8-27b
      --host 127.0.0.1 --port ${PORT}
      --ctx-size 32768 --no-context-shift
      --n-gpu-layers 99 --flash-attn on --jinja
    ttl: 1800
    unloadTimeout: 30
```

Two edits to the command itself: `--port ${PORT}` instead of a fixed one —
llama-swap assigns it — and no trailing `&`, because llama-swap owns the
lifecycle now.

**`--mmproj` is the flag that makes the loop a loop.** Qwen3.8-27B is a native
vision-language model, but llama.cpp ships the vision tower as its own GGUF and
does not load it unless told. Without it the model writes prompts and is blind
to `get_output_image`: it will generate happily and never see what it made.
Keep the projector at F16 — it is under a gigabyte and quantising it is what
degrades visual grounding first.

### 5.3 The launcher

```sh
llama-swap --config llama-swap.yaml --listen 127.0.0.1:8080 &

forge mcp --http 127.0.0.1:7801 \
  --forgeui http://127.0.0.1:7860 \
  --llama-swap http://127.0.0.1:8080 \
  --llm-model qwen3.8-27b &

exec pi \
  --provider local \
  --model qwen3.8-27b \
  --session-dir "$OUTPUT_DIR/sessions"
```

`--llm-model` is the llama-swap key, and it is also what lands in the gallery:
every generation from this loop records `source: llm:qwen3.8-27b`.

### 5.4 `models.json`

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "qwen3.8-27b",
          "name": "Qwen 3.8 27B (local)",
          "reasoning": true,
          "input": ["text", "image"],
          "inputLimits": {
            "images": {
              "resize": { "maxWidth": 1024, "maxHeight": 1024, "jpegQuality": 85 }
            }
          },
          "contextWindow": 32768,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Five things in there are deliberate:

- **`baseUrl` points at llama-swap**, not at a llama-server you launched. If
  llama-swap takes the port llama-server used to have, this line does not
  change at all — and pi sending its next completion here is what *reloads* the
  model after a round. That reload is the whole of "waking the LLM back up".
- **`id` must equal the llama-swap model key.** A `.gguf` filename works, but
  the id is also what the bridge records as `source`, so a clean name is worth
  it: `llm:qwen3.8-27b` reads better in the gallery than
  `llm:Qwen3.8-27B-UD-Q6_K_L.gguf`. Change it in both places or neither.
- **`input: ["text", "image"]` is required for the critique half.** Without it
  pi will not send `get_output_image`'s picture to the model, and `--mmproj`
  will have been for nothing. Both halves are needed; neither is sufficient.
- **`inputLimits.images.resize` is where downscaling happens today.**
  `get_output_image` accepts `max_edge` but does not yet apply it (§6), and a
  1024² PNG is several megabytes and a lot of vision tokens. Resizing client
  side costs nothing and is enough to judge composition and anatomy.
- **`contextWindow` must match `--ctx-size`, not the model's spec sheet.**
  Qwen3.8-27B is documented at 256K, but llama.cpp only allocates what
  `--ctx-size` asks for; declaring 200000 against a 32768 server means pi packs
  prompts the server rejects. Keep `maxTokens` well under `contextWindow` too,
  or there is no room left for the input.

One note on VRAM: at Q6_K this model is 23–26GB, which is essentially the whole
card. That is not a problem here — it is the reason the eviction exists — but
it does mean the loop will not work at all if llama-swap is not in the path.

---

## 6. Checking it works, without an LLM

The bridge is a normal MCP server, so `curl` is a fine client. Note that the
2026-07-28 binding mirrors the method and tool name into headers:

```sh
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
"io.modelcontextprotocol/clientCapabilities":{}}'

# what tools exist
curl -sX POST localhost:7801/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$META}}"

# is the GPU free?
curl -sX POST localhost:7801/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: gpu_status' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{$META,\"name\":\"gpu_status\",\"arguments\":{}}}"
```

A round, start to finish:

```sh
curl -sX POST localhost:7801/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: generate' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{$META,
       \"name\":\"generate\",\"arguments\":{
         \"project\":\"herons\",\"note\":\"round 1\",
         \"jobs\":[{\"workflow_id\":\"krea2\",\"params\":{\"prompt\":\"a heron in reeds\"}}]}}}"
```

Watch llama-swap's log while that runs: you should see `/running` read, then
the unload, then nothing until the round ends.

---

## 7. When it goes wrong

| Symptom | Cause |
| --- | --- |
| `refusing to submit into an OOM` | llama-swap said it unloaded but `/running` still lists the model after `unloadTimeout`. Raise `unloadTimeout`, or look at whether the model is wedged |
| ComfyUI OOMs anyway | something reloaded the VLM mid-round. **While a batch is running, nothing else may talk to llama-swap** — one client only |
| `source` reads `llm:unknown` | the bridge could not reach llama-swap and had no `--llm-model`. Harmless, but pass `--llm-model` |
| The model "sees" nothing | `--mmproj` missing from the llama-swap `cmd`, **or** `input: ["text","image"]` missing from `models.json` — both are needed (§5.2, §5.4) |
| Eviction seems to do nothing | llama-swap is not the thing that started `llama-server` (§5.2) |
| pi packs a prompt the server rejects | `contextWindow` in `models.json` exceeds `--ctx-size` (§5.4) |
| The tool call dies after N seconds | the harness's MCP timeout, not the bridge. §4 |
| `Mcp-Method header is absent` | you are hand-rolling a client; the 2026-07-28 HTTP binding mirrors `method` and `params.name` into headers |
| Images are enormous in context | `get_output_image` returns the full frame today — `max_edge` is accepted but not yet applied (DESIGN-AGENT-LOOP §6.3 puts the resize in ForgeUI, where ffmpeg already is). Until then, resize client side: `inputLimits.images.resize` in `models.json` (§5.4) |
