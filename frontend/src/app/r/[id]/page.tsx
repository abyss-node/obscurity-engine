import { getShare } from "@/lib/shareStore";
import { ReadonlyResults } from "@/components/ReadonlyResults";

// In-memory fallback state lives in a per-process singleton; force Node runtime
// and dynamic rendering so this page reads the same store the writer wrote to.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function MissingShare() {
  return (
    <div className="min-h-screen flex items-start justify-center px-6 py-[15vh]">
      <div className="w-full max-w-md flex flex-col items-center gap-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <span
            className="font-mono text-[11px] tracking-widest uppercase"
            style={{ color: "var(--dim)" }}
          >
            [404] link expired
          </span>
          <h1
            className="font-serif text-3xl md:text-4xl font-bold italic leading-tight"
            style={{ color: "var(--text)" }}
          >
            This share has drifted<br />out of range.
          </h1>
          <p
            className="font-body text-sm font-light max-w-xs leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            Share links live for 30 days. This one is missing or has expired —
            but you can run your own in a few seconds.
          </p>
        </div>
        <a
          href="/"
          className="font-mono text-[11px] tracking-widest transition-opacity duration-200 hover:opacity-60"
          style={{ color: "var(--accent)" }}
        >
          get your own →
        </a>
      </div>
    </div>
  );
}

export default async function SharedResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const payload = await getShare(id);

  if (!payload || payload.mode !== "artists" || payload.recommendations.length === 0) {
    return <MissingShare />;
  }

  return <ReadonlyResults payload={payload} />;
}
