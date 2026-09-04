export function json(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Every failing route answers with this shape. */
export interface ApiError {
  error: { code: string; message: string };
}

export function error(
  status: number,
  code: string,
  message: string,
): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, { status });
}

export function badRequest(message: string, code = "bad_request"): Response {
  return error(400, code, message);
}

export function notFound(message = "not found"): Response {
  return error(404, "not_found", message);
}

export function methodNotAllowed(allowed: string[]): Response {
  const response = error(
    405,
    "method_not_allowed",
    `allowed: ${allowed.join(", ")}`,
  );
  response.headers.set("allow", allowed.join(", "));
  return response;
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new BodyError(
      `invalid JSON body: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

export class BodyError extends Error {
  override readonly name = "BodyError";
}
