//! The provider driver a handler acts through, found from the run it runs or the session it
//! serves. The address is refused before the provider, so an id that never existed is never
//! reported as a provider problem.

use std::sync::Arc;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::not_found::session_not_found;
use crate::session::run::read::read_run_provider;
use crate::session::run::refusals::RunRefusal;

/// The driver of the provider `bound` names, which the caller read once from the run's live
/// binding (`None` for a run unknown or not live). Refused `agent.run.notFound` for `None`, then
/// `provider.notFound` for a provider no driver answers.
pub(crate) fn resolve_run_driver(
    providers: &ProviderRegistry,
    run_id: RunId,
    bound: Option<ProviderId>,
) -> Result<Arc<dyn ProviderDriver>, DomainError> {
    let provider = bound.ok_or(RunRefusal::NotFound { run_id })?;
    providers.lookup(&provider)
}

/// The driver of the provider `run_id` runs on, its binding read through `pool`. Refused as
/// [`resolve_run_driver`] refuses; fails as the pool and the read do.
pub(crate) async fn read_run_driver<Failure>(
    pool: &DatabaseReadPool,
    providers: &ProviderRegistry,
    run_id: RunId,
) -> Result<Arc<dyn ProviderDriver>, Failure>
where
    Failure: From<DatabaseReadError> + From<rusqlite::Error> + From<DomainError> + Send + 'static,
{
    let bound = pool
        .read(ReadLength::Short, move |reader| -> Result<_, Failure> {
            Ok(read_run_provider(reader, &run_id)?)
        })
        .await?;
    Ok(resolve_run_driver(providers, run_id, bound)?)
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
