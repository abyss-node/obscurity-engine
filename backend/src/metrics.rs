// Lightweight, always-on request metrics.
//
// Process-wide atomic counters — no new dependencies (std::sync::atomic only),
// no env var required, and ZERO behavior change to any endpoint response. Each
// handled request does a single relaxed `fetch_add`; nothing here ever touches
// the response path. The server emits one structured summary line hourly (via a
// tokio interval) and once more on graceful shutdown, so a run's discovery/track
// volume and how much of it leaned on the shared key pool is observable from the
// logs without any external service.
use std::sync::atomic::{AtomicU64, Ordering};

/// Snapshot + running counters for served requests.
#[derive(Default)]
pub struct Metrics {
    /// Artist-discovery requests handled (`/api/discovery`).
    discovery: AtomicU64,
    /// Track-discovery requests handled (`/api/discovery/tracks`).
    tracks: AtomicU64,
    /// Requests served with the shared server key pool (no user-supplied key).
    pool_used: AtomicU64,
    /// Requests served with a user-supplied custom key (bypasses the pool).
    custom_key: AtomicU64,
    // ── Phase 1 event counters (E12 observability) ──────────────────────────
    /// Total accepted (204) events across all types.
    events: AtomicU64,
    /// `save` events accepted.
    saves: AtomicU64,
    /// `dismiss` events accepted.
    dismisses: AtomicU64,
    /// `click_listen` events accepted.
    clicks: AtomicU64,
    /// `share` events accepted.
    shares: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one artist-discovery request. `used_pool` is true when the request
    /// fell back to the shared server key pool (i.e. no custom key was supplied).
    pub fn record_discovery(&self, used_pool: bool) {
        self.discovery.fetch_add(1, Ordering::Relaxed);
        self.record_key_source(used_pool);
    }

    /// Record one track-discovery request. See `record_discovery`.
    pub fn record_tracks(&self, used_pool: bool) {
        self.tracks.fetch_add(1, Ordering::Relaxed);
        self.record_key_source(used_pool);
    }

    fn record_key_source(&self, used_pool: bool) {
        if used_pool {
            self.pool_used.fetch_add(1, Ordering::Relaxed);
        } else {
            self.custom_key.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Record one accepted (204) event by its type. Unknown types still count in
    /// the total. Pure bookkeeping — never touches a response.
    pub fn record_event(&self, event_type: &str) {
        self.events.fetch_add(1, Ordering::Relaxed);
        match event_type {
            "save" => { self.saves.fetch_add(1, Ordering::Relaxed); }
            "dismiss" => { self.dismisses.fetch_add(1, Ordering::Relaxed); }
            "click_listen" => { self.clicks.fetch_add(1, Ordering::Relaxed); }
            "share" => { self.shares.fetch_add(1, Ordering::Relaxed); }
            _ => {}
        }
    }

    /// Immutable snapshot of the current counters.
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            discovery: self.discovery.load(Ordering::Relaxed),
            tracks: self.tracks.load(Ordering::Relaxed),
            pool_used: self.pool_used.load(Ordering::Relaxed),
            custom_key: self.custom_key.load(Ordering::Relaxed),
            events: self.events.load(Ordering::Relaxed),
            saves: self.saves.load(Ordering::Relaxed),
            dismisses: self.dismisses.load(Ordering::Relaxed),
            clicks: self.clicks.load(Ordering::Relaxed),
            shares: self.shares.load(Ordering::Relaxed),
        }
    }

    /// One structured summary line for the logs. Pure over an atomic read, so
    /// it is safe to call from both the hourly interval task and the shutdown
    /// path. The `key_pool_share` is the fraction of served requests that used
    /// the shared server key pool (0.0 when nothing has been served yet).
    pub fn summary_line(&self) -> String {
        self.snapshot().summary_line()
    }
}

/// A point-in-time copy of the counters, decoupled from the atomics so it can be
/// formatted or asserted on without re-reading shared state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsSnapshot {
    pub discovery: u64,
    pub tracks: u64,
    pub pool_used: u64,
    pub custom_key: u64,
    pub events: u64,
    pub saves: u64,
    pub dismisses: u64,
    pub clicks: u64,
    pub shares: u64,
}

impl MetricsSnapshot {
    /// Fraction of served requests that used the shared key pool.
    pub fn key_pool_share(&self) -> f64 {
        let total = self.pool_used + self.custom_key;
        if total == 0 {
            0.0
        } else {
            self.pool_used as f64 / total as f64
        }
    }

    pub fn summary_line(&self) -> String {
        format!(
            "metrics discovery={} tracks={} pool_used={} custom_key={} key_pool_share={:.3} \
             events={} saves={} dismisses={} clicks={} shares={}",
            self.discovery,
            self.tracks,
            self.pool_used,
            self.custom_key,
            self.key_pool_share(),
            self.events,
            self.saves,
            self.dismisses,
            self.clicks,
            self.shares,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_increment_per_endpoint_and_key_source() {
        let m = Metrics::new();
        // 3 discovery via the pool, 1 discovery with a custom key.
        m.record_discovery(true);
        m.record_discovery(true);
        m.record_discovery(true);
        m.record_discovery(false);
        // 1 track via the pool.
        m.record_tracks(true);

        let snap = m.snapshot();
        assert_eq!(snap.discovery, 4);
        assert_eq!(snap.tracks, 1);
        assert_eq!(snap.pool_used, 4); // 3 discovery + 1 track
        assert_eq!(snap.custom_key, 1);
    }

    #[test]
    fn key_pool_share_is_zero_before_any_request() {
        let m = Metrics::new();
        assert_eq!(m.snapshot().key_pool_share(), 0.0);
        assert_eq!(
            m.summary_line(),
            "metrics discovery=0 tracks=0 pool_used=0 custom_key=0 key_pool_share=0.000 events=0 saves=0 dismisses=0 clicks=0 shares=0"
        );
    }

    #[test]
    fn summary_line_formats_counts_and_share() {
        let m = Metrics::new();
        m.record_discovery(true); // pool
        m.record_discovery(true); // pool
        m.record_discovery(true); // pool
        m.record_tracks(false); // custom key
        // 3 of 4 served requests used the pool → share 0.750.
        let snap = m.snapshot();
        assert_eq!(snap.key_pool_share(), 0.75);
        assert_eq!(
            m.summary_line(),
            "metrics discovery=3 tracks=1 pool_used=3 custom_key=1 key_pool_share=0.750 events=0 saves=0 dismisses=0 clicks=0 shares=0"
        );
    }

    #[test]
    fn event_counters_by_type() {
        let m = Metrics::new();
        m.record_event("save");
        m.record_event("save");
        m.record_event("dismiss");
        m.record_event("click_listen");
        m.record_event("share");
        m.record_event("unsave"); // counts in total, not in a typed bucket
        let s = m.snapshot();
        assert_eq!(s.events, 6);
        assert_eq!(s.saves, 2);
        assert_eq!(s.dismisses, 1);
        assert_eq!(s.clicks, 1);
        assert_eq!(s.shares, 1);
    }
}
