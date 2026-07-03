// Postgres persistence layer (Phase 1) — graceful-fallback by construction.
//
// `Db::connect()` returns `None` when `DATABASE_URL` is unset, and the whole
// server behaves byte-identically to the pre-persistence build: discovery still
// runs, the new response fields are null, every write endpoint no-ops or 503s.
// When the var is SET, a pool is built (lazily, so a DB that is down at boot
// never blocks startup), migrations are applied, and a background writer drains
// a bounded queue of persistence jobs OFF the request path.
//
// Two write disciplines:
//   * On the request path (awaited, ~1s acquire_timeout): auth (user upsert,
//     session create/lookup/delete), me/* reads, the dismissed-set read, the
//     rec/run existence+TTL check, purge. These must be reflected in the response.
//   * Off the request path (spawned, bounded mpsc, drop+log when full): the
//     analytics side-effects — runs+recommendations, impressions on cache hits,
//     observation batches, and events (incl. save/dismiss derived-table updates).
//     A cache hit therefore adds ZERO awaited DB work: latency stays as today.
//
// Runtime queries only (`sqlx::query*`, never the `query!` macros), so
// `cargo build`/`cargo test` are green with no DATABASE_URL and no live DB.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::QueryBuilder;
use tokio::sync::mpsc;
use uuid::Uuid;

/// Bounded write-queue depth. At <50 users/week the worker drains in
/// sub-millisecond time; the bound exists only so a stalled DB can't grow the
/// queue without limit — excess jobs are dropped and logged, never awaited.
const WRITE_QUEUE_CAP: usize = 4096;

/// How long a request-path query waits for a pooled connection before giving up.
/// Keeps "DB slow" from turning into "request slow": on timeout the caller logs
/// and falls back (reads return empty, the discovery still serves).
const ACQUIRE_TIMEOUT: Duration = Duration::from_millis(1000);

/// Acceptance window for events referencing a rec_id (pinned contract: 24h).
const REC_TTL: Duration = Duration::from_secs(24 * 3600);

// ── Records passed to the off-path writer ───────────────────────────────────

#[derive(Clone)]
pub struct RunRecord {
    pub run_id: Uuid,
    pub user_id: Option<Uuid>,
    pub username: String,
    pub period: String,
    pub appetite: String,
    pub depth_score: f64,
    pub active_seed_count: i32,
    pub top_genres: serde_json::Value,
}

#[derive(Clone)]
pub struct RecRecord {
    pub rec_id: Uuid,
    pub artist_name: String,
    pub artist_name_norm: String,
    pub rank: i32,
    pub conviction_score: i32,
    pub composite_score: f64,
    pub total_listeners: i64,
}

#[derive(Clone)]
pub struct ObsRecord {
    pub artist_name_norm: String,
    pub mbid: Option<String>,
    pub listeners: i64,
}

/// Derived-table mutation carried alongside a save/dismiss event.
#[derive(Clone)]
pub enum Derived {
    Save { rec_id: Uuid, artist_name: String, artist_name_norm: String },
    Unsave { artist_name_norm: String },
    Dismiss { rec_id: Uuid, artist_name: String, artist_name_norm: String },
    UndoDismiss { artist_name_norm: String },
}

#[derive(Clone)]
pub struct EventRecord {
    pub id: Uuid,
    pub run_id: Option<Uuid>,
    pub rec_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub event_type: String,
    pub target: Option<String>,
    pub dedup_key: Option<String>,
    pub derived: Option<Derived>,
}

/// A unit of off-path persistence work.
enum WriteJob {
    Run {
        run: RunRecord,
        recs: Vec<RecRecord>,
        observations: Vec<ObsRecord>,
    },
    Impression {
        run_id: Uuid,
    },
    Event(EventRecord),
}

// ── Request-path read/return types ──────────────────────────────────────────

/// The authenticated principal resolved from a bearer token.
#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub user_id: Uuid,
    pub username: String,
}

/// Metadata for a rec_id that is present AND within the TTL window.
#[derive(Debug, Clone)]
pub struct RecMeta {
    pub run_id: Uuid,
    pub artist_name: String,
    pub artist_name_norm: String,
}

pub struct Db {
    pool: PgPool,
    tx: mpsc::Sender<WriteJob>,
}

