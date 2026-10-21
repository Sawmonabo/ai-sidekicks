//! The token issuer: the PASETO v4.public access token and the v4.local refresh token, each bound
//! to the caller's `DPoP` key by `cnf.jkt`, and the refresh-token family row the pair opens.
//! Claims, signing, encryption and their checks are `pasetors`'.

use jiff::{SignedDuration, Timestamp};
use pasetors::claims::{Claims, ClaimsValidationRules};
use pasetors::errors::{ClaimValidationError, Error as PasetoError};
use pasetors::keys::{AsymmetricPublicKey, AsymmetricSecretKey, SymmetricKey};
use pasetors::token::UntrustedToken;
use pasetors::version4::V4;
use pasetors::{Local, Public, local, public};
use serde_json::json;
use sidekicks_contracts::webauthn::ceremony::{AccessToken, RefreshToken};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::account_store::{AccountStore, AccountStoreError, SqlValue};

/// The issuer every token names.
const TOKEN_ISSUER: &str = "ai-sidekicks-cp";

/// The audience an access token names.
const TOKEN_AUDIENCE: &str = "ai-sidekicks-api";

/// How long an access token is good.
const ACCESS_TOKEN_LIFETIME: SignedDuration = SignedDuration::from_secs(900);

/// The scopes an access token carries; no route checks one yet.
const ACCESS_TOKEN_SCOPE: &str = "session:read session:write run:create";

/// The control plane's token keys, parsed once when its router is built: the `k4.secret` key that
/// signs access tokens, its public half, and the `k4.local` key that seals refresh tokens.
pub struct TokenKeys {
    signing: AsymmetricSecretKey<V4>,
    verifying: AsymmetricPublicKey<V4>,
    encryption: SymmetricKey<V4>,
}

