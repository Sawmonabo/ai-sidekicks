//! The custody of pasted tokens and API keys: each one sealed as its own keychain item under its
//! account's id, never in the account's credential home, and admitted only once the provider's own
//! status read accepts it.
//!
//! The registry row and the sealed item commit separately, so their order is what keeps a crash
//! harmless:
//! - A registration seals the token, runs the status read, then writes the row; a crash strands an
//!   item no row names, and a refused read or a row not written destroys the item.
//! - A re-supply runs the status read first, since the account's one item still holds the token in
//!   use, then seals the new token over it, which destroys the prior one, then raises the
//!   generation with the reading in one write.
//! - The start's sweep destroys every item no registered row names, the items of rows whose
//!   removal has begun among them, then deletes those rows.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    BillingMode, DisplayLabel, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::ProviderAccountCredentialSealRefusedDetails;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::{
    AccountAdmission, HealthObservation, MintedAccount, ProviderAccountRegistry, RegisteredAccount,
};
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::ProviderTokenStatusLegs;
use crate::driver::contract::error::DriverError;

/// What a pasted-token registration writes beside its minted id and home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenAccountRegistration {
    /// The name the person typed, which the provider names nowhere.
    pub display_label: DisplayLabel,
    /// How the account is charged.
    pub billing_mode: BillingMode,
}

