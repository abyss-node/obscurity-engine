import { getShareRaw } from "@/lib/shareStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const raw = await getShareRaw(id);
  if (raw === null) {
    return Response.json({ error: "share not found or expired" }, { status: 404 });
  }
  // Return the exact stored bytes so the payload roundtrips identically.
  return new Response(raw, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
