//! The secret a loopback client the daemon started presents: minted at each start for the exec
//! relay, and for each provider process or launch that exports telemetry, and checked on every
//! request or connection, so only the process the daemon handed it to reaches the endpoint.

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
