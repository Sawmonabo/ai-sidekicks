//! The driver methods a client calls: each installed provider's models and modes, the compaction
//! of one run's context, and the commands an agent's providers publish. Every call is refused by
//! the session first, then the run or agent it names, then the binding, and only then by a driver.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::{join_all, try_join_all};
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandListResponse,
};
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::methods::{
    AgentRunContextCompact, AgentRunContextCompactRequest, ProviderCommandList,
    ProviderCommandListRequest, ProviderModeList, ProviderModeListResponse, ProviderModeReport,
    ProviderModelList, ProviderModelListFailure, ProviderModelListResponse, ProviderModelReport,
    ProviderModelsFailed, ProviderModelsListed,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::provider::driver::capabilities::DriverCapabilityFlag;
use crate::provider::driver::contract::{
    CompactContextParams, DriverError, ListModelsParams, ListProviderCommandsParams,
};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::runtime_binding::live_runs::{
    AgentBindingResolution, RunBindingResolution, resolve_agent_bindings, resolve_run_binding,
};
use crate::session::directory::lookups::SESSION_EXISTS_SQL;
use crate::session::not_found::session_not_found;
use crate::session::run::agent::read_lead_binding;
use crate::session::run::refusals::RunRefusal;

#[cfg(test)]
mod tests;

/// What the driver methods read and act through.
pub(crate) struct DriverMethodSources {
    /// The read pool every read borrows a connection from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The registered drivers.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Where each session's log reads stop while its history is damaged.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// A read the driver methods make did not run: a fault in the daemon.
#[derive(Debug, thiserror::Error)]
enum DriverMethodReadError {
    /// SQLite refused the read, or a stored value does not read as its type.
    #[error("a driver method's read failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error("the read pool did not run a driver method's read")]
    Pool(#[from] DatabaseReadError),
}

impl From<DriverMethodReadError> for HandlerError {
    fn from(error: DriverMethodReadError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `provider.model.list`, `provider.mode.list`, `agent.run.context.compact` and
/// `provider.command.list` over `sources`. Fails the start when one is already registered.
#[expect(dead_code, reason = "the daemon's start")]
pub(crate) fn register_driver_methods(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<DriverMethodSources>,
) -> Result<(), RegistrationError> {
    let model_sources = Arc::clone(sources);
    registry.register::<ProviderModelList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&model_sources);
        async move { list_models(&sources, request.session_id).await }.boxed()
    })?;
    let mode_sources = Arc::clone(sources);
    registry.register::<ProviderModeList, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let sources = Arc::clone(&mode_sources);
            async move { list_modes(&sources.providers).await }.boxed()
        },
    )?;
    let compact_sources = Arc::clone(sources);
    registry.register::<AgentRunContextCompact, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&compact_sources);
        async move { compact_context(&sources, request).await }.boxed()
    })?;
    let command_sources = Arc::clone(sources);
    registry.register::<ProviderCommandList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&command_sources);
        async move { list_provider_commands(&sources, request).await }.boxed()
    })
}

