//! The person's calls on the saved web address and its signing secret: save, make a new secret,
//! remove, and the list of what each delivery channel holds and last did. Each holds the secrets'
//! lock while it reads or changes them, the lock an attempt holds while it reads them, so two first
//! saves at once mint one secret and a removal never races an attempt.

use std::error::Error;

use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::attention::{
    AttentionDeliveryChannel, AttentionDeliveryListResponse, AttentionDeliveryMissing,
    AttentionDeliveryNotConfiguredDetails, AttentionDeliverySecret,
    AttentionDeliveryStoreUnavailableDetails, AttentionEmailDigestDelivery,
    AttentionWebAddressDelivery, AttentionWebAddressSecretRotateResponse,
    AttentionWebAddressUpdateResponse,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::writer::WriteError;
use sidekicks_store::machine::local::LocalMachineError;

use super::{WebAddressSendError, WebAddressSender, drop_statements};
use crate::attention::delivery::MAIL_PASSWORD_ACCOUNT;
use crate::attention::delivery::outcome::{
    DeliveryOutcomes, outcome_removal_statement, read_delivery_outcomes,
};
use crate::attention::delivery::web_address::queue::read_pending;
use crate::attention::delivery::web_address::signature::mint_signing_secret;
use crate::attention::delivery::web_address::{
    SIGNING_SECRET_ACCOUNT, WEB_ADDRESS_ACCOUNT, shown_host,
};

/// Why a call on the web address or the delivery list failed.
#[derive(Debug, thiserror::Error)]
pub enum WebAddressCallError {
    /// The call is refused with a code its method lists.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The system's random source gave no key for a signing secret.
    #[error("the system's random source gave no signing key")]
    Random(#[from] getrandom::Error),
    /// The writer did not keep the write.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// SQLite refused a read, or a stored value does not read as its column's.
    #[error("a read of the delivery channels failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// This machine's row did not read.
    #[error(transparent)]
    Machine(#[from] LocalMachineError),
    /// This machine has no row, which the daemon's start writes before any call is served.
    #[error("this machine has no row to read its name from")]
    MachineUnrecorded,
    /// The machine's settings file did not read.
    #[error(transparent)]
    Settings(Box<WebAddressSendError>),
}

impl From<WebAddressCallError> for HandlerError {
    /// A refusal answers by its code; the rest are faults in the daemon.
    fn from(error: WebAddressCallError) -> Self {
        match error {
            WebAddressCallError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WebAddressCallError::Random(_)
            | WebAddressCallError::Write(_)
            | WebAddressCallError::Database(_)
            | WebAddressCallError::Pool(_)
            | WebAddressCallError::Machine(_)
            | WebAddressCallError::MachineUnrecorded
            | WebAddressCallError::Settings(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl WebAddressSender {
    /// Saves `address`. The first save, with no address held, mints the signing secret, keeps it,
    /// then the address, and returns the secret this once; every later save keeps only the address
    /// and returns `null`. Refuses text that is not an `http` or `https` address with a host
    /// `attention.webAddress.notAnAddress`, with nothing kept, and a keychain that could not be
    /// used `attention.delivery.storeUnavailable`.
    pub async fn save_address(
        &self,
        address: &AttentionDeliverySecret,
    ) -> Result<AttentionWebAddressUpdateResponse, WebAddressCallError> {
        let Some(address) = WebAddress::new(address.as_str()) else {
            return Err(DomainError::new(
                "Not a web address.",
                RefusalCode::AttentionWebAddressNotAnAddress,
            )
            .into());
        };
        let _held = self.lock_secrets().await;
        let is_address_held = self
            .accounts()
            .await?
            .iter()
            .any(|account| account == WEB_ADDRESS_ACCOUNT);
        let signing_secret = if is_address_held {
            None
        } else {
            Some(self.keep_new_signing_secret().await?)
        };
        self.keychain
            .write_verified(
                WEB_ADDRESS_ACCOUNT,
                &SecretString::from(address.as_str().to_owned()),
            )
            .await
            .map_err(store_unavailable)?;
        Ok(AttentionWebAddressUpdateResponse {
            host: shown_host(&address),
            signing_secret,
        })
    }

    /// Mints a new signing secret, keeps it in place of the old one, which stops verifying at once,
    /// and returns it this once. Refuses with no address saved `attention.delivery.notConfigured`,
    /// and a keychain that could not be used `attention.delivery.storeUnavailable`.
    pub async fn rotate_signing_secret(
        &self,
    ) -> Result<AttentionWebAddressSecretRotateResponse, WebAddressCallError> {
        let _held = self.lock_secrets().await;
        if !self
            .accounts()
            .await?
            .iter()
            .any(|account| account == WEB_ADDRESS_ACCOUNT)
        {
            return Err(address_not_configured().into());
        }
        Ok(AttentionWebAddressSecretRotateResponse {
            signing_secret: self.keep_new_signing_secret().await?,
        })
    }

    /// Removes the saved address: abandons the attempt in flight and waits for it to end, removes
    /// the address, then its signing secret, then the outcome row, and drops every message still to
    /// send as undelivered, uncounted. Refuses a keychain that could not be used
    /// `attention.delivery.storeUnavailable`; a refused removal of the address removes nothing,
    /// and a refused removal of the secret keeps the row, while no message goes with no address.
    pub async fn remove_address(&self) -> Result<(), WebAddressCallError> {
        let held = self.lock_secrets().await;
        self.abandon_attempt(&held).await;
        self.keychain
            .remove(WEB_ADDRESS_ACCOUNT)
            .await
            .map_err(store_unavailable)?;
        self.keychain
            .remove(SIGNING_SECRET_ACCOUNT)
            .await
            .map_err(store_unavailable)?;
        let pending = self
            .pool
            .read(ReadLength::Short, |connection| {
                Ok::<_, WebAddressCallError>(read_pending(connection)?)
            })
            .await?;
        let mut statements = vec![outcome_removal_statement(
            AttentionDeliveryChannel::WebAddress,
        )];
        statements.extend(pending.iter().flat_map(drop_statements));
        self.writer.write(statements).await?;
        Ok(())
    }

    /// What each delivery channel holds and last did: whether an address is saved and its scheme
    /// and host, whether a mail password is saved, and each channel's last attempt. Refuses a
    /// keychain that could not be used `attention.delivery.storeUnavailable`.
    pub async fn list_deliveries(
        &self,
    ) -> Result<AttentionDeliveryListResponse, WebAddressCallError> {
        let held = self.lock_secrets().await;
        let accounts = self.accounts().await?;
        let host = if accounts
            .iter()
            .any(|account| account == WEB_ADDRESS_ACCOUNT)
        {
            self.keychain
                .read(WEB_ADDRESS_ACCOUNT)
                .await
                .map_err(store_unavailable)?
                .and_then(|address| WebAddress::new(address.expose_secret()))
                .map(|address| shown_host(&address))
        } else {
            None
        };
        drop(held);
        let outcomes = self.read_outcomes().await?;
        Ok(AttentionDeliveryListResponse {
            web_address: AttentionWebAddressDelivery {
                saved: host.is_some(),
                host,
                last_outcome: outcomes.web_address.last_outcome,
            },
            email_digest: AttentionEmailDigestDelivery {
                password_saved: accounts
                    .iter()
                    .any(|account| account == MAIL_PASSWORD_ACCOUNT),
                last_outcome: outcomes.email_digest.last_outcome,
            },
        })
    }

    /// Both channels' outcome rows.
    pub(super) async fn read_outcomes(&self) -> Result<DeliveryOutcomes, WebAddressCallError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                Ok::<_, WebAddressCallError>(read_delivery_outcomes(connection)?)
            })
            .await
    }

    // Every account the delivery secrets' keychain holds.
    async fn accounts(&self) -> Result<Vec<String>, WebAddressCallError> {
        Ok(self.keychain.accounts().await.map_err(store_unavailable)?)
    }

    // Mints a signing secret and keeps it, returning its text.
    async fn keep_new_signing_secret(&self) -> Result<NonEmptyText, WebAddressCallError> {
        let secret = mint_signing_secret()?;
        self.keychain
            .write_verified(SIGNING_SECRET_ACCOUNT, &secret)
            .await
            .map_err(store_unavailable)?;
        Ok(NonEmptyText::new(secret.expose_secret().to_owned())
            .expect("a minted signing secret is not empty"))
    }
}

/// The refusal of a call that needs a saved address when none is.
pub(super) fn address_not_configured() -> DomainError {
    DomainError::new(
        "No web address is saved.",
        RefusalCode::AttentionDeliveryNotConfigured,
    )
    .with_detail(AttentionDeliveryNotConfiguredDetails {
        missing: AttentionDeliveryMissing::Address,
    })
}

/// The refusal of a saved address whose signing secret is missing from the keychain, which is
/// one that could not be used.
pub(super) fn signing_secret_missing() -> DomainError {
    DomainError::new(
        "The web address's signing secret is missing from the keychain, so nothing was sent.",
        RefusalCode::AttentionDeliveryStoreUnavailable,
    )
    .with_detail(AttentionDeliveryStoreUnavailableDetails {
        cause: KeychainRefusalCause::Unavailable,
    })
}

/// The refusal of a keychain that could not be used, with its cause.
pub(super) fn store_unavailable(refusal: KeychainRefusal) -> DomainError {
    tracing::info!(
        error = &refusal as &(dyn Error + 'static),
        "the delivery secrets' keychain could not be used"
    );
    DomainError::keychain_refused(
        refusal,
        RefusalCode::AttentionDeliveryStoreUnavailable,
        |cause| AttentionDeliveryStoreUnavailableDetails { cause },
    )
}

#[cfg(test)]
mod tests;