/// Why a token key setting was refused; the key itself is never quoted.
#[derive(Debug, thiserror::Error)]
pub enum TokenKeyError {
    /// The signing key is not a PASERK `k4.secret` key.
    #[error("the token signing key is not a k4.secret PASERK key")]
    Signing(#[source] PasetoError),
    /// The encryption key is not a PASERK `k4.local` key.
    #[error("the token encryption key is not a k4.local PASERK key")]
    Encryption(#[source] PasetoError),
}

impl TokenKeys {
    /// Parses the two PASERK keys; refuses either that is not its kind.
    pub fn from_paserk(signing: &str, encryption: &str) -> Result<Self, TokenKeyError> {
        let signing =
            AsymmetricSecretKey::<V4>::try_from(signing).map_err(TokenKeyError::Signing)?;
        let verifying =
            AsymmetricPublicKey::<V4>::try_from(&signing).map_err(TokenKeyError::Signing)?;
        let encryption =
            SymmetricKey::<V4>::try_from(encryption).map_err(TokenKeyError::Encryption)?;
        Ok(Self {
            signing,
            verifying,
            encryption,
        })
    }
}

/// A freshly issued access and refresh token.
#[derive(Debug)]
pub(crate) struct TokenPair {
    /// The access token.
    pub(crate) access_token: AccessToken,
    /// The refresh token.
    pub(crate) refresh_token: RefreshToken,
}

/// Why a pair could not be issued; the caller reads only a 500.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenIssueError {
    /// The family row could not be written.
    #[error("the refresh token's family could not be recorded")]
    Store(#[from] AccountStoreError),
    /// `pasetors` refused a claim or the sealing.
    #[error("the token could not be made")]
    Paseto(#[from] PasetoError),
    /// The expiry fell outside what a timestamp holds.
    #[error("the token's expiry is out of range")]
    Instant(#[from] jiff::Error),
    /// The token did not read as its contract's form.
    #[error("the made token does not have the PASETO form")]
    Form,
}

/// What a verified access token says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccessClaims {
    /// The account.
    pub(crate) user_id: String,
    /// The token's id, which a revocation lists.
    pub(crate) jti: String,
    /// The thumbprint of the key the token is bound to.
    pub(crate) jkt: String,
}

/// Why a presented token was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum TokenRefusal {
    /// Its `exp` has passed.
    #[error("the token has expired")]
    Expired,
    /// It is not one this control plane made, or it breaks a claim.
    #[error("the token is not valid")]
    Invalid,
}

/// Mints an access and refresh token for `user_id` bound to `jkt` at `now`, and writes the
/// refresh token's family row inside the caller's step.
pub(crate) fn issue_token_pair<S: AccountStore>(
    store: &S,
    keys: &TokenKeys,
    user_id: &str,
    jkt: &str,
    now: Timestamp,
) -> Result<TokenPair, TokenIssueError> {
    // A UUID's text is its lowercase hyphenated form.
    let family_id = mint_uuid_v7().to_string();
    let refresh_jti = mint_uuid_v7().to_string();
    let issued_at = write_instant(now);

    let mut access = build_claims(user_id, jkt, &mint_uuid_v7().to_string(), &issued_at)?;
    access.audience(TOKEN_AUDIENCE)?;
    access.expiration(&write_instant(now.checked_add(ACCESS_TOKEN_LIFETIME)?))?;
    access.add_additional("scope", ACCESS_TOKEN_SCOPE)?;
    let access_token = public::sign(&keys.signing, &access, None, None)?;

    let mut refresh = build_claims(user_id, jkt, &refresh_jti, &issued_at)?;
    refresh.add_additional("family", family_id.as_str())?;
    let refresh_token = local::encrypt(&keys.encryption, &refresh, None, None)?;

    store.execute(
        "INSERT INTO refresh_token_families (family_id, user_id, cnf_jkt, current_jti, issued_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        &[
            SqlValue::Text(family_id),
            SqlValue::Text(user_id.to_owned()),
            SqlValue::Text(jkt.to_owned()),
            SqlValue::Text(refresh_jti),
            SqlValue::Integer(now.as_second()),
        ],
    )?;
    Ok(TokenPair {
        access_token: AccessToken::new(access_token).ok_or(TokenIssueError::Form)?,
        refresh_token: RefreshToken::new(refresh_token).ok_or(TokenIssueError::Form)?,
    })
}

/// Verifies `token` as an access token this control plane signed: its signature, issuer,
/// audience and `exp`, which `pasetors` reads against the system clock.
pub(crate) fn verify_access_token(
    keys: &TokenKeys,
    token: &str,
) -> Result<AccessClaims, TokenRefusal> {
    let untrusted =
        UntrustedToken::<Public, V4>::try_from(token).map_err(|_error| TokenRefusal::Invalid)?;
    let mut rules = build_rules();
    rules.validate_audience_with(TOKEN_AUDIENCE);
    let trusted = public::verify(&keys.verifying, &untrusted, &rules, None, None)
        .map_err(|error| refuse_paseto_error(&error))?;
    let claims = trusted.payload_claims().ok_or(TokenRefusal::Invalid)?;
    Ok(AccessClaims {
        user_id: read_text_claim(claims, "sub")?,
        jti: read_text_claim(claims, "jti")?,
        jkt: read_jkt(claims)?,
    })
}

/// What an opened refresh token says.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the refresh-token trade reads what the token it opens says"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefreshClaims {
    /// The account.
    pub(crate) user_id: String,
    /// The token's id, the family's current one while it is unspent.
    pub(crate) jti: String,
    /// The thumbprint of the key the token is bound to.
    pub(crate) jkt: String,
    /// The family the token belongs to.
    pub(crate) family_id: String,
}

/// Opens `token` as a refresh token this control plane sealed, checking its issuer; it has no
/// `exp`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the refresh-token trade opens the token it is handed"
    )
)]
pub(crate) fn open_refresh_token(
    keys: &TokenKeys,
    token: &str,
) -> Result<RefreshClaims, TokenRefusal> {
    let untrusted =
        UntrustedToken::<Local, V4>::try_from(token).map_err(|_error| TokenRefusal::Invalid)?;
    let mut rules = build_rules();
    rules.allow_non_expiring();
    let trusted = local::decrypt(&keys.encryption, &untrusted, &rules, None, None)
        .map_err(|error| refuse_paseto_error(&error))?;
    let claims = trusted.payload_claims().ok_or(TokenRefusal::Invalid)?;
    Ok(RefreshClaims {
        user_id: read_text_claim(claims, "sub")?,
        jti: read_text_claim(claims, "jti")?,
        jkt: read_jkt(claims)?,
        family_id: read_text_claim(claims, "family")?,
    })
}

