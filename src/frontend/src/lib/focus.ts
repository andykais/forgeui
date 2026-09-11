/**
 * Take the caret as soon as an element appears. The pickers mount their
 * search box on the click that opened them, so the focus is taken on the
 * next frame — after that click has finished — and typing can start without
 * a second one.
 */
export function focusOnMount(node: HTMLElement): { destroy(): void } {
  const frame = requestAnimationFrame(() => node.focus());
  return { destroy: () => cancelAnimationFrame(frame) };
}