impl Db {
    /// Connect + migrate + spawn the writer. Returns `None` when `DATABASE_URL`
    /// is unset (persistence disabled — the graceful-fallback default). When the
    /// var is SET but the DB is unreachable, this still returns `Some` (a lazy
    /// pool that recovers on its own); the migration failure is logged LOUDLY so
    /// a misconfiguration is never silent, and writes drop+log until it recovers.
    pub async fn connect() -> Option<Self> {
        let url = std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty())?;

        // Lazy pool: constructing it never touches the network, so a DB that is
        // down at boot doesn't block startup.
        let pool = match PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect_lazy(&url)
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("DATABASE_URL is set but malformed ({e}); persistence disabled");
                return None;
            }
        };

        // Additive-only migrations, applied on boot. A failure here means the DB
        // is currently unreachable — loud, but non-fatal (server still serves).
        match sqlx::migrate!("./migrations").run(&pool).await {
            Ok(()) => println!("Postgres: connected and migrations applied"),
            Err(e) => eprintln!(
                "POSTGRES: DATABASE_URL set but migrations failed ({e}); \
                 serving without persistence until the DB is reachable"
            ),
        }

        let (tx, rx) = mpsc::channel::<WriteJob>(WRITE_QUEUE_CAP);
        let writer_pool = pool.clone();
        tokio::spawn(async move { writer_loop(writer_pool, rx).await });

        Some(Self { pool, tx })
    }

    /// Best-effort connectivity probe for `/api/status` (ok vs error). Cheap
    /// `SELECT 1` bounded by the acquire timeout.
    pub async fn ping(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    // ── Auth (request path) ─────────────────────────────────────────────────

    /// Upsert a user by normalized username, returning the synthetic id. A
    /// rename that only changes case resolves to the same row (normalized key).
    pub async fn upsert_user(&self, username_norm: &str) -> Result<Uuid, sqlx::Error> {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (id, lastfm_username) VALUES ($1, $2)
             ON CONFLICT (lastfm_username) DO UPDATE SET lastfm_username = EXCLUDED.lastfm_username
             RETURNING id",
        )
        .bind(Uuid::new_v4())
        .bind(username_norm)
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn create_session(
        &self,
        user_id: Uuid,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(token_hash)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Resolve a session by token hash, enforcing expiry. Returns `None` for
    /// unknown or expired sessions.
    pub async fn lookup_session(&self, token_hash: &str) -> Option<AuthedUser> {
        let row: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT u.id, u.lastfm_username FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = $1 AND s.expires_at > now()",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .unwrap_or_else(|e| {
            eprintln!("POSTGRES: session lookup failed: {e}");
            None
        });
        row.map(|(user_id, username)| AuthedUser { user_id, username })
    }

    pub async fn delete_session(&self, token_hash: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ── Dismissal filter (request path) ─────────────────────────────────────

    /// The user's dismissed-artist normalized-name set. On any error, returns an
    /// empty set (fail-open: never breaks discovery because of a slow DB).
    pub async fn dismissed_norms(&self, user_id: Uuid) -> HashSet<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT artist_name_norm FROM dismissed_artists WHERE user_id = $1")
                .bind(user_id)
                .fetch_all(&self.pool)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("POSTGRES: dismissed_norms failed: {e}");
                    Vec::new()
                });
        rows.into_iter().map(|(n,)| n).collect()
    }

    // ── Events preconditions (request path) ─────────────────────────────────

    /// Is this rec_id present AND within the TTL window? `Some(meta)` = usable
    /// (proceed), `None` = unknown or expired (the caller returns 410).
    pub async fn rec_meta_fresh(&self, rec_id: Uuid) -> Option<RecMeta> {
        let ttl_secs = REC_TTL.as_secs() as f64;
        let row: (Uuid, String, String) = sqlx::query_as::<_, (Uuid, String, String)>(
            "SELECT run_id, artist_name, artist_name_norm FROM recommendations
             WHERE rec_id = $1 AND created_at > now() - make_interval(secs => $2)",
        )
        .bind(rec_id)
        .bind(ttl_secs)
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten()?;
        Some(RecMeta {
            run_id: row.0,
            artist_name: row.1,
            artist_name_norm: row.2,
        })
    }

    /// Does this run exist? Used by run-scoped events (share) and impressions.
    pub async fn run_exists(&self, run_id: Uuid) -> bool {
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM runs WHERE id = $1")
            .bind(run_id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .is_some()
    }

    // ── me/* (request path) ─────────────────────────────────────────────────

    /// Saved artists with their recommendation metadata (most recent first).
    pub async fn saved_list(&self, user_id: Uuid) -> Result<serde_json::Value, sqlx::Error> {
        let rows: Vec<(String, Option<Uuid>, Option<i64>, Option<f64>, DateTime<Utc>)> =
            sqlx::query_as(
                "SELECT s.artist_name, s.rec_id, r.total_listeners, r.composite_score, s.created_at
                 FROM saved_artists s
                 LEFT JOIN recommendations r ON r.rec_id = s.rec_id
                 WHERE s.user_id = $1
                 ORDER BY s.created_at DESC",
            )
            .bind(user_id)
            .fetch_all(&self.pool)
            .await?;
        let items: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|(name, rec_id, listeners, composite, created)| {
                json!({
                    "name": name,
                    "rec_id": rec_id.map(|u| u.to_string()),
                    "total_listeners": listeners,
                    "composite_score": composite,
                    "saved_at": created.to_rfc3339(),
                })
            })
            .collect();
        Ok(json!({ "saved": items }))
    }

    /// Full per-user JSON export (all rows keyed to the user).
    pub async fn export_data(&self, user: &AuthedUser) -> Result<serde_json::Value, sqlx::Error> {
        let saved = self.saved_list(user.user_id).await?;
        let dismissed: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT artist_name_norm, created_at FROM dismissed_artists WHERE user_id = $1 ORDER BY created_at DESC",
        )
        .bind(user.user_id)
        .fetch_all(&self.pool)
        .await?;
        let events: Vec<(String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT type, target, occurred_at FROM events WHERE user_id = $1 ORDER BY occurred_at DESC",
        )
        .bind(user.user_id)
        .fetch_all(&self.pool)
        .await?;
        let runs: Vec<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, period, appetite, created_at FROM runs WHERE user_id = $1 ORDER BY created_at DESC",
        )
        .bind(user.user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(json!({
            "user": { "id": user.user_id.to_string(), "username": user.username },
            "saved": saved.get("saved").cloned().unwrap_or(json!([])),
            "dismissed": dismissed.into_iter()
                .map(|(n, t)| json!({"artist": n, "dismissed_at": t.to_rfc3339()}))
                .collect::<Vec<_>>(),
            "events": events.into_iter()
                .map(|(ty, tg, t)| json!({"type": ty, "target": tg, "at": t.to_rfc3339()}))
                .collect::<Vec<_>>(),
            "runs": runs.into_iter()
                .map(|(id, p, a, t)| json!({"run_id": id.to_string(), "period": p, "appetite": a, "at": t.to_rfc3339()}))
                .collect::<Vec<_>>(),
        }))
    }

    /// Purge everything keyed to the user (privacy delete). Runs (and their
    /// cascaded recommendations/impressions/events) are removed; then the user
    /// row (cascading sessions, saved, dismissed). Transactional.
    pub async fn purge_user(&self, user_id: Uuid) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM runs WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ── Off-path enqueue (never awaited on a response) ──────────────────────

    pub fn enqueue_run(&self, run: RunRecord, recs: Vec<RecRecord>, observations: Vec<ObsRecord>) {
        self.enqueue(WriteJob::Run { run, recs, observations }, "run+recommendations");
    }

    pub fn enqueue_impression(&self, run_id: Uuid) {
        self.enqueue(WriteJob::Impression { run_id }, "impression");
    }

    pub fn enqueue_event(&self, ev: EventRecord) {
        self.enqueue(WriteJob::Event(ev), "event");
    }

    fn enqueue(&self, job: WriteJob, label: &str) {
        if let Err(e) = self.tx.try_send(job) {
            // Full (or closed) queue → drop and log. Never blocks the response.
            match e {
                mpsc::error::TrySendError::Full(_) => {
                    eprintln!("WRITE QUEUE: full, dropping {label} write")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    eprintln!("WRITE QUEUE: writer closed, dropping {label} write")
                }
            }
        }
    }
}