// Each installed provider's catalog, the session's own provider first and read against its bound
// account, every other one against its default account; a provider whose bare command name no
// search found is not installed and is left out, and one whose read failed, a typed command path
// with nothing runnable at it among them, carries its failure.
async fn list_models(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<ProviderModelListResponse, HandlerError> {
    let read_bound = session_read_bound(
        sources.read_damaged_from_sequence.as_ref(),
        &session_id,
        None,
    );
    let lead = sources
        .pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<_, DriverMethodReadError> {
                if !session_exists(reader, &session_id)? {
                    return Ok(None);
                }
                Ok(Some(read_lead_binding(reader, &session_id, read_bound)?))
            },
        )
        .await?;
    let Some(lead) = lead else {
        return Err(session_not_found(&session_id).into());
    };
    let (own_provider, own_account) = lead.map_or((None, None), |(provider, account)| {
        (Some(provider), account)
    });
    let mut drivers: Vec<_> = sources.providers.drivers().collect();
    // Stable, so the rest keep the table's order.
    drivers.sort_by_key(|(provider, _)| Some(*provider) != own_provider.as_ref());
    let reads = drivers.into_iter().map(|(provider, driver)| {
        let is_own = Some(provider) == own_provider.as_ref();
        let read = driver.list_models(ListModelsParams {
            session_id: is_own.then_some(session_id),
            provider_account_id: if is_own { own_account.clone() } else { None },
        });
        async move { (provider.clone(), read.await) }
    });
    let providers = join_all(reads)
        .await
        .into_iter()
        .filter_map(|(provider_name, read)| match read {
            Ok(models) => Some(ProviderModelReport::Listed(ProviderModelsListed {
                provider_name,
                models,
                failure: None,
            })),
            Err(DriverError::ExecutableUnresolvable(unresolvable))
                if unresolvable.is_not_installed() =>
            {
                None
            }
            Err(
                failed @ (DriverError::Refused(_)
                | DriverError::ExecutableUnresolvable(_)
                | DriverError::Unanswered(_)
                | DriverError::SteerTurnEnded(_)
                | DriverError::CapabilityProbe(_)
                | DriverError::Internal(_)),
            ) => Some(ProviderModelReport::Failed(ProviderModelsFailed {
                failure: model_list_failure(&provider_name, failed),
                provider_name,
                models: None,
            })),
        })
        .collect();
    Ok(ProviderModelListResponse { providers })
}

// What one provider's failed catalog read shows: its refusal's code and the provider's words, or
// `provider.unavailable` for a fault inside the driver, which the service log keeps.
fn model_list_failure(provider: &ProviderId, failed: DriverError) -> ProviderModelListFailure {
    match HandlerError::from(failed) {
        HandlerError::Refused(refusal) => ProviderModelListFailure {
            code: refusal.code.as_str().to_owned(),
            provider_failure_detail: refusal
                .detail
                .as_ref()
                .and_then(|detail| detail.get("providerFailureDetail"))
                .and_then(Value::as_str)
                .and_then(|detail| FreeFormText::new(detail.to_owned()).ok()),
        },
        fault @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            tracing::warn!(
                provider = provider.as_str(),
                error = &fault as &(dyn std::error::Error + 'static),
                "a provider's model catalog could not be read"
            );
            ProviderModelListFailure {
                code: RefusalCode::ProviderUnavailable.as_str().to_owned(),
                provider_failure_detail: None,
            }
        }
    }
}

// Each installed provider's modes in the table's order; a provider whose bare command name no
// search found is left out, and any other failed read fails the list.
async fn list_modes(
    providers: &ProviderRegistry,
) -> Result<ProviderModeListResponse, HandlerError> {
    let reads = providers.drivers().map(|(provider, driver)| {
        let read = driver.list_modes();
        async move { (provider.clone(), read.await) }
    });
    let mut reports = Vec::new();
    for (provider_name, read) in join_all(reads).await {
        match read {
            Ok(modes) => reports.push(ProviderModeReport {
                provider_name,
                modes,
            }),
            Err(DriverError::ExecutableUnresolvable(unresolvable))
                if unresolvable.is_not_installed() => {}
            Err(
                failed @ (DriverError::Refused(_)
                | DriverError::ExecutableUnresolvable(_)
                | DriverError::Unanswered(_)
                | DriverError::SteerTurnEnded(_)
                | DriverError::CapabilityProbe(_)
                | DriverError::Internal(_)),
            ) => return Err(failed.into()),
        }
    }
    Ok(ProviderModeListResponse { providers: reports })
}

