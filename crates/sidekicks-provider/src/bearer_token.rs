//! The secret a loopback client the daemon started presents: minted at each start for the exec
//! relay, for each provider process or launch that exports telemetry and for each Claude Code
//! spawn's in-process tool-server entry, or derived from the daemon's key for a provider process's
//! tool-server entry, and checked on every request or connection, so only the process the daemon
//! handed it to reaches the endpoint.

use subtle::ConstantTimeEq as _;
use zeroize::Zeroizing;

/// The random bytes one token holds.
const TOKEN_BYTES: usize = 32;

/// The length of a token's text: two lowercase hex digits a byte.
const TOKEN_TEXT_BYTES: usize = TOKEN_BYTES * 2;

/// What opens the header value a client presents its token in.
pub(crate) const BEARER_PREFIX: &str = "Bearer ";

/// One token: a start's, or one provider process's or launch's. It holds the bytes; a client
/// receives and presents them as lowercase hex text.
pub struct BearerToken(Zeroizing<[u8; TOKEN_BYTES]>);

impl BearerToken {
    /// A new token from the system's random source. Fails when the source cannot be read.
    pub fn mint() -> Result<Self, getrandom::Error> {
        let mut bytes = Zeroizing::new([0_u8; TOKEN_BYTES]);
        getrandom::fill(&mut bytes[..])?;
        Ok(Self(bytes))
    }

    /// A token derived as a keyed hash instead of drawn at random, so whoever holds the key makes
    /// the same token again: `digest` itself.
    pub fn of_digest(digest: &[u8; TOKEN_BYTES]) -> Self {
        Self(Zeroizing::new(*digest))
    }

    /// The token a process the daemon handed it to still presents after the daemon restarted,
    /// read back from the daemon's private record of that process; `None` for text that is not a
    /// token's lowercase hex.
    pub(crate) fn kept(text: &str) -> Option<Self> {
        let mut bytes = Zeroizing::new([0_u8; TOKEN_BYTES]);
        let decoded = base16ct::lower::decode(text, &mut bytes[..]).ok()?.len();
        (decoded == TOKEN_BYTES).then_some(Self(bytes))
    }

    /// The token as the daemon hands it to the process that presents it, in lowercase hex.
    pub fn text(&self) -> Zeroizing<String> {
        Zeroizing::new(base16ct::lower::encode_string(&self.0[..]))
    }

    /// The `Authorization` header value that presents this token, for a client the daemon hands
    /// its configuration to.
    pub fn header_value(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("{BEARER_PREFIX}{}", self.text().as_str()))
    }

    /// Whether `authorization`, a request's `Authorization` header, presents this token's text
    /// after `Bearer `; the bytes are compared in constant time.
    pub fn admits(&self, authorization: Option<&[u8]>) -> bool {
        let Some(presented) =
            authorization.and_then(|value| value.strip_prefix(BEARER_PREFIX.as_bytes()))
        else {
            return false;
        };
        let mut text = Zeroizing::new([0_u8; TOKEN_TEXT_BYTES]);
        let expected = base16ct::lower::encode(&self.0[..], &mut text[..])
            .expect("a token's hex fills its buffer exactly");
        presented.ct_eq(expected).into()
    }
}
