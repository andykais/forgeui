import { TextLineStream } from "@std/streams/text-line-stream";
import type { LaunchCommand } from "./launch.ts";

/**
 * The managed ComfyUI child process: spawn it, keep the tail of its log for
 * `GET /api/system/comfy/log`, and report when it exits.
 */

export interface ComfyProcessOptions {
  launch: LaunchCommand;
  /** How many log lines to keep; the log is a debugging aid, not a record. */
  logLines?: number;
  onExit?: (status: Deno.CommandStatus) => void;
  onLine?: (line: string) => void;
}

export class ComfyProcess {
  readonly launch: LaunchCommand;
  readonly startedAt: number;
  #child: Deno.ChildProcess;
  #log: string[] = [];
  #logLimit: number;
  #exited: Deno.CommandStatus | null = null;
  #done: Promise<void>;
  #onExit?: (status: Deno.CommandStatus) => void;
  #onLine?: (line: string) => void;

  private constructor(child: Deno.ChildProcess, options: ComfyProcessOptions) {
    this.#child = child;
    this.launch = options.launch;
    this.#logLimit = options.logLines ?? 500;
    this.#onExit = options.onExit;
    this.#onLine = options.onLine;
    this.startedAt = Date.now();
    this.#done = this.#watch();
  }

  static start(options: ComfyProcessOptions): ComfyProcess {
    const { launch } = options;
    const child = new Deno.Command(launch.command, {
      args: launch.args,
      cwd: launch.cwd,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).spawn();
    return new ComfyProcess(child, options);
  }

  get pid(): number {
    return this.#child.pid;
  }

  get exitStatus(): Deno.CommandStatus | null {
    return this.#exited;
  }

  get running(): boolean {
    return this.#exited === null;
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  log(limit = this.#logLimit): string[] {
    return this.#log.slice(-limit);
  }

  /** SIGTERM, then SIGKILL if it is still there. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.#exited) return;
    try {
      this.#child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const killed = await Promise.race([
      this.#done.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), graceMs)
      ),
    ]);
    if (!killed && this.#exited === null) {
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await this.#done;
    }
  }

  #record(line: string): void {
    this.#log.push(line);
    if (this.#log.length > this.#logLimit) {
      this.#log.splice(0, this.#log.length - this.#logLimit);
    }
    this.#onLine?.(line);
  }

  async #pipe(
    stream: ReadableStream<Uint8Array>,
    prefix: string,
  ): Promise<void> {
    const lines = stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) this.#record(`${prefix}${line}`);
  }

  async #watch(): Promise<void> {
    const stdout = this.#pipe(this.#child.stdout, "");
    const stderr = this.#pipe(this.#child.stderr, "! ");
    const status = await this.#child.status;
    await Promise.allSettled([stdout, stderr]);
    this.#exited = status;
    this.#record(
      `[forgeui] ComfyUI exited with code ${status.code}${
        status.signal ? ` (${status.signal})` : ""
      }`,
    );
    this.#onExit?.(status);
  }
}
