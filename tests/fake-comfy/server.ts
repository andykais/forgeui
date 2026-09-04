import { delay } from "@std/async/delay";
import { contentType } from "@std/media-types";
import { extname, join } from "@std/path";
import { withTextChunk } from "../../src/jobs/png.ts";
import { tinyPng } from "../fixtures/png.ts";
import {
  type ApiGraph,
  type ApiNode,
  samplerNode,
  splitFilenamePrefix,
  validateGraph,
} from "./graph.ts";
import {
  type NodeRef,
  resolveScenario,
  type Scenario,
  type ScenarioName,
  type Step,
} from "./scenarios.ts";

/**
 * In-process stand-in for ComfyUI: the subset of its HTTP and WebSocket
 * surface the app uses (§14.1). Behaviour per prompt comes from a data-driven
 * scenario, so tests script success, failure, cancellation and disconnects
 * without a GPU.
 */

export interface FakeComfyOptions {
  /** ComfyUI's `--output-directory`; the app's `<appdata>/staging`. */
  stagingDir: string;
  /** ComfyUI's `--input-directory`; the app's `<appdata>/comfy-input`. */
  inputDir?: string;
  hostname?: string;
  /** Scenario used for prompts with no queued scenario. */
  scenario?: ScenarioName | Scenario;
  /** Overrides the size taken from the graph's latent node. */
  imageSize?: { width: number; height: number };
  extraNodeTypes?: readonly string[];
  /** Pause between steps; 0 keeps tests fast but ordered. */
  stepDelayMs?: number;
}

export interface ImageRef {
  filename: string;
  subfolder: string;
  type: "output";
}

export interface SubmittedPrompt {
  prompt_id: string;
  number: number;
  client_id: string | null;
  scenario: string;
  graph: ApiGraph;
  extra_data: Record<string, unknown>;
}

export interface UploadRecord {
  name: string;
  subfolder: string;
  type: string;
  size: number;
  overwrite: boolean;
}

export interface SentEvent {
  type: string;
  data: Record<string, unknown>;
}

export type RunStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "interrupted"
  | "deleted"
  | "dead";

export interface HistoryEntry {
  prompt: [number, string, ApiGraph, Record<string, unknown>, string[]];
  outputs: Record<string, { images: ImageRef[] }>;
  status: {
    status_str: "success" | "error";
    completed: boolean;
    messages: [string, Record<string, unknown>][];
  };
}

interface Run {
  number: number;
  prompt_id: string;
  client_id: string | null;
  graph: ApiGraph;
  extra_data: Record<string, unknown>;
  scenario: Scenario;
  outputNodes: string[];
  status: RunStatus;
  outputs: Record<string, { images: ImageRef[] }>;
  messages: [string, Record<string, unknown>][];
  executed: string[];
  counters: Map<string, number>;
  abort: AbortController;
  abortReason: "deleted" | "interrupted" | "dead" | "closed" | null;
  currentNode: string | null;
  finished: Promise<void>;
}

interface Gate {
  arrived: Promise<void>;
  markArrived: () => void;
  opened: Promise<void>;
  open: () => void;
}

const PREVIEW_EVENT_IMAGE = 1;
const PREVIEW_FORMAT = { jpeg: 1, png: 2 } as const;

class Aborted extends Error {}

function gate(): Gate {
  let markArrived = () => {};
  let open = () => {};
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { arrived, markArrived, opened, open };
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Aborted());
      return;
    }
    signal.addEventListener("abort", () => reject(new Aborted()), {
      once: true,
    });
  });
}

function timestamp(): number {
  return Date.now();
}

export class FakeComfy {
  readonly prompts: SubmittedPrompt[] = [];
  readonly uploads: UploadRecord[] = [];
  readonly sentEvents: SentEvent[] = [];
  /** Unexpected failures inside a replay; tests assert this stays empty. */
  readonly errors: unknown[] = [];
  interruptCount = 0;

