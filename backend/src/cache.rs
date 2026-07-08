// Pluggable result cache for the discovery endpoints.
//
// `CacheStore` is an enum over two backends that share one API:
//   * `InMemoryStore` — the default. Keeps exactly the semantics the server has
//     always had: a `HashMap` guarded by an `RwLock`, TTL checked on read.
//   * `RedisStore` — opt-in via `REDIS_URL`. JSON payloads with a server-side
//     `SET … EX <ttl>`. Any connection/serialization error logs a warning and
//     degrades to a cache miss so a flaky Redis never fails a user request.
//
// Values are stored as JSON strings, so the same store serves both
// `DiscoveryResponse` and `TrackDiscoveryResponse` (keys are already namespaced
// by the callers, e.g. `reverse_scrobble:…` vs `tracks:…`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

/// Default cache TTL — one hour, matching the server's long-standing behavior.
pub const DEFAULT_TTL_SECS: u64 = 3600;

/// A value retrieved from a cache store: the raw JSON payload that was stored.
#[derive(Clone, Debug)]
pub struct CachedResult {
    pub value: String,
}

/// The active cache backend. An enum (rather than a `dyn` trait object) keeps
/// the `async fn` methods object-safe without pulling in `async-trait`.
pub enum CacheStore {
    InMemory(InMemoryStore),
    Redis(RedisStore),
}

impl CacheStore {
    /// Fetch a raw cached value. Returns `None` on a miss, an expired entry, or
    /// any backend error (errors degrade to a miss and are logged).
    pub async fn get(&self, key: &str) -> Option<CachedResult> {
        match self {
            CacheStore::InMemory(s) => s.get(key).await,
            CacheStore::Redis(s) => s.get(key).await,
        }
    }

    /// Store a raw value with a TTL. Backend errors are logged and swallowed —
    /// a failed write is never fatal, it just means the next read is a miss.
    pub async fn put(&self, key: &str, value: CachedResult, ttl: Duration) {
        match self {
            CacheStore::InMemory(s) => s.put(key, value, ttl).await,
            CacheStore::Redis(s) => s.put(key, value, ttl).await,
        }
    }

    /// Status probe for `/api/status`. `None` when this is the in-memory store
    /// (Redis not in use); `Some(true|false)` when Redis-backed and reachable or
    /// not. Never affects request handling.
    pub async fn redis_status(&self) -> Option<bool> {
        match self {
            CacheStore::InMemory(_) => None,
            CacheStore::Redis(s) => Some(s.ping().await),
        }
    }

    /// Typed convenience: deserialize a cached JSON payload. A deserialization
    /// failure is treated as a miss (logged), never an error to the caller.
    pub async fn get_json<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let cached = self.get(key).await?;
        match serde_json::from_str(&cached.value) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("Cache deserialize error for {key}: {e}");
                None
            }
        }
    }

    /// Typed convenience: JSON-serialize and store a value. A serialization
    /// failure is logged and the value simply isn't cached.
    pub async fn put_json<T: Serialize>(&self, key: &str, value: &T, ttl: Duration) {
        match serde_json::to_string(value) {
            Ok(s) => self.put(key, CachedResult { value: s }, ttl).await,
            Err(e) => eprintln!("Cache serialize error for {key}: {e}"),
        }
    }
}

// ── In-memory store ───────────────────────────────────────────────────────────

struct Entry {
    expires_at: Instant,
    value: String,
}

/// The default process-local cache: a `HashMap` behind an `RwLock`, with the
/// TTL enforced on read. Identical in behavior to the original inline cache.
pub struct InMemoryStore {
    map: RwLock<HashMap<String, Entry>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            map: RwLock::new(HashMap::new()),
        }
    }

    async fn get(&self, key: &str) -> Option<CachedResult> {
        let map = self.map.read().await;
        let entry = map.get(key)?;
        if Instant::now() < entry.expires_at {
            Some(CachedResult {
                value: entry.value.clone(),
            })
        } else {
            None
        }
    }

    async fn put(&self, key: &str, value: CachedResult, ttl: Duration) {
        let mut map = self.map.write().await;
        map.insert(
            key.to_string(),
            Entry {
                expires_at: Instant::now() + ttl,
                value: value.value,
            },
        );
    }
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Redis store ─────────────────────────────────────────────────────────────

