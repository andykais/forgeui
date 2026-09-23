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

**Raise the harness's MCP request timeout above your longest batch.** A
`generate` of six Flux images can run for minutes, and nothing the bridge
sends can make a client wait longer than it has decided to. If your harness's
timeout is fixed and short, call `generate` with `wait: false` and poll
instead. Everything else here works out of the box; this one does not.

---

## 5. Checking it works, without an LLM

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

## 6. When it goes wrong

| Symptom | Cause |
| --- | --- |
| `refusing to submit into an OOM` | llama-swap said it unloaded but `/running` still lists the model after `unloadTimeout`. Raise `unloadTimeout`, or look at whether the model is wedged |
| ComfyUI OOMs anyway | something reloaded the VLM mid-round. **While a batch is running, nothing else may talk to llama-swap** — one client only |
| `source` reads `llm:unknown` | the bridge could not reach llama-swap and had no `--llm-model`. Harmless, but pass `--llm-model` |
| The model "sees" nothing | `--mmproj` missing from the llama-swap `cmd` |
| The tool call dies after N seconds | the harness's MCP timeout, not the bridge. §4 |
| `Mcp-Method header is absent` | you are hand-rolling a client; the 2026-07-28 HTTP binding mirrors `method` and `params.name` into headers |
| Images are enormous in context | `get_output_image` returns the full frame today. `max_edge` is accepted but not yet applied — DESIGN-AGENT-LOOP §6.3 puts the resize in ForgeUI, where ffmpeg already is |