// ── Background writer ───────────────────────────────────────────────────────

async fn writer_loop(pool: PgPool, mut rx: mpsc::Receiver<WriteJob>) {
    while let Some(job) = rx.recv().await {
        let result = match job {
            WriteJob::Run { run, recs, observations } => {
                write_run(&pool, run, recs, observations).await
            }
            WriteJob::Impression { run_id } => write_impression(&pool, run_id).await,
            WriteJob::Event(ev) => write_event(&pool, ev).await,
        };
        if let Err(e) = result {
            eprintln!("WRITE QUEUE: job failed (dropped): {e}");
        }
    }
}

async fn write_run(
    pool: &PgPool,
    run: RunRecord,
    recs: Vec<RecRecord>,
    observations: Vec<ObsRecord>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO runs (id, user_id, username, period, appetite, depth_score, active_seed_count, top_genres)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
    )
    .bind(run.run_id)
    .bind(run.user_id)
    .bind(&run.username)
    .bind(&run.period)
    .bind(&run.appetite)
    .bind(run.depth_score)
    .bind(run.active_seed_count)
    .bind(&run.top_genres)
    .execute(&mut *tx)
    .await?;

    if !recs.is_empty() {
        let mut qb = QueryBuilder::new(
            "INSERT INTO recommendations (rec_id, run_id, artist_name, artist_name_norm, rank, conviction_score, composite_score, total_listeners) ",
        );
        qb.push_values(recs.iter(), |mut b, r| {
            b.push_bind(r.rec_id)
                .push_bind(run.run_id)
                .push_bind(&r.artist_name)
                .push_bind(&r.artist_name_norm)
                .push_bind(r.rank)
                .push_bind(r.conviction_score)
                .push_bind(r.composite_score)
                .push_bind(r.total_listeners);
        });
        qb.push(" ON CONFLICT (rec_id) DO NOTHING");
        qb.build().execute(&mut *tx).await?;
    }

    // Observations: one batched INSERT .. ON CONFLICT DO NOTHING, one row per
    // artist/day. Deduped in-memory first so a single run can't collide with
    // itself inside the batch (Postgres rejects duplicate keys in one INSERT).
    let observations = dedup_observations(observations);
    if !observations.is_empty() {
        let mut qb = QueryBuilder::new(
            "INSERT INTO artist_observations (artist_name_norm, mbid, listeners) ",
        );
        qb.push_values(observations.iter(), |mut b, o| {
            b.push_bind(&o.artist_name_norm)
                .push_bind(&o.mbid)
                .push_bind(o.listeners);
        });
        qb.push(" ON CONFLICT (artist_name_norm, observed_on) DO NOTHING");
        qb.build().execute(&mut *tx).await?;
    }

    tx.commit().await
}