/// Upper bound on any single Redis operation — the lazy connect and every
/// GET/SET/PING. redis 0.25's `ConnectionManager` has no built-in timeouts, so
/// without this a half-open Upstash TLS connection hangs callers indefinitely;
/// with it they degrade to a cache miss like every other Redis failure.
const REDIS_OP_TIMEOUT: Duration = Duration::from_secs(5);

/// Redis-backed store using a tokio async `ConnectionManager` (auto-reconnect).
/// The manager is created lazily on first use, so constructing the store never
/// fails and a Redis that is down at startup simply degrades reads/writes to
/// misses until it recovers.
pub struct RedisStore {
    client: redis::Client,
    manager: Mutex<Option<redis::aio::ConnectionManager>>,
}

impl RedisStore {
    /// Build a store from a Redis URL. Only parses the URL; the connection is
    /// established lazily. Errors here mean the URL itself is malformed.
    pub fn new(url: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(url)?;
        Ok(Self {
            client,
            manager: Mutex::new(None),
        })
    }

    /// Get (or lazily create) a cloned connection manager. Returns `None` and
    /// logs if a connection can't be established — callers degrade to a miss.
    ///
    /// The connect is bounded by `REDIS_OP_TIMEOUT` and runs OUTSIDE the lock:
    /// redis 0.25 has no built-in connect/response timeouts, so a hung Upstash
    /// TLS handshake would otherwise hold the process-wide manager lock forever
    /// and wedge every cache caller behind it (2026-07-05 incident class).
    /// Concurrent first-callers may race duplicate connects; last write wins,
    /// which is harmless — clones share one multiplexed connection anyway.
    async fn manager(&self) -> Option<redis::aio::ConnectionManager> {
        if let Some(m) = self.manager.lock().await.as_ref() {
            return Some(m.clone());
        }
        match tokio::time::timeout(REDIS_OP_TIMEOUT, self.client.get_connection_manager()).await {
            Ok(Ok(m)) => {
                *self.manager.lock().await = Some(m.clone());
                Some(m)
            }
            Ok(Err(e)) => {
                eprintln!("Redis connection error, degrading to cache miss: {e}");
                None
            }
            Err(_) => {
                eprintln!(
                    "Redis connect timed out after {REDIS_OP_TIMEOUT:?}, degrading to cache miss"
                );
                None
            }
        }
    }

    /// Best-effort connectivity probe used at startup for the log line. Never
    /// affects request handling.
    pub async fn ping(&self) -> bool {
        let Some(mut conn) = self.manager().await else {
            return false;
        };
        matches!(
            tokio::time::timeout(
                REDIS_OP_TIMEOUT,
                redis::cmd("PING").query_async::<_, String>(&mut conn),
            )
            .await,
            Ok(Ok(_))
        )
    }

    async fn get(&self, key: &str) -> Option<CachedResult> {
        let mut conn = self.manager().await?;
        match tokio::time::timeout(
            REDIS_OP_TIMEOUT,
            redis::cmd("GET").arg(key).query_async::<_, Option<String>>(&mut conn),
        )
        .await
        {
            Ok(Ok(Some(v))) => Some(CachedResult { value: v }),
            Ok(Ok(None)) => None,
            Ok(Err(e)) => {
                eprintln!("Redis GET error for {key}, degrading to cache miss: {e}");
                None
            }
            Err(_) => {
                eprintln!("Redis GET timed out for {key}, degrading to cache miss");
                None
            }
        }
    }

