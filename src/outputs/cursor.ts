import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";

/**
 * Keyset pagination on `(created_at, id)` (§11.2). The cursor is opaque to
 * the client but carries no state on the server, so a reload with the same
 * cursor returns the same page.
 */
export interface OutputCursor {
  created_at: number;
  id: string;
}

export class CursorError extends Error {
  override readonly name = "CursorError";
}

export function encodeCursor(cursor: OutputCursor): string {
  return encodeBase64Url(
    new TextEncoder().encode(`${cursor.created_at}:${cursor.id}`),
  );
}

export function decodeCursor(value: string): OutputCursor {
  let text: string;
  try {
    text = new TextDecoder().decode(decodeBase64Url(value));
  } catch {
    throw new CursorError("cursor: not a valid cursor");
  }
  const separator = text.indexOf(":");
  if (separator <= 0) throw new CursorError("cursor: not a valid cursor");
  const createdAt = Number(text.slice(0, separator));
  const id = text.slice(separator + 1);
  if (!Number.isSafeInteger(createdAt) || id.length === 0) {
    throw new CursorError("cursor: not a valid cursor");
  }
  return { created_at: createdAt, id };
}