// Claims start empty: `Claims::new()` reads the system clock and adds `nbf` and an hour's `exp`.
fn build_claims(
    user_id: &str,
    jkt: &str,
    jti: &str,
    issued_at: &str,
) -> Result<Claims, PasetoError> {
    let mut claims = Claims::from_string("{}")?;
    claims.issuer(TOKEN_ISSUER)?;
    claims.subject(user_id)?;
    claims.token_identifier(jti)?;
    claims.issued_at(issued_at)?;
    claims.add_additional("cnf", json!({ "jkt": jkt }))?;
    Ok(claims)
}

// The tokens carry no `nbf`, so the `nbf` and `iat` block is off; `exp` is checked whenever
// present.
fn build_rules() -> ClaimsValidationRules {
    let mut rules = ClaimsValidationRules::new();
    rules.disable_valid_at();
    rules.validate_issuer_with(TOKEN_ISSUER);
    rules
}

fn refuse_paseto_error(error: &PasetoError) -> TokenRefusal {
    if *error == PasetoError::ClaimValidation(ClaimValidationError::Exp) {
        TokenRefusal::Expired
    } else {
        TokenRefusal::Invalid
    }
}

fn read_text_claim(claims: &Claims, name: &str) -> Result<String, TokenRefusal> {
    claims
        .get_claim(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or(TokenRefusal::Invalid)
}

fn read_jkt(claims: &Claims) -> Result<String, TokenRefusal> {
    claims
        .get_claim("cnf")
        .and_then(|cnf| cnf.get("jkt"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or(TokenRefusal::Invalid)
}

// PASETO's times are RFC 3339 strings with `Z`.
fn write_instant(at: Timestamp) -> String {
    at.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Fresh token keys as PASERK text, the signing key then the encryption key, for tests.
#[cfg(any(test, feature = "test-support"))]
pub fn generate_paserk_keys() -> (String, String) {
    use pasetors::keys::{AsymmetricKeyPair, Generate as _};
    use pasetors::paserk::FormatAsPaserk as _;

    let pair = AsymmetricKeyPair::<V4>::generate().expect("the system's random source works");
    let mut signing = String::new();
    pair.secret
        .fmt(&mut signing)
        .expect("a key writes as PASERK");
    let mut encryption = String::new();
    SymmetricKey::<V4>::generate()
        .expect("the system's random source works")
        .fmt(&mut encryption)
        .expect("a key writes as PASERK");
    (signing, encryption)
}

#[cfg(test)]
mod tests {
    use super::{
        TokenKeys, TokenRefusal, generate_paserk_keys, issue_token_pair, open_refresh_token,
    };
    use crate::account_store::{AccountStore, open_account_file};
    use crate::rate_limit::limiter::read_wall_clock;

    #[test]
    fn a_refresh_token_opens_only_under_its_own_key_and_unchanged() {
        let folder = tempfile::tempdir().unwrap();
        let store = open_account_file(&folder.path().join("account.sqlite")).unwrap();
        AccountStore::execute(
            &store,
            "INSERT INTO users (id, display_name, identity_ref) VALUES ('user', 'Sam', 'h')",
            &[],
        )
        .unwrap();
        let (signing, encryption) = generate_paserk_keys();
        let keys = TokenKeys::from_paserk(&signing, &encryption).unwrap();
        let pair =
            issue_token_pair(&store, &keys, "user", "thumb", read_wall_clock().unwrap()).unwrap();
        let refresh = pair.refresh_token.as_str();

        let opened = open_refresh_token(&keys, refresh).unwrap();
        assert_eq!(
            (opened.user_id.as_str(), opened.jkt.as_str()),
            ("user", "thumb")
        );

        let (other_signing, other_encryption) = generate_paserk_keys();
        let other = TokenKeys::from_paserk(&other_signing, &other_encryption).unwrap();
        assert_eq!(
            open_refresh_token(&other, refresh),
            Err(TokenRefusal::Invalid)
        );

        let mut changed = refresh.to_owned().into_bytes();
        let last = changed.len() - 1;
        changed[last] = if changed[last] == b'A' { b'B' } else { b'A' };
        let changed = String::from_utf8(changed).unwrap();
        assert_eq!(
            open_refresh_token(&keys, &changed),
            Err(TokenRefusal::Invalid)
        );
    }
}
