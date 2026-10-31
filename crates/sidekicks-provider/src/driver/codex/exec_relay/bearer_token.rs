//! The secret a relay's client presents: minted at each start of the relay's service and checked
//! on every connection, so only the service the daemon handed it to reaches the executor.

use sidekicks_std::random_hex::random_hex;
use zeroize::Zeroizing;

/// The random bytes one token holds.
const TOKEN_BYTES: usize = 32;

/// What opens the header value a client presents its token in.
const BEARER_PREFIX: &str = "Bearer ";

/// One start's token.
pub(super) struct RelayBearerToken(Zeroizing<String>);

impl RelayBearerToken {
    /// A new token from the system's random source. Fails when the source cannot be read.
    pub(super) fn mint() -> Result<Self, getrandom::Error> {
        random_hex(TOKEN_BYTES).map(|token| Self(Zeroizing::new(token)))
    }

    /// The token as `environment/add` hands it to the service.
    pub(super) fn text(&self) -> &str {
        &self.0
    }

    /// Whether `authorization`, a request's `Authorization` header, presents this token; compared
    /// in constant time through each side's hash.
    pub(super) fn admits(&self, authorization: Option<&[u8]>) -> bool {
        let Some(presented) =
            authorization.and_then(|value| value.strip_prefix(BEARER_PREFIX.as_bytes()))
        else {
            return false;
        };
        blake3::hash(presented) == blake3::hash(self.0.as_bytes())
    }
}
