//! The secret a loopback client the daemon started presents: minted at each start for the exec
//! relay, and for each provider process or launch that exports telemetry, or derived from the
//! daemon's key for a provider process's tool-server entry, and checked on every request or
//! connection, so only the process the daemon handed it to reaches the endpoint.

use sidekicks_std::random_hex::random_hex;
use subtle::ConstantTimeEq as _;
use zeroize::Zeroizing;

/// The random bytes one token holds.
const TOKEN_BYTES: usize = 32;

/// What opens the header value a client presents its token in.
pub(crate) const BEARER_PREFIX: &str = "Bearer ";

/// One token: a start's, or one provider process's or launch's.
pub struct BearerToken(Zeroizing<String>);

impl BearerToken {
    /// A new token from the system's random source. Fails when the source cannot be read.
    pub fn mint() -> Result<Self, getrandom::Error> {
        random_hex(TOKEN_BYTES).map(|token| Self(Zeroizing::new(token)))
    }

    /// A token derived as a keyed hash instead of drawn at random, so whoever holds the key makes
    /// the same token again: `digest` in lowercase hex.
    pub fn of_digest(digest: &[u8; TOKEN_BYTES]) -> Self {
        Self(Zeroizing::new(base16ct::lower::encode_string(digest)))
    }

    /// The token a process the daemon handed it to still presents after the daemon restarted,
    /// read back from the daemon's private record of that process; `None` for text that is not a
    /// token this type mints.
    pub(crate) fn kept(text: &str) -> Option<Self> {
        (text.len() == TOKEN_BYTES * 2 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| Self(Zeroizing::new(text.to_owned())))
    }

    /// The token as the daemon hands it to the process that presents it.
    pub fn text(&self) -> &str {
        &self.0
    }

    /// The `Authorization` header value that presents this token, for a client the daemon hands
    /// its configuration to.
    pub fn header_value(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("{BEARER_PREFIX}{}", self.0.as_str()))
    }

    /// Whether `authorization`, a request's `Authorization` header, presents this token after
    /// `Bearer `; the bytes are compared in constant time.
    pub fn admits(&self, authorization: Option<&[u8]>) -> bool {
        let Some(presented) =
            authorization.and_then(|value| value.strip_prefix(BEARER_PREFIX.as_bytes()))
        else {
            return false;
        };
        presented.ct_eq(self.0.as_bytes()).into()
    }
}
