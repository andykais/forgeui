<script lang="ts">
  import Brush from "@lucide/svelte/icons/brush";
  import Eraser from "@lucide/svelte/icons/eraser";
  import Contrast from "@lucide/svelte/icons/contrast";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import { onMount, tick } from "svelte";
  import { app } from "../../stores/app.svelte.ts";
  import {
    alphaOf,
    brushRange,
    coverageOf,
    invert,
    isBlank,
    MaskHistory,
    maskPixels,
    paintAlpha,
    stepBrush,
    toImage,
  } from "../../lib/mask.ts";

  /**
   * The mask editor (§10): the picture as large as the window allows, the
   * mask over it in the accent colour, and only what saying *where* needs —
   * a round brush and eraser of one size, invert, clear, undo and redo, and
   * a way to look underneath. How soft the edge is belongs to the workflow,
   * so there is no hardness here.
   *
   * It paints into a canvas the size of the picture and keeps only the
   * alpha of what it painted; Done turns that into the grey PNG the
   * workflow reads (§9).
   */
  interface Props {
    /** The picture being masked, by URL. */
    image: string;
    /** The mask so far, to paint on top of; null starts empty. */
    mask: string | null;
    label: string;
    /** Done: the PNG to store, or null when nothing is painted. */
    ondone: (png: Blob | null) => void | Promise<void>;
    oncancel: () => void;
  }

  let { image, mask, label, ondone, oncancel }: Props = $props();

  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  let width = $state(0);
  let height = $state(0);
  let ready = $state(false);
  let error = $state<string | null>(null);
  let saving = $state(false);

  let tool = $state<"brush" | "eraser">("brush");
  let size = $state(32);
  let hidden = $state(false);
  let range = $state({ min: 2, max: 512 });
  let history = $state<MaskHistory | null>(null);
  /** Bumped on every change, so undo/redo's enabled state is re-read. */
  let version = $state(0);
  const canUndo = $derived(version >= 0 && (history?.canUndo ?? false));
  const canRedo = $derived(version >= 0 && (history?.canRedo ?? false));

  /** The pointer over the picture, for the brush outline; null when off it. */
  let pointer = $state<{ x: number; y: number; scale: number } | null>(null);
  let last: { x: number; y: number } | null = null;
  let drawing = false;
  /** The tint the mask is painted in: the accent (§11.5). */
  let tint: [number, number, number] = [111, 182, 200];

  function context(): CanvasRenderingContext2D | null {
    return canvas?.getContext("2d", { willReadFrequently: true }) ?? null;
  }

  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`could not load ${url}`));
      element.src = url;
    });
  }

  function readTint(): [number, number, number] {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (!hex) return tint;
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [
      number,
      number,
      number,
    ];
  }

  onMount(() => {
    tint = readTint();
    let live = true;
    (async () => {
      try {
        const picture = await loadImage(image);
        if (!live) return;
        width = picture.naturalWidth;
        height = picture.naturalHeight;
        const fit = brushRange(width, height);
        range = { min: fit.min, max: fit.max };
        size = fit.initial;
        history = new MaskHistory(width * height);
        // The canvas takes its size from the attributes on the next render,
        // and resizing a canvas empties it, so nothing is drawn before that.
        await tick();
        if (mask) {
          const stored = await loadImage(mask);
          if (!live) return;
          if (stored.naturalWidth === width && stored.naturalHeight === height) {
            const scratch = document.createElement("canvas");
            scratch.width = width;
            scratch.height = height;
            const sctx = scratch.getContext("2d")!;
            sctx.drawImage(stored, 0, 0);
            write(coverageOf(sctx.getImageData(0, 0, width, height).data));
          }
          // A mask of another size is the panel's to complain about; here
          // it would only be stretched, so the editor starts clean instead.
        }
        ready = true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    })();
    return () => {
      live = false;
    };
  });

  function read(): Uint8Array {
    const ctx = context();
    if (!ctx || width === 0) return new Uint8Array(0);
    return alphaOf(ctx.getImageData(0, 0, width, height).data);
  }

  function write(alpha: Uint8Array) {
    const ctx = context();
    if (!ctx) return;
    const data = ctx.createImageData(width, height);
    paintAlpha(data.data, alpha, tint);
    ctx.putImageData(data, 0, 0);
  }

  /** One step of history: whatever `change` does, undone as one. */
  function step(change: () => void) {
    history?.push(read());
    change();
    version++;
  }

  function undo() {
    const previous = history?.undo(read());
    if (previous) write(previous);
    version++;
  }

  function redo() {
    const next = history?.redo(read());
    if (next) write(next);
    version++;
  }

  function where(event: PointerEvent) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      at: toImage({ x: event.clientX, y: event.clientY }, rect, { width, height }),
      scale: rect.width / width,
    };
  }

  function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const ctx = context();
    if (!ctx) return;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = `rgb(${tint.join(" ")})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (from.x === to.x && from.y === to.y) {
      ctx.beginPath();
      ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function onPointerDown(event: PointerEvent) {
    if (!ready || event.button !== 0) return;
    const hit = where(event);
    if (!hit) return;
    event.preventDefault();
    canvas?.setPointerCapture(event.pointerId);
    history?.push(read());
    drawing = true;
    // Painting over a hidden mask would be painting blind.
    hidden = false;
    last = hit.at;
    stroke(hit.at, hit.at);
  }

  function onPointerMove(event: PointerEvent) {
    const hit = where(event);
    if (!hit) return;
    pointer = { x: event.clientX, y: event.clientY, scale: hit.scale };
    if (!drawing || !last) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    for (const each of events.length > 0 ? events : [event]) {
      const point = where(each);
      if (!point) continue;
      stroke(last, point.at);
      last = point.at;
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (!drawing) return;
    drawing = false;
    last = null;
    canvas?.releasePointerCapture(event.pointerId);
    version++;
  }

  function onInvert() {
    step(() => write(invert(read())));
  }

  function onClear() {
    step(() => context()?.clearRect(0, 0, width, height));
  }

  async function done() {
    if (!ready || saving) return;
    const alpha = read();
    if (isBlank(alpha)) {
      await ondone(null);
      return;
    }
    saving = true;
    error = null;
    try {
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const octx = out.getContext("2d")!;
      const data = octx.createImageData(width, height);
      data.data.set(maskPixels(alpha));
      octx.putImageData(data, 0, 0);
      const png = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, "image/png"),
      );
      if (!png) throw new Error("the browser would not write the mask");
      await ondone(png);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }

  /**
   * The editor owns the keyboard while it is open: the screen behind it
   * would otherwise take `close` as "leave the viewer" and the arrows as
   * "move the selection" underneath a modal (§11.4). Captured on the window
   * so nothing behind it hears a key at all.
   */
  function onKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    // The size slider keeps its own arrows; everything else is ours.
    if (target?.tagName === "INPUT" && event.key !== "Escape") return;
    const action = app.keyAction(event);
    switch (action) {
      case "close":
        event.preventDefault();
        oncancel();
        return;
      case "brush_smaller":
        size = stepBrush(size, -1, range);
        return;
      case "brush_larger":
        size = stepBrush(size, 1, range);
        return;
      case "undo":
        undo();
        return;
      case "redo":
        redo();
        return;
    }
  }

  $effect(() => {
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => window.removeEventListener("keydown", onKeydown, { capture: true });
  });

  function keyHint(action: string): string {
    const keys = app.config?.keys?.[action];
    return keys && keys.length > 0 ? ` (${keys.join(" / ")})` : "";
  }
</script>

<div class="mask-editor" role="dialog" aria-modal="true" aria-label={`Paint ${label}`}>
  <div class="bar">
    <span class="title">{label}</span>
    <div class="group" role="radiogroup" aria-label="Tool">
      <button
        role="radio"
        aria-checked={tool === "brush"}
        class:on={tool === "brush"}
        title="Brush: paint what should be repainted"
        onclick={() => (tool = "brush")}
      >
        <Brush size={14} /> Brush
      </button>
      <button
        role="radio"
        aria-checked={tool === "eraser"}
        class:on={tool === "eraser"}
        title="Eraser: take paint off"
        onclick={() => (tool = "eraser")}
      >
        <Eraser size={14} /> Eraser
      </button>
    </div>
    <label
      class="size"
      title={`Brush size, in the picture's pixels${keyHint("brush_smaller")}${keyHint("brush_larger")}`}
    >
      <span class="dim">Size</span>
      <input
        type="range"
        aria-label="Brush size"
        min={range.min}
        max={range.max}
        bind:value={size}
      />
      <span class="mono num">{size}</span>
    </label>
    <div class="group">
      <button title={`Undo${keyHint("undo")}`} disabled={!canUndo} onclick={undo}>
        <Undo2 size={14} /> Undo
      </button>
      <button title={`Redo${keyHint("redo")}`} disabled={!canRedo} onclick={redo}>
        <Redo2 size={14} /> Redo
      </button>
    </div>
    <div class="group">
      <button
        title="Swap what is painted and what is not"
        disabled={!ready}
        onclick={onInvert}
      >
        <Contrast size={14} /> Invert
      </button>
      <button title="Take all the paint off" disabled={!ready} onclick={onClear}>
        <Trash2 size={14} /> Clear
      </button>
      <button
        aria-pressed={hidden}
        class:on={hidden}
        title="See the picture under the mask"
        onclick={() => (hidden = !hidden)}
      >
        {#if hidden}<EyeOff size={14} /> Show mask{:else}<Eye size={14} /> Hide mask{/if}
      </button>
    </div>
    <span class="spacer"></span>
    {#if error}<span class="error mono">{error}</span>{/if}
    <button title={`Leave the mask as it was${keyHint("close")}`} onclick={oncancel}
      >Cancel</button
    >
    <button class="primary" disabled={!ready || saving} onclick={done}>
      {saving ? "Saving…" : "Done"}
    </button>
  </div>

  <div class="stage">
    <div class="room">
      <div class="frame">
        <img src={image} alt="" draggable="false" />
        <canvas
          bind:this={canvas}
          {width}
          {height}
          class:hidden
          data-mask-canvas
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          onpointerleave={() => (pointer = null)}
        ></canvas>
      </div>
    </div>
    {#if pointer && ready}
      <div
        class="cursor"
        class:eraser={tool === "eraser"}
        style:left={`${pointer.x}px`}
        style:top={`${pointer.y}px`}
        style:width={`${size * pointer.scale}px`}
        style:height={`${size * pointer.scale}px`}
      ></div>
    {/if}
  </div>
  <p class="hint dim">
    Paint over what should change. Everything left unpainted is kept exactly as it is.
  </p>
</div>

<style>
  .mask-editor {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    flex-direction: column;
    /* Opaque: the panel behind it showing through is only noise next to
       a picture being looked at this closely. */
    background: var(--canvas);
  }

  .bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 14px;
    background: var(--panel);
  }

  .title {
    font-size: 13px;
    color: var(--text);
    margin-right: 6px;
  }

  .group {
    display: flex;
    gap: 2px;
    background: var(--control);
    border-radius: var(--radius-control);
    padding: 2px;
  }

  .group button {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    padding: 4px 8px;
  }

  .group button:hover:not(:disabled) {
    color: var(--text);
  }

  .group button.on {
    background: var(--control-selected);
    color: var(--text);
  }

  .group button:disabled {
    opacity: 0.4;
  }

  .size {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .size input {
    width: 140px;
  }

  .num {
    min-width: 3ch;
    font-size: 11px;
    color: var(--text-2);
  }

  .spacer {
    flex: 1;
  }

  .primary {
    background: var(--accent);
    color: #08191d;
    font-size: 12px;
    padding: 5px 14px;
  }

  .error {
    color: var(--error);
    font-size: 11px;
  }

  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  /* The room under the toolbar, whatever it wrapped to: the picture is
     sized against this box rather than the window. */
  .room {
    flex: 1;
    align-self: stretch;
    margin: 16px;
    container-type: size;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .frame {
    position: relative;
    line-height: 0;
  }

  .frame img {
    display: block;
    max-width: 100cqw;
    max-height: 100cqh;
    user-select: none;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.55;
    cursor: none;
    touch-action: none;
  }

  canvas.hidden {
    opacity: 0;
  }

  /* The brush's own footprint, so its size is never a guess (§10). */
  .cursor {
    position: fixed;
    pointer-events: none;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 1px solid #fff;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 60%);
  }

  .cursor.eraser {
    border-style: dashed;
  }

  .hint {
    margin: 0;
    padding: 0 0 12px;
    text-align: center;
    font-size: 11px;
  }
</style>
