//! The driver methods a client calls: each installed provider's models and modes, the compaction
//! of one run's context, the commands an agent's providers publish, and the provider sessions
//! typed in a terminal with each one's provider words. A call that names a session is refused by
//! the session first, then the run or agent it names, then the binding, and only then by a driver;
//! the terminal sessions' list names none and is refused by none but a driver.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::{join_all, try_join_all};
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::declaration::ProviderDeclarationText;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandListResponse,
};
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::methods::{
    AgentRunContextCompact, AgentRunContextCompactRequest, ProviderCommandList,
    ProviderCommandListRequest, ProviderModeList, ProviderModeListResponse, ProviderModeReport,
    ProviderModelList, ProviderModelListResponse, ProviderModelReport, ProviderModelsFailed,
    ProviderModelsListed, ProviderModesFailed, ProviderModesListed, ProviderReadFailure,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::{
    ProviderTerminalSessionList, ProviderTerminalSessionListResponse, TerminalSessionProvider,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::agent::agent_not_found;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::{
    CompactContextParams, ListModelsParams, ListModesParams, ListProviderCommandsParams,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::pricing::store::HeldPriceList;
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::run::agent::{SessionLead, read_session_lead};
use sidekicks_session::run::live_bindings::{
    AgentBindingResolution, RunBindingResolution, resolve_agent_bindings, resolve_run_binding,
};
use sidekicks_session::run::refusals::RunRefusal;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};

/// The statements the driver methods prepare on a read connection: the session's row, the lead's
/// binding, the run's row, its bindings and its provider, the session's live runs, a binding's row
/// and whether the log names an agent.
pub(crate) const DRIVER_METHODS_STATEMENT_CAPACITY: usize = 8;

/// What the driver methods read and act through.
pub(crate) struct DriverMethodSources {
    /// The read pool every read borrows a connection from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The registered drivers.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Where each session's log reads stop while its history is damaged.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The held price list, on which every model a provider lists is marked in use.
    pub(crate) price_list: Arc<PortRegistration<Arc<HeldPriceList>>>,
}

impl DriverMethodSources {
    /// The provider `session_id`'s lead runs on and its driver, once the session and its provider
    /// pass. Fails with [`DriverMethodReadError::Refused`] for a session the daemon does not hold
    /// or whose provider no driver answers, and as the read fails.
    pub(crate) async fn resolve_driver(
        &self,
        session_id: SessionId,
    ) -> Result<(ProviderId, Arc<dyn ProviderDriver>), DriverMethodReadError> {
        let (provider, _, driver) = read_session_driver::<DriverMethodReadError>(
            &self.pool,
            &self.providers,
            self.read_damaged_from_sequence.as_ref(),
            session_id,
        )
        .await?;
        Ok((provider, driver))
    }
}

/// Why a driver method's read of a session did not answer: a refusal the caller reads by its code,
/// or a read that did not run, a fault in the daemon.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DriverMethodReadError {
    /// The session is not one the daemon holds, or no driver answers its provider.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read, or a stored value does not read as its type.
    #[error("a driver method's read failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error("the read pool did not run a driver method's read")]
    Pool(#[from] DatabaseReadError),
}

impl From<DriverMethodReadError> for HandlerError {
    fn from(error: DriverMethodReadError) -> Self {
        match error {
            DriverMethodReadError::Refused(refusal) => Self::Refused(refusal),
            fault @ (DriverMethodReadError::Read(_) | DriverMethodReadError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Registers `provider.model.list`, `provider.mode.list`, `agent.run.context.compact`,
/// `provider.command.list` and `provider.terminalSession.list` over `sources`. Fails the start
/// when one is already registered.
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
    registry.register::<ProviderModeList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&mode_sources);
        async move { list_modes(&sources, request.session_id).await }.boxed()
    })?;
    let compact_sources = Arc::clone(sources);
    registry.register::<AgentRunContextCompact, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&compact_sources);
        async move { compact_context(&sources, request).await }.boxed()
    })?;
    let command_sources = Arc::clone(sources);
    registry.register::<ProviderCommandList, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&command_sources);
        async move { list_provider_commands(&sources, request).await }.boxed()
    })?;
    let terminal_sources = Arc::clone(sources);
    registry.register::<ProviderTerminalSessionList, _>(
        move |_: EmptyPayload, _context: HandlerContext| {
            let sources = Arc::clone(&terminal_sources);
            async move { list_terminal_sessions(&sources).await }.boxed()
        },
    )
}

