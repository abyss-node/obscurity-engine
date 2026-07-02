import {
  putShareRaw,
  validateSharePayload,
  MAX_PAYLOAD_BYTES,
} from "@/lib/shareStore";

// The in-memory fallback is a per-process singleton, so this route must run in
// the Node.js runtime (not the edge runtime) to share state with the reader.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();

  if (new TextEncoder().encode(raw).length > MAX_PAYLOAD_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const payload = validateSharePayload(parsed);
  if (!payload) {
    return Response.json({ error: "malformed share payload" }, { status: 400 });
  }

  try {
    const id = await putShareRaw(raw);
    return Response.json({ id }, { status: 201 });
  } catch {
    return Response.json({ error: "could not store share" }, { status: 500 });
  }
}
