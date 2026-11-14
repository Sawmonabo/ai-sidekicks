//! The reader of a Codex home's `auth.json`, the sign-in Codex's `file` store keeps there: when
//! Codex last renewed it and when its access token expires, and the tokens the switching service is
//! handed, which leave the read only as secrets.

use std::borrow::Borrow;
use std::io::ErrorKind;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiff::Timestamp;
use secrecy::{ExposeSecret as _, SecretString};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serializer};
use subtle::ConstantTimeEq as _;
use zeroize::Zeroizing;

use crate::driver::saved_secret::{read_optional_secret, read_secret};

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

/// A `ChatGPT` sign-in's tokens as a Codex home's `auth.json` holds them, what
/// `account/login/start` hands a service as `chatgptAuthTokens` and a token refresh is answered
/// with.
#[derive(Clone)]
pub(crate) struct CodexAuthTokens {
    /// `tokens.access_token`.
    pub(crate) access_token: SecretString,
    /// `tokens.account_id`, the `ChatGPT` workspace the sign-in is for.
    pub(crate) chatgpt_account_id: String,
    /// The identity token's `chatgpt_plan_type` claim, absent where it names none.
    pub(crate) chatgpt_plan_type: Option<String>,
}

/// Writes a secret's text into an encoded request or answer, the one place a token leaves its
/// wrapper; serde hands it the secret or a borrow of it.
pub(crate) fn serialize_secret<S: Serializer>(
    secret: &impl Borrow<SecretString>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(secret.borrow().expose_secret())
}

/// Whether two access tokens are the same, compared in constant time.
pub(crate) fn is_same_token(left: &SecretString, right: &SecretString) -> bool {
    left.expose_secret()
        .as_bytes()
        .ct_eq(right.expose_secret().as_bytes())
        .into()
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
    /// The identity token is not a JWT whose payload is base64 JSON claims, as the cause says.
    #[error("the identity token in the Codex home's auth.json does not read")]
    IdentityToken(#[source] Box<CodexAuthFileError>),
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
    #[serde(deserialize_with = "read_secret")]
    access_token: SecretString,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default, deserialize_with = "read_optional_secret")]
    id_token: Option<SecretString>,
}

#[derive(Deserialize)]
struct ExpiryClaim {
    #[serde(default)]
    exp: Option<i64>,
}

// The identity token's claim Codex reads the plan from.
#[derive(Deserialize)]
struct IdentityClaims {
    #[serde(default, rename = "https://api.openai.com/auth")]
    auth: Option<IdentityAuthClaim>,
}

#[derive(Deserialize)]
struct IdentityAuthClaim {
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
}

/// Reads `home`'s `auth.json`: `None` when the home has none. Fails when the file cannot be read,
/// is not JSON Codex writes, or holds a renewal time or an access token that does not parse.
pub(crate) async fn read_codex_auth_file(
    home: &Path,
) -> Result<Option<CodexAuthFile>, CodexAuthFileError> {
    let Some(members) = read_members(home).await? else {
        return Ok(None);
    };
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

/// Reads the `ChatGPT` sign-in's tokens from `home`'s `auth.json`: `None` when the home has no
/// file, or a file with no tokens or no account id, as an API-key sign-in writes. Fails as
/// [`read_codex_auth_file`] does, and when the identity token's claims do not parse.
pub(crate) async fn read_codex_auth_tokens(
    home: &Path,
) -> Result<Option<CodexAuthTokens>, CodexAuthFileError> {
    let Some(AuthFileMembers {
        tokens: Some(tokens),
        ..
    }) = read_members(home).await?
    else {
        return Ok(None);
    };
    let Some(chatgpt_account_id) = tokens.account_id else {
        return Ok(None);
    };
    let chatgpt_plan_type = match &tokens.id_token {
        Some(id_token) => read_claims::<IdentityClaims>(id_token)
            .map_err(|error| CodexAuthFileError::IdentityToken(Box::new(error)))?
            .auth
            .and_then(|auth| auth.chatgpt_plan_type),
        None => None,
    };
    Ok(Some(CodexAuthTokens {
        access_token: tokens.access_token,
        chatgpt_account_id,
        chatgpt_plan_type,
    }))
}

// The members of `home`'s `auth.json`, `None` when the home has none.
async fn read_members(home: &Path) -> Result<Option<AuthFileMembers>, CodexAuthFileError> {
    let bytes = match tokio::fs::read(home.join(CODEX_AUTH_FILE_NAME)).await {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CodexAuthFileError::Unreadable(error)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| CodexAuthFileError::Malformed(error.into()))
}

// The access token's `exp` claim as Codex reads it, an instant out of range read as none.
fn read_expiry(access_token: &SecretString) -> Result<Option<Timestamp>, CodexAuthFileError> {
    let claim: ExpiryClaim = read_claims(access_token)?;
    Ok(claim.exp.and_then(|exp| Timestamp::from_second(exp).ok()))
}

// A JWT's claims as Codex reads them: the payload segment decoded, its signature unchecked (the
// file is the daemon's own home's).
fn read_claims<Claims: DeserializeOwned>(
    token: &SecretString,
) -> Result<Claims, CodexAuthFileError> {
    let mut segments = token.expose_secret().split('.');
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
    serde_json::from_slice(&claims)
        .map_err(|error| CodexAuthFileError::AccessTokenClaims(error.into()))
}
