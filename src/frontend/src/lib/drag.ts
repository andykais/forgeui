import type { Output } from "../types.ts";

/**
 * Dragging a take into a param (§11.2).
 *
 * What travels is the output's id rather than its bytes: the server already
 * has them, so the drop adopts the file into the input store instead of
 * uploading a copy of something it wrote itself (§9). The kind travels
 * beside it so a drop can refuse what it cannot use — an audio take in an
 * image param is accepted silently otherwise, and fails much later.
 *
 * One place, because a take shows up in four: the grid, the filmstrip, the
 * table and a model's samples. Only the grid could be dragged before, which
 * is a distinction nobody would guess at.
 */
export const OUTPUT_MIME = "application/x-forgeui-output";
export const OUTPUT_KIND_MIME = "application/x-forgeui-output-kind";

export function startOutputDrag(event: DragEvent, output: Output): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(OUTPUT_MIME, output.id);
  event.dataTransfer.setData(OUTPUT_KIND_MIME, output.kind);
  // So a drop somewhere else in the world gets something it can use.
  event.dataTransfer.setData("text/uri-list", output.media_url);
  event.dataTransfer.setData("text/plain", output.media_url);
  event.dataTransfer.effectAllowed = "copy";
}

/**
 * What a drag is carrying, as far as a param needs to know: the output's id
 * and its kind, or nulls when the drag is something else entirely (a file
 * from the desktop, a URL from another tab).
 */
export function draggedOutput(
  event: DragEvent,
): { id: string; kind: string | null } | null {
  const id = event.dataTransfer?.getData(OUTPUT_MIME);
  if (!id) return null;
  return { id, kind: event.dataTransfer?.getData(OUTPUT_KIND_MIME) || null };
}
