import type { Artist } from "@/app/page";

/**
 * Persistent share-link store.
 *
 * Primary backend: an Upstash-Redis-compatible REST KV, configured via
 * `KV_REST_API_URL` + `KV_REST_API_TOKEN` (the Vercel Marketplace convention).
 * When those env vars are absent the store degrades to a module-level in-memory
 * Map. That fallback is fully functional in `next dev` and any single-instance
 * deployment; it is ephemeral (lost on restart, not shared across instances)
 * and is intentionally the zero-config default so the app runs identically to
 * today with no new environment variables.
 *
 * Values are stored as the exact JSON string that was POSTed so a later GET can
 * return a byte-identical payload.
 */

export const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const MAX_PAYLOAD_BYTES = 100 * 1024; // ~100KB hard cap
const ID_LENGTH = 10;
const KEY_PREFIX = "share:";

// URL-safe alphabet (RFC 4648 base64url minus padding) — 64 symbols.
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface SharePayload {
  username: string;
  period: string;
  mode: string;
  appetite: string;
  recommendations: Artist[];
  computedAt: number;
}

const ALLOWED_KEYS = new Set([
  "username",
  "period",
  "mode",
  "appetite",
  "recommendations",
  "computedAt",
]);

/**
 * Strict shape validator for the share payload. Returns the payload typed on
 * success, or `null` when anything is missing, the wrong type, or an unknown
 * key is present. Route handlers reject on `null`.
 */
export function validateSharePayload(data: unknown): SharePayload | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  // Reject any key we don't explicitly allow.
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }

  if (typeof obj.username !== "string" || obj.username.trim() === "") return null;
  if (typeof obj.period !== "string" || obj.period === "") return null;
  if (typeof obj.mode !== "string" || obj.mode === "") return null;
  if (typeof obj.appetite !== "string" || obj.appetite === "") return null;
  if (typeof obj.computedAt !== "number" || !Number.isFinite(obj.computedAt)) return null;
  if (!Array.isArray(obj.recommendations)) return null;
  for (const item of obj.recommendations) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    if (typeof (item as Record<string, unknown>).name !== "string") return null;
  }

  return obj as unknown as SharePayload;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function randomId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

function kvConfigured(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) return { url: url.replace(/\/$/, ""), token };
  return null;
}

// ── In-memory fallback ──────────────────────────────────────────────────────
// Pinned to globalThis so every route segment / module instance in the same
// Node process shares one Map. Next.js dev (and per-route bundling) can
// otherwise instantiate this module more than once, which would silently give
// the POST and GET handlers separate stores. Prod single-instance is unchanged.
type MemEntry = { value: string; expiresAt: number };
const globalForShare = globalThis as unknown as {
  __obsShareStore?: Map<string, MemEntry>;
};
const memStore: Map<string, MemEntry> =
  globalForShare.__obsShareStore ?? (globalForShare.__obsShareStore = new Map());

// ── Upstash REST helpers (single-command endpoint) ──────────────────────────
async function kvSet(
  kv: { url: string; token: string },
  key: string,
  value: string,
): Promise<void> {
  await fetch(kv.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["SET", key, value, "EX", String(SHARE_TTL_SECONDS)]),
  });
}

async function kvGet(
  kv: { url: string; token: string },
  key: string,
): Promise<string | null> {
  const res = await fetch(kv.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["GET", key]),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: string | null };
  return body.result ?? null;
}

/**
 * Store a raw JSON string and return its short id. Throws `RangeError` when the
 * payload exceeds {@link MAX_PAYLOAD_BYTES}.
 */
export async function putShareRaw(raw: string): Promise<string> {
  if (byteLength(raw) > MAX_PAYLOAD_BYTES) {
    throw new RangeError("share payload exceeds size cap");
  }
  const id = randomId();
  const key = KEY_PREFIX + id;
  const kv = kvConfigured();
  if (kv) {
    await kvSet(kv, key, raw);
  } else {
    memStore.set(key, { value: raw, expiresAt: Date.now() + SHARE_TTL_SECONDS * 1000 });
  }
  return id;
}

/** Fetch the raw stored JSON string for an id, or `null` if missing/expired. */
export async function getShareRaw(id: string): Promise<string | null> {
  const key = KEY_PREFIX + id;
  const kv = kvConfigured();
  if (kv) {
    return kvGet(kv, key);
  }
  const entry = memStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

/** Validate + serialize + store a payload, returning its share id. */
export async function putShare(payload: SharePayload): Promise<string> {
  return putShareRaw(JSON.stringify(payload));
}

/** Fetch and parse a stored payload, or `null` if missing/expired. */
export async function getShare(id: string): Promise<SharePayload | null> {
  const raw = await getShareRaw(id);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SharePayload;
  } catch {
    return null;
  }
}

/** Test-only: clear the in-memory fallback between cases. */
export function __resetMemStore(): void {
  memStore.clear();
}
