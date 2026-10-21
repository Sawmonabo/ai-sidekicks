//! The account routes' deployment settings: the token keys and the relying party's id and exact
//! origin list. Each comes from the host's configuration, read once when the router is built; none
//! has a default, so a missing or malformed one fails every route that needs it with a logged 500.

use sidekicks_contracts::webauthn::ceremony::RelyingPartyText;
use url::Url;

use crate::account::token::issuer::{TokenKeyError, TokenKeys};

/// The PASERK `k4.secret` key that signs access tokens.
pub const TOKEN_SIGNING_KEY: &str = "TOKEN_SIGNING_KEY";

/// The PASERK `k4.local` key that seals refresh tokens.
pub const TOKEN_ENCRYPTION_KEY: &str = "TOKEN_ENCRYPTION_KEY";

/// The relying party id: the control plane's own host.
pub const RELYING_PARTY_ID: &str = "RELYING_PARTY_ID";

/// The exact origins a passkey response may carry, separated by commas.
pub const RELYING_PARTY_ORIGINS: &str = "RELYING_PARTY_ORIGINS";

/// The account routes' settings, parsed.
pub struct AccountSettings {
    /// The relying party id, the control plane's host.
    pub(crate) relying_party_id: RelyingPartyText,
    /// Every origin a passkey response may carry, compared exactly.
    pub(crate) relying_party_origins: Vec<String>,
    /// `https://<relying party id>`, whose path a `DPoP` proof's `htu` is compared under.
    pub(crate) origin: Url,
    /// The same origin as the sign-in options carry it.
    pub(crate) origin_text: RelyingPartyText,
    /// The keys tokens are signed and sealed with.
    pub(crate) token_keys: TokenKeys,
}

/// Why the settings could not be read; a value is never quoted, since two are keys.
#[derive(Debug, thiserror::Error)]
pub enum SettingError {
    /// The setting is absent.
    #[error("the setting {0} is not set")]
    Missing(&'static str),
    /// The setting is set but does not read as its form.
    #[error("the setting {0} does not read as its form")]
    Malformed(&'static str),
    /// A token key is not its PASERK kind.
    #[error("a token key setting is refused")]
    TokenKey(#[from] TokenKeyError),
}

impl AccountSettings {
    /// Reads every setting through `read`, which answers a setting's text by its name or `None`
    /// when it is absent; refuses the first that is missing or malformed.
    pub fn read(read: impl Fn(&'static str) -> Option<String>) -> Result<Self, SettingError> {
        let require = |name| read(name).ok_or(SettingError::Missing(name));
        let relying_party_id = require(RELYING_PARTY_ID)?;
        // The id is a bare host: it reads back unchanged as an https URL's host, with no port.
        let origin = Url::parse(&format!("https://{relying_party_id}"))
            .ok()
            .filter(|origin| {
                origin.host_str() == Some(relying_party_id.as_str()) && origin.port().is_none()
            })
            .ok_or(SettingError::Malformed(RELYING_PARTY_ID))?;
        let relying_party_origins: Vec<String> = require(RELYING_PARTY_ORIGINS)?
            .split(',')
            .map(|origin| origin.trim().to_owned())
            .collect();
        // Each origin is compared exactly, so each must be written in an origin's own form.
        let is_origin = |text: &String| {
            Url::parse(text).is_ok_and(|url| url.origin().ascii_serialization() == *text)
        };
        if !relying_party_origins.iter().all(is_origin) {
            return Err(SettingError::Malformed(RELYING_PARTY_ORIGINS));
        }
        let token_keys = TokenKeys::from_paserk(
            &require(TOKEN_SIGNING_KEY)?,
            &require(TOKEN_ENCRYPTION_KEY)?,
        )?;
        let malformed_id = || SettingError::Malformed(RELYING_PARTY_ID);
        Ok(Self {
            origin_text: RelyingPartyText::new(origin.origin().ascii_serialization())
                .ok_or_else(malformed_id)?,
            relying_party_id: RelyingPartyText::new(relying_party_id).ok_or_else(malformed_id)?,
            relying_party_origins,
            origin,
            token_keys,
        })
    }
}
