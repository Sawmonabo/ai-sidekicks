//! The provider driver a handler acts through, found from the run it runs or the session it
//! serves, and the account a run is admitted against. The address is refused before the provider,
//! so an id that never existed is never reported as a provider problem.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_provider::driver::contract::{DriverError, ProviderDriver};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{ProviderAccountReader, read_current_account};
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};

use crate::run::agent::read_lead_binding;
use crate::run::read::read_run_provider;

/// Why the driver of a live run was not resolved.
#[derive(Debug, thiserror::Error)]
pub enum LiveRunDriverError {
    /// No binding on the run's chain names a provider. Every live run has one, so the record is
    /// broken: a fault in the daemon, never a refusal of the call.
    #[error("live run {run_id} has no runtime binding on its chain")]
    Unbound {
        /// The run.
        run_id: RunId,
    },
    /// No registered driver answers the run's provider (`provider.notFound`).
    #[error(transparent)]
    ProviderNotFound(DomainError),
}

impl From<LiveRunDriverError> for HandlerError {
    /// A provider no driver answers refuses the call; a live run with no binding is a fault.
    fn from(error: LiveRunDriverError) -> Self {
        match error {
            LiveRunDriverError::ProviderNotFound(refusal) => Self::Refused(refusal),
            unbound @ LiveRunDriverError::Unbound { .. } => Self::Internal(Box::new(unbound)),
        }
    }
}

/// The driver of the provider `bound` names, which the caller read from the run's binding once it
/// found the run live. Fails with [`LiveRunDriverError::Unbound`] for `None` and
/// [`LiveRunDriverError::ProviderNotFound`] for a provider no driver answers.
pub(crate) fn resolve_live_run_driver(
    providers: &ProviderRegistry,
    run_id: RunId,
    bound: Option<ProviderId>,
) -> Result<Arc<dyn ProviderDriver>, LiveRunDriverError> {
    let provider = bound.ok_or(LiveRunDriverError::Unbound { run_id })?;
    providers
        .lookup(&provider)
        .map_err(LiveRunDriverError::ProviderNotFound)
}

/// The driver of the provider the live run `run_id` runs on, its binding read through `pool`.
/// Fails as `resolve_live_run_driver` fails, and as the pool and the read do.
pub async fn read_run_driver<Failure>(
    pool: &DatabaseReadPool,
    providers: &ProviderRegistry,
    run_id: RunId,
) -> Result<Arc<dyn ProviderDriver>, Failure>
where
    Failure:
        From<DatabaseReadError> + From<rusqlite::Error> + From<LiveRunDriverError> + Send + 'static,
{
    let bound = pool
        .read(ReadLength::Short, move |reader| -> Result<_, Failure> {
            Ok(read_run_provider(reader, &run_id)?.map(|bound| bound.provider))
        })
        .await?;
    Ok(resolve_live_run_driver(providers, run_id, bound)?)
}

/// The provider `bound` names and its driver, which the caller read once from the session's
/// binding (`None` for a session this daemon does not hold or that is not bound here, one answer
/// for both). Refused `session.notFound` for `None`, then `provider.notFound` for a provider no
/// driver answers.
pub(crate) fn resolve_session_driver(
    providers: &ProviderRegistry,
    session_id: &SessionId,
    bound: Option<ProviderId>,
) -> Result<(ProviderId, Arc<dyn ProviderDriver>), DomainError> {
    let provider = bound.ok_or_else(|| session_not_found(session_id))?;
    let driver = providers.lookup(&provider)?;
    Ok((provider, driver))
}

/// The provider the session's lead runs on, the account it is bound to (`None` for the provider's
/// current account) and its driver, the lead's binding read through `pool` from the readable part
/// of the session's log. Refused as `resolve_session_driver` refuses, and fails as the pool and
/// the read do.
pub async fn read_session_driver<Failure>(
    pool: &DatabaseReadPool,
    providers: &ProviderRegistry,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: SessionId,
) -> Result<
    (
        ProviderId,
        Option<ProviderAccountId>,
        Arc<dyn ProviderDriver>,
    ),
    Failure,
>
where
    Failure: From<DatabaseReadError> + From<rusqlite::Error> + From<DomainError> + Send + 'static,
{
    let read_bound = session_read_bound(read_damaged_from_sequence, &session_id, None);
    let bound = pool
        .read(ReadLength::Short, move |reader| -> Result<_, Failure> {
            Ok(read_lead_binding(reader, &session_id, read_bound)?)
        })
        .await?;
    let (provider, provider_account_id) = bound.unzip();
    let (provider, driver) = resolve_session_driver(providers, &session_id, provider)?;
    Ok((provider, provider_account_id.flatten(), driver))
}

/// The account a run on `provider` is admitted against: `bound`, the account the session is bound
/// to, else the provider's current account read through `provider_accounts`, resolved before any
/// driver call. Refused `provider.account.notRegistered` with no account registered and
/// `provider.account.current.notSet` with none current; fails as the accounts cannot be read.
pub async fn resolve_admitted_account(
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
    provider: &ProviderId,
    bound: Option<ProviderAccountId>,
) -> Result<ProviderAccountId, DriverError> {
    match bound {
        Some(bound) => Ok(bound),
        None => read_current_account(provider_accounts, provider.clone()).await,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_provider::driver::CurrentProviderAccount;
    use sidekicks_provider::driver::registry::test_provider;
    use sidekicks_provider::driver::test_registry::registered_test_accounts;

    use sidekicks_provider::driver::contract::DriverError;

    use super::resolve_admitted_account;

    // Killed by answering any account, the person's own sign-in among them, where the provider
    // has no current account: each case refuses with its own code before any driver call.
    #[rstest]
    #[case::nothing_registered(
        CurrentProviderAccount::NoneRegistered,
        RefusalCode::ProviderAccountNotRegistered
    )]
    #[case::none_current(
        CurrentProviderAccount::NoneCurrent,
        RefusalCode::ProviderAccountCurrentNotSet
    )]
    #[tokio::test]
    async fn admission_refuses_a_provider_with_no_account_to_run_on(
        #[case] current: CurrentProviderAccount,
        #[case] code: RefusalCode,
    ) {
        let provider_accounts = registered_test_accounts(current);

        let resolved = resolve_admitted_account(&provider_accounts, &test_provider(), None).await;

        assert!(
            matches!(&resolved, Err(DriverError::Refused(refusal)) if refusal.code == code),
            "the admission was not refused {code:?}: {resolved:?}"
        );
    }
}
