//! Why a registry act failed, and how each failure answers a caller. No message and no detail
//! names an account's credential home, and no failure underneath carries one, so neither a reply
//! nor the service log line that keeps the failure shows a home's path.

use std::io;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::database::writer::WriteError;

/// Why a provider account registry act failed; nothing it would have written was kept.
#[derive(Debug, thiserror::Error)]
pub enum ProviderAccountRegistryError {
    /// No account of that id is registered, or its removal has begun.
    #[error("the provider account is not registered")]
    NotFound,
    /// A workflow step is waiting on the account, so its removal was not begun.
    #[error("a workflow step is waiting on the provider account")]
    StepWaiting,
    /// The system gave no random bytes for the account's id.
    #[error("the provider account's id could not be minted")]
    Mint(#[source] getrandom::Error),
    /// The account's credential home could not be made or removed.
    #[error("the provider account's credential home could not be made or removed")]
    CredentialHome(#[source] io::Error),
    /// No connection could read the accounts.
    #[error("the provider accounts could not be read")]
    Read(#[from] DatabaseReadError),
    /// The accounts' query failed, or a stored value did not read as its type.
    #[error("the provider accounts could not be queried")]
    Query(#[from] rusqlite::Error),
    /// The write was not kept.
    #[error("the provider account write was not kept")]
    Write(#[source] WriteError),
}

impl From<ProviderAccountRegistryError> for HandlerError {
    /// An unregistered account refuses `provider.account.notFound`, a waiting step
    /// `provider.account.inUse`, and a home that could not be made
    /// `provider.account.credentialHome.unavailable`; every other failure is the daemon's own.
    fn from(error: ProviderAccountRegistryError) -> Self {
        match error {
            ProviderAccountRegistryError::NotFound => Self::Refused(DomainError::new(
                "The provider account is not registered",
                RefusalCode::ProviderAccountNotFound,
            )),
            ProviderAccountRegistryError::StepWaiting => Self::Refused(DomainError::new(
                "A workflow step is waiting on the provider account",
                RefusalCode::ProviderAccountInUse,
            )),
            ProviderAccountRegistryError::CredentialHome(failure) => Self::Refused(
                DomainError::new(
                    "The provider account's credential home is unavailable",
                    RefusalCode::ProviderAccountCredentialHomeUnavailable,
                )
                .with_source(failure),
            ),
            error @ (ProviderAccountRegistryError::Mint(_)
            | ProviderAccountRegistryError::Read(_)
            | ProviderAccountRegistryError::Query(_)
            | ProviderAccountRegistryError::Write(_)) => Self::Internal(Box::new(error)),
        }
    }
}
