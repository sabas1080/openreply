export class ApiError extends Error {
  /** `extra` is merged into the JSON error body (validation details, conflicts). */
  constructor(message: string, public status = 400, public extra?: Record<string, unknown>) { super(message); }
}

/** Bound streamed bodies too: Content-Length alone is client controlled. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError("application/json required", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("Empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError("Body too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError("Invalid JSON"); }
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = new URL(process.env.NEXTAUTH_URL ?? request.url).origin;
  // A panel served on another origin than NEXTAUTH_URL (e.g. a private port) lists it here.
  const extra = (process.env.ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (origin !== expected && !extra.includes(origin)) throw new ApiError("Origin not allowed", 403);
}

export function apiError(error: unknown) {
  const status = error instanceof ApiError ? error.status : 500;
  const body = status === 500 ? { error: "Internal error" }
    : { error: (error as Error).message, ...(error as ApiError).extra };
  return Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