// Refused in order: the session, then the run, then a run with no live binding, then a provider
// no driver answers, then a driver without the flag; the driver's answer is data.
async fn compact_context(
    sources: &DriverMethodSources,
    request: AgentRunContextCompactRequest,
) -> Result<AgentRunContextCompactResponse, HandlerError> {
    let AgentRunContextCompactRequest { session_id, run_id } = request;
    let resolution = sources
        .pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<_, DriverMethodReadError> {
                if !session_exists(reader, &session_id)? {
                    return Ok(None);
                }
                Ok(Some(resolve_run_binding(reader, &session_id, &run_id)?))
            },
        )
        .await?;
    let (provider, binding_id) = match resolution {
        None => return Err(session_not_found(&session_id).into()),
        Some(RunBindingResolution::UnknownRun {}) => {
            return Err(DomainError::from(RunRefusal::NotFound { run_id }).into());
        }
        Some(RunBindingResolution::NoLiveBinding {}) => {
            return Err(no_live_binding(json!({ "runId": run_id })).into());
        }
        Some(RunBindingResolution::Bound {
            provider_name,
            binding_id,
        }) => (provider_name, binding_id),
    };
    let driver = sources.providers.lookup(&provider)?;
    sources
        .providers
        .check_capability(&provider, DriverCapabilityFlag::ContextCompaction)?;
    Ok(driver
        .compact_context(CompactContextParams {
            session_id,
            binding_id,
        })
        .await?)
}

// Refused in order: the session, then an agent the log names nowhere, then an agent with no live
// binding; then every binding is admitted (its driver and flag) before any is read, and the reads
// run together, answered in the agent's binding order.
async fn list_provider_commands(
    sources: &DriverMethodSources,
    request: ProviderCommandListRequest,
) -> Result<ProviderCommandListResponse, HandlerError> {
    let ProviderCommandListRequest {
        session_id,
        agent_id,
    } = request;
    let read_bound = session_read_bound(
        sources.read_damaged_from_sequence.as_ref(),
        &session_id,
        None,
    );
    let resolution = sources
        .pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<_, DriverMethodReadError> {
                if !session_exists(reader, &session_id)? {
                    return Ok(None);
                }
                Ok(Some(resolve_agent_bindings(
                    reader,
                    &session_id,
                    &agent_id,
                    read_bound,
                )?))
            },
        )
        .await?;
    let bindings = match resolution {
        None => return Err(session_not_found(&session_id).into()),
        Some(AgentBindingResolution::UnknownAgent {}) => {
            return Err(agent_not_found(&agent_id).into());
        }
        Some(AgentBindingResolution::NoLiveBinding {}) => {
            return Err(no_live_binding(json!({ "agentId": agent_id })).into());
        }
        Some(AgentBindingResolution::Bound(bindings)) => bindings,
    };
    let admitted = bindings
        .into_iter()
        .map(|binding| {
            let driver = sources.providers.lookup(&binding.provider_name)?;
            sources.providers.check_capability(
                &binding.provider_name,
                DriverCapabilityFlag::ProviderCommands,
            )?;
            Ok((driver, binding))
        })
        .collect::<Result<Vec<_>, DomainError>>()?;
    let groups = try_join_all(admitted.into_iter().map(|(driver, binding)| async move {
        driver
            .list_provider_commands(ListProviderCommandsParams {
                session_id,
                binding_id: binding.binding_id,
                binding: ProviderCommandBinding {
                    provider_name: binding.provider_name,
                    provider_account_id: binding.provider_account_id,
                },
                run_id: binding.run_id,
            })
            .await
    }))
    .await?;
    Ok(ProviderCommandListResponse {
        bindings: BoundedVec::new(groups).expect("an agent with a live binding has a group"),
    })
}

// Whether the daemon holds the session.
fn session_exists(reader: &rusqlite::Connection, session_id: &SessionId) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(SESSION_EXISTS_SQL)?
        .exists(rusqlite::named_params! { "@sessionId": session_id.text().as_str() })
}

// The refusal of a call whose run or agent has no live binding: none was started, or its process
// is gone.
fn no_live_binding(detail: Value) -> DomainError {
    DomainError::new(
        "No live provider binding serves that request",
        RefusalCode::ProviderUnavailable,
    )
    .with_detail(detail)
}

// The refusal of an agent the session's log names nowhere.
fn agent_not_found(agent_id: &AgentId) -> DomainError {
    DomainError::new(
        "The session holds no such agent",
        RefusalCode::AgentNotFound,
    )
    .with_detail(json!({ "agentId": agent_id }))
}
