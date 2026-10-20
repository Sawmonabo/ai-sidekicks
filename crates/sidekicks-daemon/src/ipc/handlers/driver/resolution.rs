//! The provider driver a handler acts through, found from the run it runs or the session it
//! serves. The address is refused before the provider, so an id that never existed is never
//! reported as a provider problem.

use std::sync::Arc;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::not_found::session_not_found;
use crate::session::run::read::read_run_provider;

/// Why the driver of a live run was not resolved.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LiveRunDriverError {
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
/// Fails as [`resolve_live_run_driver`] fails, and as the pool and the read do.
pub(crate) async fn read_run_driver<Failure>(
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

/// The driver of the provider `bound` names, which the caller read once from the session's
/// binding (`None` for a session this daemon does not hold or that is not bound here, one answer
/// for both). Refused `session.notFound` for `None`, then `provider.notFound` for a provider no
/// driver answers.
pub(crate) fn resolve_session_driver(
    providers: &ProviderRegistry,
    session_id: &SessionId,
    bound: Option<ProviderId>,
) -> Result<Arc<dyn ProviderDriver>, DomainError> {
    let provider = bound.ok_or_else(|| session_not_found(session_id))?;
    providers.lookup(&provider)
}