  #server!: Deno.HttpServer<Deno.NetAddr>;
  #options: FakeComfyOptions;
  #sockets = new Set<WebSocket>();
  #runs: Run[] = [];
  #chain: Promise<void> = Promise.resolve();
  #history: Record<string, HistoryEntry> = {};
  #gates = new Map<string, Gate>();
  #queuedScenarios: Scenario[] = [];
  #defaultScenario: Scenario;
  #nextNumber = 1;
  #closed = false;

  private constructor(options: FakeComfyOptions) {
    this.#options = options;
    this.#defaultScenario = resolveScenario(options.scenario ?? "success");
  }

  static async start(options: FakeComfyOptions): Promise<FakeComfy> {
    await Deno.mkdir(options.stagingDir, { recursive: true });
    if (options.inputDir) {
      await Deno.mkdir(options.inputDir, { recursive: true });
    }
    const fake = new FakeComfy(options);
    fake.#server = Deno.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (req) => fake.#handle(req));
    return fake;
  }

  get hostname(): string {
    return this.#server.addr.hostname;
  }

  get port(): number {
    return this.#server.addr.port;
  }

  get url(): string {
    return `http://${this.hostname}:${this.port}`;
  }

  /** Scenario for every prompt that has no one-shot scenario queued. */
  setScenario(scenario: ScenarioName | Scenario): void {
    this.#defaultScenario = resolveScenario(scenario);
  }

  /** Use this scenario for the next prompt only. */
  queueScenario(scenario: ScenarioName | Scenario): void {
    this.#queuedScenarios.push(resolveScenario(scenario));
  }

  openGate(name: string): void {
    this.#gate(name).open();
  }

