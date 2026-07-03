// Per-IP token-bucket rate limiter for the write API (`POST /api/events`).
//
// In-memory (no DB, no Redis): a `DashMap<IpKey, Bucket>` of monotonic-clock
// token buckets. Each bucket refills at `refill_per_sec` up to `capacity`; a
// request costs one token. When empty, the caller gets 429 + a `Retry-After`
// hint (seconds until the next token). Idle buckets are swept opportunistically
// so the map can't grow without bound under IP churn.

use dashmap::DashMap;
use std::time::Instant;

/// Bucket capacity (max burst) and steady-state refill rate. 60-token burst,
/// 1 token/sec sustained — generous for genuine click/save/share bursts on a
/// results page, tight enough to blunt a scripted flood from one IP.
const CAPACITY: f64 = 60.0;
const REFILL_PER_SEC: f64 = 1.0;
/// Drop buckets untouched for this long during the periodic sweep.
const IDLE_EVICT_SECS: u64 = 600;

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct RateLimiter {
    buckets: DashMap<String, Bucket>,
    capacity: f64,
    refill_per_sec: f64,
}

/// Outcome of a rate-limit check.
pub enum Decision {
    Allow,
    /// Denied; retry after this many whole seconds (always ≥ 1).
    Deny { retry_after_secs: u64 },
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::with_params(CAPACITY, REFILL_PER_SEC)
    }

    pub fn with_params(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            buckets: DashMap::new(),
            capacity,
            refill_per_sec,
        }
    }

    /// Charge one token to `key` (typically the client IP). `Allow` if a token
    /// was available, else `Deny` with a retry hint. Uses a monotonic clock, so
    /// it is immune to wall-clock jumps.
    pub fn check(&self, key: &str) -> Decision {
        self.check_at(key, Instant::now())
    }

    /// Testable core: `now` is injected so bucket refill can be exercised
    /// deterministically without sleeping.
    pub fn check_at(&self, key: &str, now: Instant) -> Decision {
        let mut entry = self.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });
        // Refill for the elapsed time since we last touched this bucket.
        let elapsed = now.saturating_duration_since(entry.last).as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        entry.last = now;

        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            Decision::Allow
        } else {
            let deficit = 1.0 - entry.tokens;
            let secs = (deficit / self.refill_per_sec).ceil() as u64;
            Decision::Deny {
                retry_after_secs: secs.max(1),
            }
        }
    }

    /// Evict buckets idle beyond the threshold. Cheap; call from a periodic task.
    pub fn sweep(&self) {
        let now = Instant::now();
        self.buckets
            .retain(|_, b| now.saturating_duration_since(b.last).as_secs() < IDLE_EVICT_SECS);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.len()
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn is_allow(d: &Decision) -> bool {
        matches!(d, Decision::Allow)
    }

    #[test]
    fn allows_up_to_capacity_then_denies() {
        let rl = RateLimiter::with_params(3.0, 1.0);
        let t = Instant::now();
        // First 3 requests (capacity) allowed at the same instant.
        assert!(is_allow(&rl.check_at("ip", t)));
        assert!(is_allow(&rl.check_at("ip", t)));
        assert!(is_allow(&rl.check_at("ip", t)));
        // 4th is denied with a Retry-After of at least 1s.
        match rl.check_at("ip", t) {
            Decision::Deny { retry_after_secs } => assert!(retry_after_secs >= 1),
            Decision::Allow => panic!("expected Deny after capacity exhausted"),
        }
    }

    #[test]
    fn refills_over_time() {
        let rl = RateLimiter::with_params(2.0, 1.0);
        let t0 = Instant::now();
        assert!(is_allow(&rl.check_at("ip", t0)));
        assert!(is_allow(&rl.check_at("ip", t0)));
        assert!(!is_allow(&rl.check_at("ip", t0)), "empty at t0");
        // One token refills after ~1s.
        let t1 = t0 + Duration::from_secs(1);
        assert!(is_allow(&rl.check_at("ip", t1)), "one token back after 1s");
        assert!(!is_allow(&rl.check_at("ip", t1)), "and only one");
    }

    #[test]
    fn buckets_are_per_key() {
        let rl = RateLimiter::with_params(1.0, 1.0);
        let t = Instant::now();
        assert!(is_allow(&rl.check_at("a", t)));
        assert!(!is_allow(&rl.check_at("a", t)));
        // A different IP has its own full bucket.
        assert!(is_allow(&rl.check_at("b", t)));
    }

    #[test]
    fn sweep_evicts_idle() {
        let rl = RateLimiter::with_params(1.0, 1.0);
        let _ = rl.check("a");
        assert_eq!(rl.len(), 1);
        rl.sweep(); // recent → retained
        assert_eq!(rl.len(), 1);
    }
}
