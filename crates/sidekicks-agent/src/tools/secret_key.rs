//! The daemon's tool-server key: 32 bytes in the credential store that each provider process's
//! secret for the tool servers is derived from, as a keyed hash of the address its entry sits at.
//! A start of the daemon makes the same secret again for an address an earlier start gave out,
//! so a conversation the provider kept running across a restart is still admitted, and nothing
//! per spawn is stored.

use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_store::credential_store::seed_item::{Seed, encode_seed, item_seed, random_seed};
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};

use crate::tools::server::ToolServerPath;

// The key's one account in its keychain service.
const TOOL_SERVER_KEY_ACCOUNT: &str = "tool-server-key";

/// Why the tool-server key could not be read or made.
#[derive(Debug, thiserror::Error)]
pub enum ToolServerSecretKeyError {
    /// The keychain is locked or cannot be used.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
    /// The system gave no random bytes for a new key.
    #[error("the system gave no random bytes for the tool-server key")]
    Random(#[from] getrandom::Error),
}

/// The key every tool-server secret is derived from, wiped when it drops.
pub struct ToolServerSecretKey(Seed);

impl ToolServerSecretKey {
    /// The key `keychain` keeps, made and kept there when it holds none, or holds text that is no
    /// key. A new key admits no address an earlier key gave out. Fails when the keychain cannot be
    /// read or keep the new key, or the system gives no random bytes.
    pub async fn read_or_create(
        keychain: &dyn SecretKeychain,
    ) -> Result<Self, ToolServerSecretKeyError> {
        if let Some(seed) = keychain
            .read(TOOL_SERVER_KEY_ACCOUNT)
            .await?
            .as_ref()
            .and_then(item_seed)
        {
            return Ok(Self(seed));
        }
        let seed = random_seed()?;
        keychain
            .write_verified(TOOL_SERVER_KEY_ACCOUNT, &encode_seed(&seed))
            .await?;
        Ok(Self(seed))
    }

    /// The secret a provider process presents at `path`: the keyed hash of the path, never of the
    /// listener's port, so a moved listener keeps every secret.
    pub(crate) fn secret_of(&self, path: &ToolServerPath) -> BearerToken {
        BearerToken::of_digest(blake3::keyed_hash(&self.0, path.to_string().as_bytes()).as_bytes())
    }
}

#[cfg(test)]
impl ToolServerSecretKey {
    /// A key of `fill` bytes, for a test that needs no keychain.
    pub(crate) fn of_bytes(fill: u8) -> Self {
        Self(Seed::new([fill; 32]))
    }
}