/// Why a token's custody failed. A refusal names no token and no credential home.
#[derive(Debug, thiserror::Error)]
pub enum TokenCustodyError {
    /// The keychain could not seal the token, so it is stored nowhere.
    #[error("the token could not be sealed")]
    Sealing(#[source] KeychainRefusal),
    /// The provider's status read reported no signed-in mode for the token.
    #[error("the provider did not accept the token")]
    NotAccepted,
    /// The account's provider has no token status read.
    #[error("the provider has no token status read")]
    NoStatusRead,
    /// The provider's status read could not run.
    #[error("the provider's token status read failed")]
    StatusRead(#[source] DriverError),
    /// The keychain could not list or destroy the sealed items.
    #[error("the sealed tokens could not be swept")]
    Sweep(#[source] KeychainRefusal),
    /// The keychain could not read the account's sealed token.
    #[error("the sealed token could not be read")]
    Unsealing(#[source] KeychainRefusal),
    /// The keychain holds no token for the account.
    #[error("no token is sealed for the account")]
    NotSealed,
    /// The registry could not read or write the account.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
}

impl From<TokenCustodyError> for HandlerError {
    /// A token the keychain could not seal refuses `provider.account.credentialSealRefused` with
    /// its cause, one the provider did not accept `provider.account.tokenNotAccepted`, and a
    /// registry failure as the registry answers it; every other failure is the daemon's own.
    fn from(error: TokenCustodyError) -> Self {
        match error {
            TokenCustodyError::Sealing(refusal) => Self::Refused(DomainError::keychain_refused(
                refusal,
                RefusalCode::ProviderAccountCredentialSealRefused,
                |cause| ProviderAccountCredentialSealRefusedDetails { cause },
            )),
            TokenCustodyError::NotAccepted => Self::Refused(DomainError::new(
                "The provider did not accept that token",
                RefusalCode::ProviderAccountTokenNotAccepted,
            )),
            TokenCustodyError::StatusRead(failure) => failure.into(),
            TokenCustodyError::Registry(failure) => failure.into(),
            error @ (TokenCustodyError::NoStatusRead
            | TokenCustodyError::Sweep(_)
            | TokenCustodyError::Unsealing(_)
            | TokenCustodyError::NotSealed) => Self::Internal(Box::new(error)),
        }
    }
}

/// Keeps each pasted token or API key in the daemon's keychain service for provider tokens, one
/// item per account id, beside the registry row that names it.
pub struct ProviderTokenCustody {
    registry: Arc<ProviderAccountRegistry>,
    keychain: Arc<dyn SecretKeychain>,
    status_legs: HashMap<ProviderId, Arc<dyn ProviderTokenStatusLegs>>,
}

impl ProviderTokenCustody {
    /// Custody over `registry`'s rows and `keychain`'s items, reading a token's status through
    /// each provider's own legs in `status_legs`.
    pub fn new(
        registry: Arc<ProviderAccountRegistry>,
        keychain: Arc<dyn SecretKeychain>,
        status_legs: HashMap<ProviderId, Arc<dyn ProviderTokenStatusLegs>>,
    ) -> Self {
        Self {
            registry,
            keychain,
            status_legs,
        }
    }

    /// Registers `minted` on `token`: seals it, runs the status read in `folders`, then writes the
    /// row with `registration` and the mode the read observed. Fails with
    /// [`TokenCustodyError::Sealing`] when the keychain refuses, with
    /// [`TokenCustodyError::NotAccepted`] when the provider reports no signed-in mode, and when
    /// the read or the row's write fails; a failure after the seal destroys the item, and the
    /// minted home stays for the caller to abandon.
    pub async fn register(
        &self,
        minted: &MintedAccount,
        folders: &ProviderAccountFolders,
        registration: TokenAccountRegistration,
        token: &SecretString,
    ) -> Result<RegisteredAccount, TokenCustodyError> {
        let status_legs = self.status_legs(minted.provider())?;
        let account_id = minted.account_id();
        self.keychain
            .write_verified(account_id.as_str(), token)
            .await
            .map_err(TokenCustodyError::Sealing)?;
        let admitted = async {
            let (health, observed_auth_mode) =
                read_token_status(status_legs, account_id, folders, token).await?;
            let admission = AccountAdmission {
                display_label: Some(registration.display_label),
                billing_mode: registration.billing_mode,
                health,
                observed_auth_mode: Some(observed_auth_mode),
            };
            Ok(self.registry.admit(minted, &admission).await?)
        }
        .await;
        if admitted.is_err() {
            self.destroy_unadmitted(account_id).await;
        }
        admitted
    }

    /// Replaces `account_id`'s sealed token with `token` once the status read in `folders`
    /// accepts it, destroying the prior one, and raises the account's generation with that
    /// reading. Fails with [`TokenCustodyError::NotAccepted`] when the provider reports no
    /// signed-in mode, leaving the prior token and the row as they were, with
    /// [`TokenCustodyError::Sealing`] when the keychain refuses, and when the account is not
    /// registered or cannot be read or written.
    pub async fn replace(
        &self,
        account_id: ProviderAccountId,
        folders: &ProviderAccountFolders,
        token: &SecretString,
    ) -> Result<RegisteredAccount, TokenCustodyError> {
        let account = self.registry.read(account_id).await?;
        let status_legs = self.status_legs(&account.provider)?;
        let (health, observed_auth_mode) =
            read_token_status(status_legs, &account.account_id, folders, token).await?;
        self.keychain
            .write_verified(account.account_id.as_str(), token)
            .await
            .map_err(TokenCustodyError::Sealing)?;
        Ok(self
            .registry
            .record_token_replacement(account.account_id, &health, observed_auth_mode)
            .await?)
    }

    /// The token sealed for `account_id`, which only the provider's own child is handed. Fails
    /// with [`TokenCustodyError::NotSealed`] when none is sealed, and with
    /// [`TokenCustodyError::Unsealing`] when the keychain refuses the read.
    pub async fn read_token(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<SecretString, TokenCustodyError> {
        self.keychain
            .read(account_id.as_str())
            .await
            .map_err(TokenCustodyError::Unsealing)?
            .ok_or(TokenCustodyError::NotSealed)
    }

    /// The start's sweep: destroys every sealed item no registered row names, then deletes each
    /// row whose removal has begun, leaving its home on disk. Fails when the keychain or the
    /// registry cannot be read or written; what it finished stays finished, and the next start
    /// sweeps the rest.
    pub async fn sweep(&self) -> Result<(), TokenCustodyError> {
        let accounts = self.registry.read_account_ids_by_removal_intent().await?;
        let registered: HashSet<&str> = accounts
            .registered
            .iter()
            .map(ProviderAccountId::as_str)
            .collect();
        let items = self
            .keychain
            .accounts()
            .await
            .map_err(TokenCustodyError::Sweep)?;
        for item in items
            .iter()
            .filter(|item| !registered.contains(item.as_str()))
        {
            self.keychain
                .remove(item)
                .await
                .map_err(TokenCustodyError::Sweep)?;
        }
        for account_id in &accounts.marked {
            self.registry.delete_marked_account(account_id).await?;
        }
        Ok(())
    }

    fn status_legs(
        &self,
        provider: &ProviderId,
    ) -> Result<&dyn ProviderTokenStatusLegs, TokenCustodyError> {
        self.status_legs
            .get(provider)
            .map(AsRef::as_ref)
            .ok_or(TokenCustodyError::NoStatusRead)
    }

    // Destroys the item of an account no row was written for. One left behind names no row, so the
    // start's sweep destroys it; the caller still learns why the registration failed.
    async fn destroy_unadmitted(&self, account_id: &ProviderAccountId) {
        if let Err(refusal) = self.keychain.remove(account_id.as_str()).await {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "an unadmitted token's item was left for the start's sweep"
            );
        }
    }
}

// Runs the status read on `token` and answers the reading to store: a pasted token is admitted
// only as the token or API key it is, never as a mode some other sign-in in the home answered.
async fn read_token_status(
    status_legs: &dyn ProviderTokenStatusLegs,
    account_id: &ProviderAccountId,
    folders: &ProviderAccountFolders,
    token: &SecretString,
) -> Result<(HealthObservation, ProviderAuthMode), TokenCustodyError> {
    let observed = status_legs
        .read_token_status(account_id, folders, token)
        .await
        .map_err(TokenCustodyError::StatusRead)?;
    let health = HealthObservation {
        state: ProviderAccountHealthState::Authenticated,
        observed_at: WireInstant::now(),
    };
    match observed {
        Some(mode @ (ProviderAuthMode::OauthToken | ProviderAuthMode::ApiKey)) => {
            Ok((health, mode))
        }
        Some(
            ProviderAuthMode::OauthSubscription
            | ProviderAuthMode::External
            | ProviderAuthMode::None
            | ProviderAuthMode::Unknown,
        )
        | None => Err(TokenCustodyError::NotAccepted),
    }
}

#[cfg(test)]
pub(crate) mod tests;