    async fn put(&self, key: &str, value: CachedResult, ttl: Duration) {
        let Some(mut conn) = self.manager().await else {
            return;
        };
        // Redis requires EX >= 1; clamp defensively.
        let ttl_secs = ttl.as_secs().max(1);
        match tokio::time::timeout(
            REDIS_OP_TIMEOUT,
            redis::cmd("SET")
                .arg(key)
                .arg(value.value)
                .arg("EX")
                .arg(ttl_secs)
                .query_async::<_, ()>(&mut conn),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("Redis SET error for {key}, value not cached: {e}"),
            Err(_) => eprintln!("Redis SET timed out for {key}, value not cached"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
    struct Sample {
        name: String,
        n: u32,
    }

    fn cr(s: &str) -> CachedResult {
        CachedResult { value: s.to_string() }
    }

    #[tokio::test]
    async fn in_memory_roundtrip() {
        let store = CacheStore::InMemory(InMemoryStore::new());
        store.put("k", cr("hello"), Duration::from_secs(60)).await;
        assert_eq!(store.get("k").await.map(|c| c.value), Some("hello".to_string()));
    }

    #[tokio::test]
    async fn in_memory_miss() {
        let store = CacheStore::InMemory(InMemoryStore::new());
        assert!(store.get("absent").await.is_none());
    }

    #[tokio::test]
    async fn in_memory_ttl_expiry() {
        let store = CacheStore::InMemory(InMemoryStore::new());
        store.put("k", cr("v"), Duration::from_millis(50)).await;
        assert!(store.get("k").await.is_some(), "value present before TTL");
        tokio::time::sleep(Duration::from_millis(90)).await;
        assert!(store.get("k").await.is_none(), "value expired after TTL");
    }

    #[tokio::test]
    async fn in_memory_json_roundtrip() {
        let store = CacheStore::InMemory(InMemoryStore::new());
        let sample = Sample { name: "obscure".into(), n: 7 };
        store.put_json("j", &sample, Duration::from_secs(60)).await;
        let got: Option<Sample> = store.get_json("j").await;
        assert_eq!(got, Some(sample));
    }

    // ── Redis tests: gated on REDIS_URL. Skip cleanly (pass) when it is unset
    //    or the server is unreachable, so `cargo test` is green without Redis.

    fn redis_url() -> Option<String> {
        std::env::var("REDIS_URL").ok().filter(|s| !s.is_empty())
    }

    async fn redis_store_or_skip(test: &str) -> Option<CacheStore> {
        let Some(url) = redis_url() else {
            eprintln!("REDIS_URL unset — skipping {test}");
            return None;
        };
        let store = RedisStore::new(&url).expect("valid REDIS_URL");
        if !store.ping().await {
            eprintln!("REDIS_URL set but Redis unreachable — skipping {test}");
            return None;
        }
        Some(CacheStore::Redis(store))
    }

    #[tokio::test]
    async fn redis_roundtrip() {
        let Some(store) = redis_store_or_skip("redis_roundtrip").await else {
            return;
        };
        let key = format!("oe:test:roundtrip:{}", std::process::id());
        store.put(&key, cr("payload"), Duration::from_secs(60)).await;
        assert_eq!(store.get(&key).await.map(|c| c.value), Some("payload".to_string()));
    }

    #[tokio::test]
    async fn redis_ttl_expiry() {
        let Some(store) = redis_store_or_skip("redis_ttl_expiry").await else {
            return;
        };
        let key = format!("oe:test:ttl:{}", std::process::id());
        store.put(&key, cr("short"), Duration::from_secs(1)).await;
        assert!(store.get(&key).await.is_some(), "present before Redis TTL");
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(store.get(&key).await.is_none(), "expired after Redis TTL");
    }

    // Degrade-to-miss: a RedisStore pointed at an unreachable server must never
    // panic or error — get returns None, put is a no-op. This is the automated
    // analogue of "stop the container -> requests still succeed".
    #[tokio::test]
    async fn redis_degrade_to_miss_when_unreachable() {
        // Port 6390 is not the default Redis port and is expected to be closed.
        let store = CacheStore::Redis(
            RedisStore::new("redis://127.0.0.1:6390").expect("valid URL"),
        );
        // Neither call should panic or propagate an error.
        store.put("k", cr("v"), Duration::from_secs(60)).await;
        assert!(
            store.get("k").await.is_none(),
            "unreachable Redis must degrade to a cache miss"
        );
    }
}