/// Collapse duplicate normalized-name observations within a single run so the
/// batched INSERT carries at most one row per artist (the DB's per-day unique
/// index then dedups across runs).
fn dedup_observations(observations: Vec<ObsRecord>) -> Vec<ObsRecord> {
    let mut seen: HashSet<String> = HashSet::new();
    observations
        .into_iter()
        .filter(|o| seen.insert(o.artist_name_norm.clone()))
        .collect()
}

async fn write_impression(pool: &PgPool, run_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO impressions (id, run_id, source) VALUES ($1, $2, 'cache_hit')")
        .bind(Uuid::new_v4())
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn write_event(pool: &PgPool, ev: EventRecord) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    // Dedup: ON CONFLICT DO NOTHING against the partial unique index (only bites
    // when a dedup_key was supplied); genuine keyless clicks all persist.
    sqlx::query(
        "INSERT INTO events (id, run_id, rec_id, user_id, type, target, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING",
    )
    .bind(ev.id)
    .bind(ev.run_id)
    .bind(ev.rec_id)
    .bind(ev.user_id)
    .bind(&ev.event_type)
    .bind(&ev.target)
    .bind(&ev.dedup_key)
    .execute(&mut *tx)
    .await?;

    if let (Some(user_id), Some(derived)) = (ev.user_id, ev.derived) {
        match derived {
            Derived::Save { rec_id, artist_name, artist_name_norm } => {
                sqlx::query(
                    "INSERT INTO saved_artists (id, user_id, rec_id, artist_name, artist_name_norm)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (user_id, artist_name_norm) DO UPDATE SET rec_id = EXCLUDED.rec_id",
                )
                .bind(Uuid::new_v4())
                .bind(user_id)
                .bind(rec_id)
                .bind(&artist_name)
                .bind(&artist_name_norm)
                .execute(&mut *tx)
                .await?;
            }
            Derived::Unsave { artist_name_norm } => {
                sqlx::query("DELETE FROM saved_artists WHERE user_id = $1 AND artist_name_norm = $2")
                    .bind(user_id)
                    .bind(&artist_name_norm)
                    .execute(&mut *tx)
                    .await?;
            }
            Derived::Dismiss { rec_id, artist_name: _, artist_name_norm } => {
                sqlx::query(
                    "INSERT INTO dismissed_artists (id, user_id, rec_id, artist_name_norm)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (user_id, artist_name_norm) DO NOTHING",
                )
                .bind(Uuid::new_v4())
                .bind(user_id)
                .bind(rec_id)
                .bind(&artist_name_norm)
                .execute(&mut *tx)
                .await?;
            }
            Derived::UndoDismiss { artist_name_norm } => {
                sqlx::query(
                    "DELETE FROM dismissed_artists WHERE user_id = $1 AND artist_name_norm = $2",
                )
                .bind(user_id)
                .bind(&artist_name_norm)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    tx.commit().await
}

// ── Test-only helpers (awaited writes + counts) ─────────────────────────────
// Compiled only under `cargo test`. They let integration tests exercise the
// exact write paths synchronously (no queue-drain races) and assert row counts.
#[cfg(test)]
impl Db {
    /// Awaited version of the run persistence job (bypasses the off-path queue).
    pub async fn test_persist_run(
        &self,
        run: RunRecord,
        recs: Vec<RecRecord>,
        observations: Vec<ObsRecord>,
    ) -> Result<(), sqlx::Error> {
        write_run(&self.pool, run, recs, observations).await
    }

    /// Awaited version of the event write (incl. derived save/dismiss mutation).
    pub async fn test_process_event(&self, ev: EventRecord) -> Result<(), sqlx::Error> {
        write_event(&self.pool, ev).await
    }

    pub async fn test_count_observations(&self, norm: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM artist_observations WHERE artist_name_norm = $1")
            .bind(norm)
            .fetch_one(&self.pool)
            .await
            .unwrap_or(-1)
    }

    pub async fn test_count_events(&self, rec_id: Uuid, ty: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM events WHERE rec_id = $1 AND type = $2")
            .bind(rec_id)
            .bind(ty)
            .fetch_one(&self.pool)
            .await
            .unwrap_or(-1)
    }

    pub async fn test_count_impressions(&self, run_id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM impressions WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&self.pool)
            .await
            .unwrap_or(-1)
    }

    /// Insert a recommendation whose `created_at` is backdated by `age_secs`, so
    /// tests can exercise the 24h TTL (expired → 410) path deterministically.
    pub async fn test_insert_backdated_rec(
        &self,
        rec_id: Uuid,
        run: RunRecord,
        artist_name: &str,
        age_secs: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO runs (id, user_id, username, period, appetite) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
        )
        .bind(run.run_id)
        .bind(run.user_id)
        .bind(&run.username)
        .bind(&run.period)
        .bind(&run.appetite)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "INSERT INTO recommendations (rec_id, run_id, artist_name, artist_name_norm, rank, created_at)
             VALUES ($1, $2, $3, $4, 1, now() - make_interval(secs => $5))",
        )
        .bind(rec_id)
        .bind(run.run_id)
        .bind(artist_name)
        .bind(crate::utils::normalize_artist_name(artist_name))
        .bind(age_secs as f64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Enqueue an impression and wait briefly for the off-path writer to drain,
    /// so the cache-hit impression can be asserted without a race.
    pub async fn test_drain(&self) {
        // The queue is FIFO on a single worker; a short yield-loop lets it flush.
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_observations_keeps_first_per_norm() {
        let obs = vec![
            ObsRecord { artist_name_norm: "a".into(), mbid: None, listeners: 10 },
            ObsRecord { artist_name_norm: "b".into(), mbid: None, listeners: 20 },
            ObsRecord { artist_name_norm: "a".into(), mbid: None, listeners: 99 },
        ];
        let out = dedup_observations(obs);
        assert_eq!(out.len(), 2, "one row per normalized name within a run");
        let a = out.iter().find(|o| o.artist_name_norm == "a").unwrap();
        assert_eq!(a.listeners, 10, "first observation wins in the batch");
    }
}