  /** Resolves once a replay has parked at the named gate. */
  async waitForGate(name: string, timeoutMs = 5000): Promise<void> {
    await Promise.race([
      this.#gate(name).arrived,
      delay(timeoutMs).then(() => {
        throw new Error(`fake ComfyUI never reached gate "${name}"`);
      }),
    ]);
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  get lastPrompt(): SubmittedPrompt | undefined {
    return this.prompts[this.prompts.length - 1];
  }

  history(): Record<string, HistoryEntry> {
    return structuredClone(this.#history);
  }

  runStatus(promptId: string): RunStatus | undefined {
    return this.#runs.find((run) => run.prompt_id === promptId)?.status;
  }

  /** Close every websocket without shutting the server down. */
  dropSockets(): void {
    for (const socket of [...this.#sockets]) {
      try {
        socket.close(1006, "fake ComfyUI dropped the connection");
      } catch {
        // Already closing.
      }
      this.#sockets.delete(socket);
    }
  }

  /** Wait for every replay to finish or abort. */
  async settled(): Promise<void> {
    await this.#chain;
  }

  /** Wait for one prompt's replay to end, then report how it ended. */
  async waitForPrompt(promptId: string, timeoutMs = 5000): Promise<RunStatus> {
    const run = this.#runs.find((candidate) =>
      candidate.prompt_id === promptId
    );
    if (!run) throw new Error(`unknown prompt ${promptId}`);
    await Promise.race([
      run.finished,
      delay(timeoutMs).then(() => {
        throw new Error(`prompt ${promptId} did not settle in ${timeoutMs}ms`);
      }),
    ]);
    return run.status;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const run of this.#runs) {
      if (run.status === "pending" || run.status === "running") {
        run.abortReason = "closed";
        run.abort.abort();
      }
    }
    for (const g of this.#gates.values()) g.open();
    await this.#chain.catch(() => {});
    this.dropSockets();
    await this.#server.shutdown();
  }

  #gate(name: string): Gate {
    let g = this.#gates.get(name);
    if (!g) {
      g = gate();
      this.#gates.set(name, g);
    }
    return g;
  }

  // ---------------------------------------------------------------- routing

  #handle(req: Request): Response | Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") return this.#handleWs(req, url);
    if (req.method === "POST" && path === "/prompt") {
      return this.#postPrompt(req);
    }
    if (req.method === "GET" && path === "/queue") return this.#getQueue();
    if (req.method === "POST" && path === "/queue") return this.#postQueue(req);
    if (req.method === "POST" && path === "/interrupt") {
      return this.#interrupt();
    }
    if (req.method === "GET" && path.startsWith("/history")) {
      return this.#getHistory(path);
    }
    if (req.method === "POST" && path === "/upload/image") {
      return this.#uploadImage(req);
    }
    if (req.method === "GET" && path === "/view") return this.#view(url);
    if (req.method === "GET" && path === "/system_stats") {
      return this.#systemStats();
    }
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(
        "<!doctype html><title>fake ComfyUI</title><body>fake ComfyUI</body>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found", path }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  #handleWs(req: Request, url: URL): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const sid = url.searchParams.get("clientId") ?? crypto.randomUUID();
    socket.onopen = () => {
      this.#sockets.add(socket);
      socket.send(JSON.stringify({
        type: "status",
        data: {
          status: { exec_info: { queue_remaining: this.#queueRemaining() } },
          sid,
        },
      }));
    };
    socket.onclose = () => this.#sockets.delete(socket);
    socket.onerror = () => this.#sockets.delete(socket);
    return response;
  }

  async #postPrompt(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return this.#promptError("invalid JSON body", {});
    }
    const validation = validateGraph(body.prompt, {
      extraNodeTypes: this.#options.extraNodeTypes,
    });
    if (!validation.ok) {
      return this.#promptError(validation.message, validation.nodeErrors);
    }

    const graph = body.prompt as ApiGraph;
    const scenario = this.#queuedScenarios.shift() ?? this.#defaultScenario;
    const prompt_id = typeof body.prompt_id === "string"
      ? body.prompt_id
      : crypto.randomUUID();
    const abort = new AbortController();
    let markFinished = () => {};
    const run: Run = {
      number: this.#nextNumber++,
      prompt_id,
      client_id: typeof body.client_id === "string" ? body.client_id : null,
      graph,
      extra_data: (body.extra_data ?? {}) as Record<string, unknown>,
      scenario,
      outputNodes: validation.outputNodes,
      status: "pending",
      outputs: {},
      messages: [],
      executed: [],
      counters: new Map(),
      abort,
      abortReason: null,
      currentNode: null,
      finished: new Promise<void>((resolve) => {
        markFinished = resolve;
      }),
    };
    this.#runs.push(run);
    this.prompts.push({
      prompt_id,
      number: run.number,
      client_id: run.client_id,
      scenario: scenario.name,
      graph,
      extra_data: run.extra_data,
    });

    this.#chain = this.#chain
      .then(() => this.#replay(run))
      .catch((error) => {
        if (error instanceof Aborted) return;
        this.errors.push(error);
        console.error("fake ComfyUI replay failed:", error);
      })
      .finally(markFinished);

    this.#broadcastStatus();
    return Response.json({ prompt_id, number: run.number, node_errors: {} });
  }

  #promptError(
    message: string,
    nodeErrors: Record<string, unknown>,
  ): Response {
    return Response.json({
      error: {
        type: "prompt_outputs_failed_validation",
        message,
        details: "",
        extra_info: {},
      },
      node_errors: nodeErrors,
    }, { status: 400 });
  }

