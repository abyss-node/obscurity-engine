const TTL_MS = 15 * 60 * 1000; // 15 minutes
const KEY_PREFIX = "obscurity_cache_";

function key(username: string, period: string, mode: string): string {
  return `${KEY_PREFIX}${username}_${period}_${mode}`;
}

export function loadCache<T>(username: string, period: string, mode: string): T | null {
  try {
    const raw = localStorage.getItem(key(username, period, mode));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { data: T; ts: number };
    if (Date.now() - entry.ts > TTL_MS) {
      localStorage.removeItem(key(username, period, mode));
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function saveCache<T>(username: string, period: string, mode: string, data: T): void {
  try {
    localStorage.setItem(key(username, period, mode), JSON.stringify({ data, ts: Date.now() }));
  } catch {
    pruneExpired();
    try {
      localStorage.setItem(key(username, period, mode), JSON.stringify({ data, ts: Date.now() }));
    } catch { /* localStorage full and still failing — silently skip */ }
  }
}

function pruneExpired(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(KEY_PREFIX)) continue;
    try {
      const raw = localStorage.getItem(k);
      if (!raw) { toRemove.push(k); continue; }
      const entry = JSON.parse(raw) as { ts: number };
      if (Date.now() - entry.ts > TTL_MS) toRemove.push(k);
    } catch {
      toRemove.push(k!);
    }
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
}