// Every driver's sessions typed in a terminal, in the table's order, with the name and resume
// command of each provider that has one; one driver's failed read fails the call, so a service
// that is on never reads as holding none.
async fn list_terminal_sessions(
    sources: &DriverMethodSources,
) -> Result<ProviderTerminalSessionListResponse, HandlerError> {
    let lists = try_join_all(
        sources
            .providers
            .drivers()
            .map(|(provider, driver)| async move {
                driver
                    .list_terminal_sessions()
                    .await
                    .map(|sessions| (provider, sessions))
            }),
    )
    .await?;
    let mut providers = Vec::new();
    let mut all_sessions = Vec::new();
    for (provider, sessions) in lists {
        if sessions.is_empty() {
            continue;
        }
        let descriptor = sources.providers.descriptor(provider)?;
        providers.push(TerminalSessionProvider {
            provider: provider.clone(),
            name: declaration_text(descriptor.name()),
            resume_command: declaration_text(descriptor.terminal_resume_command()),
        });
        all_sessions.extend(sessions);
    }
    Ok(ProviderTerminalSessionListResponse {
        sessions: all_sessions,
        providers,
    })
}

// A descriptor's fixed words on the wire; the provider table's build check holds them to the
// declaration text's rules.
fn declaration_text(text: &'static str) -> ProviderDeclarationText {
    ProviderDeclarationText::new(text.to_owned())
        .expect("the provider table's build check holds a descriptor's words")
}

// Each installed provider's catalog, the session's own provider first and read against its bound
// account, every other one against its default account; a provider whose bare command name no
// search found is not installed and is left out, and one whose read failed, a typed command path
// with nothing runnable at it among them, carries its failure. Every model listed is marked in use
// on the held price list, so its prices are read from then on, and one whose row the held copy
// carries but prices at no rate for a speed the listing offers is fetched for at once.
async fn list_models(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<ProviderModelListResponse, HandlerError> {
    let drivers = read_drivers_own_first(sources, session_id).await?;
    let reads = drivers.into_iter().map(|(provider, driver, own_lead)| {
        let read = driver.list_models(ListModelsParams {
            session_id: own_lead.is_some().then_some(session_id),
            provider_account_id: own_lead.and_then(|lead| lead.binding.provider_account_id),
        });
        let pricer = driver.request_pricer();
        async move { (provider.clone(), pricer, read.await) }
    });
    let reads = join_all(reads).await;
    if let Some(price_list) = sources.price_list.port() {
        let listed = || {
            (reads.iter())
                .filter_map(|(_, pricer, read)| Some((pricer, read.as_ref().ok()?)))
                .flat_map(|(pricer, models)| models.iter().map(move |model| (pricer, model)))
        };
        let model_ids: Vec<&str> = listed().map(|(_, model)| model.id.as_str()).collect();
        price_list.mark_in_use(&model_ids).await;
        let table = price_list.table();
        for (pricer, model) in listed() {
            // A model the copy lacks was reported as it was marked.
            let lacks_speed = pricer.as_ref().is_some_and(|pricer| {
                table.row(model.id.as_str()).is_some() && !pricer.prices_listed_model(&table, model)
            });
            if lacks_speed {
                price_list.report_missing(model.id.as_str());
            }
        }
    }
    let providers = reads
        .into_iter()
        .filter_map(|(provider_name, _, read)| {
            provider_outcome(
                provider_name,
                read,
                |provider_name, models| {
                    ProviderModelReport::Listed(ProviderModelsListed {
                        provider_name,
                        models,
                        failure: None,
                    })
                },
                |provider_name, failure| {
                    ProviderModelReport::Failed(ProviderModelsFailed {
                        provider_name,
                        failure,
                        models: None,
                    })
                },
            )
        })
        .collect();
    Ok(ProviderModelListResponse { providers })
}

// Every registered driver, the session's own provider first and the rest in the table's order,
// each beside the session's lead where it is the lead's provider; the session's existence and its
// lead are read in one short read. Refused `session.notFound` for a session the daemon does not
// hold.
async fn read_drivers_own_first(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<Vec<(&ProviderId, &Arc<dyn ProviderDriver>, Option<SessionLead>)>, HandlerError> {
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
                Ok(Some(read_session_lead(reader, &session_id, read_bound)?))
            },
        )
        .await?;
    let Some(mut lead) = lead else {
        return Err(session_not_found(&session_id).into());
    };
    let own_provider = lead.as_ref().map(|lead| lead.binding.provider_name.clone());
    let mut drivers: Vec<_> = sources.providers.drivers().collect();
    // Stable, so the rest keep the table's order.
    drivers.sort_by_key(|(provider, _)| Some(*provider) != own_provider.as_ref());
    Ok(drivers
        .into_iter()
        .map(|(provider, driver)| {
            let own_lead = if Some(provider) == own_provider.as_ref() {
                lead.take()
            } else {
                None
            };
            (provider, driver, own_lead)
        })
        .collect())
}