  #getQueue(): Response {
    const item = (run: Run) => [
      run.number,
      run.prompt_id,
      run.graph,
      run.extra_data,
      run.outputNodes,
    ];
    return Response.json({
      queue_running: this.#runs.filter((r) => r.status === "running").map(item),
      queue_pending: this.#runs.filter((r) => r.status === "pending").map(item),
    });
  }

  async #postQueue(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const targets: Run[] = [];
    if (body.clear === true) {
      targets.push(...this.#runs.filter((run) => run.status === "pending"));
    }
    if (Array.isArray(body.delete)) {
      const ids = new Set(body.delete.map(String));
      targets.push(
        ...this.#runs.filter((run) =>
          run.status === "pending" && ids.has(run.prompt_id)
        ),
      );
    }
    for (const run of targets) {
      run.abortReason = "deleted";
      run.abort.abort();
    }
    this.#broadcastStatus();
    return new Response(null, { status: 200 });
  }

  #interrupt(): Response {
    this.interruptCount++;
    const running = this.#runs.find((run) => run.status === "running");
    if (running) {
      running.abortReason = "interrupted";
      running.abort.abort();
    }
    return new Response(null, { status: 200 });
  }

  #getHistory(path: string): Response {
    const promptId = path.slice("/history".length).replace(/^\//, "");
    if (promptId.length === 0) return Response.json(this.#history);
    const entry = this.#history[promptId];
    return Response.json(entry ? { [promptId]: entry } : {});
  }

  async #uploadImage(req: Request): Promise<Response> {
    const form = await req.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ error: "no image field" }, { status: 400 });
    }
    const subfolder = String(form.get("subfolder") ?? "");
    const type = String(form.get("type") ?? "input");
    const overwrite = ["true", "1", "y"].includes(
      String(form.get("overwrite") ?? "").toLowerCase(),
    );
    const inputDir = this.#options.inputDir;
    if (!inputDir) {
      return Response.json({ error: "no input dir configured" }, {
        status: 500,
      });
    }
    const dir = subfolder ? join(inputDir, subfolder) : inputDir;
    await Deno.mkdir(dir, { recursive: true });
    let name = file.name;
    if (!overwrite) {
      let i = 1;
      while (await exists(join(dir, name))) {
        const ext = extname(file.name);
        name = `${
          file.name.slice(0, file.name.length - ext.length)
        } (${i++})${ext}`;
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(join(dir, name), bytes);
    this.uploads.push({
      name,
      subfolder,
      type,
      size: bytes.length,
      overwrite,
    });
    return Response.json({ name, subfolder, type });
  }

  async #view(url: URL): Promise<Response> {
    const filename = url.searchParams.get("filename");
    if (!filename) return new Response("filename required", { status: 400 });
    const subfolder = url.searchParams.get("subfolder") ?? "";
    const type = url.searchParams.get("type") ?? "output";
    const root = type === "input"
      ? this.#options.inputDir
      : this.#options.stagingDir;
    if (!root) return new Response("not found", { status: 404 });
    const path = join(root, subfolder, filename);
    try {
      const bytes = await Deno.readFile(path);
      return new Response(bytes, {
        headers: {
          "content-type": contentType(extname(filename)) ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  #systemStats(): Response {
    return Response.json({
      system: {
        os: "posix",
        ram_total: 67_108_864_000,
        ram_free: 41_231_686_144,
        comfyui_version: "0.3.60-fake",
        python_version: "3.12.0 (fake)",
        pytorch_version: "2.5.0+fake",
        embedded_python: false,
        argv: ["main.py"],
      },
      devices: [{
        name: "cuda:0 FakeGPU",
        type: "cuda",
        index: 0,
        vram_total: 25_757_220_864,
        vram_free: 24_051_089_408,
        torch_vram_total: 1_073_741_824,
        torch_vram_free: 939_524_096,
      }],
    });
  }

  // ----------------------------------------------------------------- replay

  async #replay(run: Run): Promise<void> {
    const signal = run.abort.signal;
    try {
      if (run.scenario.hold) {
        await Promise.race([
          this.#arriveAt(run.scenario.hold),
          abortRejection(signal),
        ]);
      }
      if (signal.aborted) throw new Aborted();
      run.status = "running";
      this.#broadcastStatus();

      for (const step of run.scenario.steps) {
        if (signal.aborted) throw new Aborted();
        const stepDelay = this.#options.stepDelayMs ?? 0;
        if (stepDelay > 0) await delay(stepDelay, { signal });
        await this.#runStep(run, step);
        // A step can end the run: `execution_error` and `die` both stop here.
        const status = run.status as RunStatus;
        if (status === "error" || status === "dead") return;
      }
    } catch (error) {
      if (
        !(error instanceof Aborted) &&
        !(error as Error)?.name?.includes("Abort")
      ) {
        throw error;
      }
      this.#onAborted(run);
    } finally {
      this.#broadcastStatus();
    }
  }

  #arriveAt(name: string): Promise<void> {
    const g = this.#gate(name);
    g.markArrived();
    return g.opened;
  }

  #onAborted(run: Run): void {
    switch (run.abortReason) {
      case "interrupted": {
        run.status = "interrupted";
        const node = run.currentNode;
        this.#emit(run, "execution_interrupted", {
          prompt_id: run.prompt_id,
          node_id: node,
          node_type: node ? run.graph[node]?.class_type ?? null : null,
          executed: [...run.executed],
        });
        this.#finish(run, "error", false);
        break;
      }
      case "dead":
        run.status = "dead";
        break;
      case "deleted":
        run.status = "deleted";
        break;
      case "closed":
      default:
        run.status = "dead";
        break;
    }
  }

  async #runStep(run: Run, step: Step): Promise<void> {
    switch (step.kind) {
      case "status":
        this.#broadcastStatus(step.queue_remaining);
        return;
      case "execution_start":
        this.#emit(run, "execution_start", {
          prompt_id: run.prompt_id,
          timestamp: timestamp(),
        });
        return;
      case "execution_cached":
        this.#emit(run, "execution_cached", {
          nodes: (step.nodes ?? []).map((ref) => this.#resolve(run, ref))
            .filter(
              (id): id is string => id !== null,
            ),
          prompt_id: run.prompt_id,
          timestamp: timestamp(),
        });
        return;
      case "executing": {
        const node = step.node === null ? null : this.#resolve(run, step.node);
        if (step.node !== null && node === null) return;
        run.currentNode = node;
        this.#emit(run, "executing", {
          node,
          display_node: node,
          prompt_id: run.prompt_id,
        });
        return;
      }
      case "progress": {
        const node = this.#resolve(run, step.node);
        if (node === null) return;
        this.#emit(run, "progress", {
          value: step.value,
          max: step.max,
          prompt_id: run.prompt_id,
          node,
        });
        return;
      }
      case "preview": {
        const node = step.node
          ? this.#resolve(run, step.node)
          : run.currentNode;
        this.#sendPreview(node, step.format ?? "png");
        return;
      }
      case "executed": {
        const node = this.#resolve(run, step.node);
        if (node === null) return;
        const images = await this.#writeImages(run, node, step.images ?? 1);
        run.outputs[node] = { images };
        run.executed.push(node);
        this.#emit(run, "executed", {
          node,
          display_node: node,
          output: { images },
          prompt_id: run.prompt_id,
        });
        return;
      }
      case "execution_success":
        this.#emit(run, "execution_success", {
          prompt_id: run.prompt_id,
          timestamp: timestamp(),
        });
        run.status = "done";
        this.#finish(run, "success", true);
        return;
      case "execution_error": {
        const node = this.#resolve(run, step.node);
        const message = step.message ?? "fake ComfyUI failure";
        this.#emit(run, "execution_error", {
          prompt_id: run.prompt_id,
          node_id: node,
          node_type: node ? run.graph[node]?.class_type ?? null : null,
          executed: [...run.executed],
          exception_message: message,
          exception_type: step.exception_type ?? "RuntimeError",
          traceback: [
            '  File "execution.py", line 1, in execute\n',
            `    raise ${
              step.exception_type ?? "RuntimeError"
            }("${message}")\n`,
          ],
          current_inputs: {},
          current_outputs: {},
        });
        run.status = "error";
        this.#finish(run, "error", false);
        return;
      }
      case "delay":
        await delay(step.ms, { signal: run.abort.signal });
        return;
      case "gate":
        await Promise.race([
          this.#arriveAt(step.name),
          abortRejection(run.abort.signal),
        ]);
        return;
      case "drop_sockets":
        this.dropSockets();
        return;
      case "die":
        run.abortReason = "dead";
        run.status = "dead";
        this.dropSockets();
        return;
    }
  }

  #finish(
    run: Run,
    statusStr: "success" | "error",
    completed: boolean,
  ): void {
    this.#history[run.prompt_id] = {
      prompt: [
        run.number,
        run.prompt_id,
        run.graph,
        run.extra_data,
        run.outputNodes,
      ],
      outputs: structuredClone(run.outputs),
      status: {
        status_str: statusStr,
        completed,
        messages: [...run.messages],
      },
    };
  }

  #resolve(run: Run, ref: NodeRef): string | null {
    if (typeof ref === "string") return ref in run.graph ? ref : null;
    if ("save" in ref) return run.outputNodes[ref.save] ?? null;
    if ("nth" in ref) return Object.keys(run.graph)[ref.nth] ?? null;
    return samplerNode(run.graph);
  }

  #imageSize(graph: ApiGraph): { width: number; height: number } {
    if (this.#options.imageSize) return this.#options.imageSize;
    for (const node of Object.values(graph) as ApiNode[]) {
      const { width, height } = node.inputs;
      if (typeof width === "number" && typeof height === "number") {
        return { width, height };
      }
    }
    return { width: 64, height: 64 };
  }

  /** Write files exactly where `SaveImage` would, then report them. */
  async #writeImages(
    run: Run,
    nodeId: string,
    count: number,
  ): Promise<ImageRef[]> {
    const node = run.graph[nodeId]!;
    const filenamePrefix = String(node.inputs.filename_prefix ?? "ComfyUI");
    const { subfolder, prefix } = splitFilenamePrefix(filenamePrefix);
    const dir = subfolder
      ? join(this.#options.stagingDir, subfolder)
      : this.#options.stagingDir;
    await Deno.mkdir(dir, { recursive: true });

    const { width, height } = this.#imageSize(run.graph);
    const images: ImageRef[] = [];
    for (let i = 0; i < count; i++) {
      const key = `${subfolder}/${prefix}`;
      const index = (run.counters.get(key) ?? 0) + 1;
      run.counters.set(key, index);
      const filename = `${prefix}_${String(index).padStart(5, "0")}_.png`;
      const bytes = withTextChunk(
        tinyPng({ width, height, color: [0x6f, 0xb6, 0xc8] }),
        "prompt",
        JSON.stringify(run.graph),
      );
      await Deno.writeFile(join(dir, filename), bytes);
      images.push({ filename, subfolder, type: "output" });
    }
    return images;
  }

  // ------------------------------------------------------------- websockets

  #queueRemaining(): number {
    return this.#runs.filter((run) =>
      run.status === "pending" || run.status === "running"
    ).length;
  }

  #emit(run: Run, type: string, data: Record<string, unknown>): void {
    run.messages.push([type, data]);
    this.#broadcast(type, data);
  }

  #broadcast(type: string, data: Record<string, unknown>): void {
    this.sentEvents.push({ type, data });
    const payload = JSON.stringify({ type, data });
    for (const socket of this.#sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  #broadcastStatus(queueRemaining?: number): void {
    if (this.#closed) return;
    this.#broadcast("status", {
      status: {
        exec_info: {
          queue_remaining: queueRemaining ?? this.#queueRemaining(),
        },
      },
    });
  }

  /** ComfyUI's binary preview: 4-byte event, 4-byte format, then the image. */
  #sendPreview(node: string | null, format: "png" | "jpeg"): void {
    const image = tinyPng({ width: 32, height: 32, color: [0xe0, 0xa2, 0x53] });
    const frame = new Uint8Array(8 + image.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, PREVIEW_EVENT_IMAGE);
    view.setUint32(4, PREVIEW_FORMAT[format]);
    frame.set(image, 8);
    this.sentEvents.push({
      type: "preview",
      data: { node, format, bytes: frame.length },
    });
    for (const socket of this.#sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function startFakeComfy(options: FakeComfyOptions): Promise<FakeComfy> {
  return FakeComfy.start(options);
}
