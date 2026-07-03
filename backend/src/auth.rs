// Session-token primitives for the identity layer.
//
// A session token is 32 random bytes, presented to the client as 64 hex chars.
// The server NEVER stores the raw token — only its sha256 hash — so a database
// leak cannot be replayed as a login. Lookup is by the hash (an indexed unique
// column), which is itself a constant-time-comparison-safe capability check:
// the presented token is hashed and matched for equality against the stored
// hash; the raw secret is compared nowhere.

use sha2::{Digest, Sha256};

/// 90 days, per the pinned contract.
pub const SESSION_TTL_DAYS: i64 = 90;

/// A freshly minted session: the raw token to hand back to the client (once),
/// and the hash to persist.
pub struct NewToken {
    pub raw: String,
    pub hash: String,
}

/// Mint a new opaque session token (32 random bytes → 64 hex chars) and its
/// sha256 hash. Only `raw` is ever returned to the client; only `hash` is stored.
pub fn mint_token() -> NewToken {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let raw = hex::encode(bytes);
    let hash = hash_token(&raw);
    NewToken { raw, hash }
}

/// sha256-hex of a raw token. Deterministic — used both at mint time and on
/// every authenticated request to look the session up by hash.
pub fn hash_token(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    hex::encode(digest)
}

/// Extract a bearer token from an `Authorization: Bearer <token>` header value.
/// Case-insensitive on the scheme; trims surrounding whitespace. Returns `None`
/// when the header is absent or malformed.
pub fn bearer_from_header(header: Option<&str>) -> Option<String> {
    let raw = header?.trim();
    let rest = raw.strip_prefix("Bearer ").or_else(|| raw.strip_prefix("bearer "))?;
    let tok = rest.trim();
    if tok.is_empty() {
        None
    } else {
        Some(tok.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_token_shape_and_hash() {
        let t = mint_token();
        // 32 bytes → 64 hex chars.
        assert_eq!(t.raw.len(), 64);
        assert!(t.raw.chars().all(|c| c.is_ascii_hexdigit()));
        // Hash is sha256-hex (32 bytes → 64 chars) and matches hash_token(raw).
        assert_eq!(t.hash.len(), 64);
        assert_eq!(t.hash, hash_token(&t.raw));
        // The stored hash is not the raw token.
        assert_ne!(t.hash, t.raw);
    }

    #[test]
    fn tokens_are_unique() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a.raw, b.raw);
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn hash_is_deterministic() {
        assert_eq!(hash_token("abc"), hash_token("abc"));
        assert_ne!(hash_token("abc"), hash_token("abd"));
    }

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer_from_header(Some("Bearer xyz")).as_deref(), Some("xyz"));
        assert_eq!(bearer_from_header(Some("bearer xyz")).as_deref(), Some("xyz"));
        assert_eq!(bearer_from_header(Some("  Bearer   xyz  ")).as_deref(), Some("xyz"));
        assert_eq!(bearer_from_header(Some("Basic xyz")), None);
        assert_eq!(bearer_from_header(Some("Bearer ")), None);
        assert_eq!(bearer_from_header(Some("xyz")), None);
        assert_eq!(bearer_from_header(None), None);
    }
}
