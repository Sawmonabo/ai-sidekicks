//! The reader of a Codex home's `auth.json`, the sign-in Codex's `file` store keeps there: when
//! Codex last renewed it and when its access token expires. The tokens never leave the read.

use std::io::ErrorKind;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiff::Timestamp;
use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Deserializer};
use zeroize::Zeroizing;

/// The file Codex's `file` store writes in its home.
const CODEX_AUTH_FILE_NAME: &str = "auth.json";

/// What a Codex home's `auth.json` says of its sign-in's renewal.
#[derive(Debug)]
pub(crate) struct CodexAuthFile {
    /// When Codex last wrote renewed tokens, absent before the first renewal.
    pub(crate) last_refresh: Option<Timestamp>,
    /// The access token's `exp` claim, absent with no tokens or no claim.
    pub(crate) access_token_expiry: Option<Timestamp>,
}

/// Why a Codex home's `auth.json` could not be read. No variant carries the file's content.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexAuthFileError {
    /// The file exists and could not be read.
    #[error("the Codex home's auth.json could not be read")]
    Unreadable(#[source] std::io::Error),
    /// The file is not the JSON Codex writes.
    #[error("the Codex home's auth.json is not a sign-in Codex wrote: {0}")]
    Malformed(JsonFault),
    /// `last_refresh` is not an instant.
    #[error("the Codex home's auth.json has a last renewal that is not an instant")]
    LastRefresh(#[source] jiff::Error),
    /// The access token is not three dot-joined segments.
    #[error("the access token in the Codex home's auth.json is not a JWT")]
    AccessTokenShape,
    /// The access token's payload is not URL-safe base64 without padding.
    #[error("the access token's payload in the Codex home's auth.json is not base64")]
    AccessTokenEncoding(#[source] base64::DecodeError),
    /// The access token's payload is not JSON claims.
    #[error("the access token's claims in the Codex home's auth.json are not JSON: {0}")]
    AccessTokenClaims(JsonFault),
}

/// Where and how a JSON read failed, without serde's message, which can quote the value it met.
#[derive(Debug)]
pub(crate) struct JsonFault {
    category: serde_json::error::Category,
    line: usize,
    column: usize,
}

impl std::fmt::Display for JsonFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{:?} at line {}, column {}",
            self.category, self.line, self.column
        )
    }
}

impl From<serde_json::Error> for JsonFault {
    fn from(error: serde_json::Error) -> Self {
        Self {
            category: error.classify(),
            line: error.line(),
            column: error.column(),
        }
    }
}

// The members of `auth.json` the reader takes; serde skips the rest unread.
#[derive(Deserialize)]
struct AuthFileMembers {
    #[serde(default)]
    tokens: Option<TokenMembers>,
    #[serde(default)]
    last_refresh: Option<String>,
}

#[derive(Deserialize)]
struct TokenMembers {
    #[serde(deserialize_with = "deserialize_secret")]
    access_token: SecretString,
}

#[derive(Deserialize)]
struct ExpiryClaim {
    #[serde(default)]
    exp: Option<i64>,
}

fn deserialize_secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<SecretString, D::Error> {
    String::deserialize(deserializer).map(SecretString::from)
}

/// Reads `home`'s `auth.json`: `None` when the home has none. Fails when the file cannot be read,
/// is not JSON Codex writes, or holds a renewal time or an access token that does not parse.
pub(crate) async fn read_codex_auth_file(
    home: &Path,
) -> Result<Option<CodexAuthFile>, CodexAuthFileError> {
    let bytes = match tokio::fs::read(home.join(CODEX_AUTH_FILE_NAME)).await {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CodexAuthFileError::Unreadable(error)),
    };
    let members: AuthFileMembers = serde_json::from_slice(&bytes)
        .map_err(|error| CodexAuthFileError::Malformed(error.into()))?;
    let last_refresh = members
        .last_refresh
        .map(|text| text.parse::<Timestamp>())
        .transpose()
        .map_err(CodexAuthFileError::LastRefresh)?;
    let access_token_expiry = members
        .tokens
        .map(|tokens| read_expiry(&tokens.access_token))
        .transpose()?
        .flatten();
    Ok(Some(CodexAuthFile {
        last_refresh,
        access_token_expiry,
    }))
}

// The JWT's `exp` claim as Codex reads it: the payload segment decoded, its signature unchecked
// (the file is the daemon's own home's), an instant out of range read as none.
fn read_expiry(access_token: &SecretString) -> Result<Option<Timestamp>, CodexAuthFileError> {
    let mut segments = access_token.expose_secret().split('.');
    let payload = match (segments.next(), segments.next(), segments.next()) {
        (Some(header), Some(payload), Some(signature))
            if !header.is_empty() && !payload.is_empty() && !signature.is_empty() =>
        {
            payload
        }
        _ => return Err(CodexAuthFileError::AccessTokenShape),
    };
    let claims = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(CodexAuthFileError::AccessTokenEncoding)?,
    );
    let claim: ExpiryClaim = serde_json::from_slice(&claims)
        .map_err(|error| CodexAuthFileError::AccessTokenClaims(error.into()))?;
    Ok(claim.exp.and_then(|exp| Timestamp::from_second(exp).ok()))
}