// One provider's outcome of a read of its models or modes: `listed` with what it read, or `failed`
// with why the read failed; `None` for a provider whose bare command name no search found, which
// is not installed.
fn provider_outcome<Read, Report>(
    provider_name: ProviderId,
    read: Result<Read, DriverError>,
    listed: impl FnOnce(ProviderId, Read) -> Report,
    failed: impl FnOnce(ProviderId, ProviderReadFailure) -> Report,
) -> Option<Report> {
    match read {
        Ok(read) => Some(listed(provider_name, read)),
        Err(DriverError::ExecutableUnresolvable(unresolvable))
            if unresolvable.is_not_installed() =>
        {
            None
        }
        Err(
            failure @ (DriverError::Refused(_)
            | DriverError::ExecutableUnresolvable(_)
            | DriverError::ModelCatalogUnreadable(_)
            | DriverError::ProviderAxisInvalid(_)
            | DriverError::Unanswered(_)
            | DriverError::SteerTurnEnded(_)
            | DriverError::RunRefused(_)
            | DriverError::CapabilityProbe(_)
            | DriverError::RuleNotKept(_)
            | DriverError::SkillNotListed(_)
            | DriverError::NoPersonServerEntry(_)
            | DriverError::SignInFailed(_)
            | DriverError::Internal(_)),
        ) => {
            let failure = read_failure(&provider_name, failure);
            Some(failed(provider_name, failure))
        }
    }
}

// What one provider's failed read of its models or modes shows: its refusal's code and the
// provider's words, or `provider.unavailable` for a fault inside the driver, which the service log
// keeps.
fn read_failure(provider: &ProviderId, failed: DriverError) -> ProviderReadFailure {
    match HandlerError::from(failed) {
        HandlerError::Refused(refusal) => ProviderReadFailure {
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
                "a provider's models or modes could not be read"
            );
            ProviderReadFailure {
                code: RefusalCode::ProviderUnavailable.as_str().to_owned(),
                provider_failure_detail: None,
            }
        }
    }
}

// Each installed provider's levels, the session's own provider first and read against its bound
// account and the model the lead runs on now, every other one against this system alone; a
// provider whose bare command name no search found is not installed and is left out, and one whose
// read failed carries its failure.
async fn list_modes(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<ProviderModeListResponse, HandlerError> {
    let drivers = read_drivers_own_first(sources, session_id).await?;
    let reads = drivers.into_iter().map(|(provider, driver, own_lead)| {
        let read = driver.list_modes(match own_lead {
            Some(lead) => ListModesParams {
                session_id: Some(session_id),
                provider_account_id: lead.binding.provider_account_id,
                model: Some(lead.running_model),
            },
            None => ListModesParams {
                session_id: None,
                provider_account_id: None,
                model: None,
            },
        });
        async move { (provider.clone(), read.await) }
    });
    let providers = join_all(reads)
        .await
        .into_iter()
        .filter_map(|(provider_name, read)| {
            provider_outcome(
                provider_name,
                read,
                |provider_name, modes| {
                    ProviderModeReport::Listed(ProviderModesListed {
                        provider_name,
                        modes,
                        failure: None,
                    })
                },
                |provider_name, failure| {
                    ProviderModeReport::Failed(ProviderModesFailed {
                        provider_name,
                        failure,
                        modes: None,
                    })
                },
            )
        })
        .collect();
    Ok(ProviderModeListResponse { providers })
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

// The refusal of a call whose run or agent has no live binding: none was started, or its process
// is gone.
fn no_live_binding(detail: Value) -> DomainError {
    DomainError::new(
        "No live provider binding serves that request",
        RefusalCode::ProviderUnavailable,
    )
    .with_detail(detail)
}

#[cfg(test)]
mod tests;
