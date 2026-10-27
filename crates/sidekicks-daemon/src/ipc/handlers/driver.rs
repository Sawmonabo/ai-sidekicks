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
    ProviderModelList, ProviderModelListResponse, ProviderModelReport, ProviderModelsFailed,
    ProviderModelsListed, ProviderModesFailed, ProviderModesListed, ProviderReadFailure,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::contract::{
    CompactContextParams, DriverError, ListModelsParams, ListProviderCommandsParams,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_session::run::agent::read_lead_binding;
use sidekicks_session::run::live_bindings::{
    AgentBindingResolution, RunBindingResolution, resolve_agent_bindings, resolve_run_binding,
};
use sidekicks_session::run::refusals::RunRefusal;
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
        .filter_map(|(provider_name, read)| {
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

// Each installed provider's modes in the table's order; a provider whose bare command name no
// search found is not installed and is left out, and one whose read failed carries its failure.
async fn list_modes(
    providers: &ProviderRegistry,
) -> Result<ProviderModeListResponse, HandlerError> {
    let reads = providers.drivers().map(|(provider, driver)| {
        let read = driver.list_modes();
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

// The refusal of an agent the session's log names nowhere.
fn agent_not_found(agent_id: &AgentId) -> DomainError {
    DomainError::new(
        "The session holds no such agent",
        RefusalCode::AgentNotFound,
    )
    .with_detail(json!({ "agentId": agent_id }))
}

#[cfg(test)]
mod tests {
    //! The driver methods over a test database holding one session and the table's first two
    //! providers, each answered by a stand-in driver: one provider's failed models and modes beside
    //! the other's, the session's own provider listed first, and every binding admitted before any
    //! command list is read.

    use std::io;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use rstest::rstest;
    use rusqlite::params;
    use serde_json::json;
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
    use sidekicks_contracts::provider::driver::methods::{
        ProviderCommandListRequest, ProviderModeReport, ProviderModelReport, ProviderModelsFailed,
        ProviderModelsListed, ProviderModesFailed, ProviderModesListed, ProviderReadFailure,
    };
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use sidekicks_provider::driver::contract::{
        DriverError, ListModelsParams, MockProviderDriver, ProviderDriver,
    };
    use sidekicks_provider::driver::error_causes::ExecutableUnresolvable;
    use sidekicks_provider::driver::test_registry::registry_of_first_providers;
    use sidekicks_session::run::engine::test_fixture::insert_running_run;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};

    use super::{
        DRIVER_METHODS_STATEMENT_CAPACITY, DriverMethodSources, list_models, list_modes,
        list_provider_commands,
    };
    use crate::daemon::schema::schema_parts;

    /// The instant the tests' events carry.
    const AT: &str = "2026-10-19T12:00:00.000Z";

    /// A session the daemon holds, and the drivers' registry.
    struct Fixture {
        database: TestDatabase,
        sources: DriverMethodSources,
        session_id: SessionId,
    }

    fn fixture(drivers: Vec<MockProviderDriver>) -> Fixture {
        let database = TestDatabase::new(schema_parts());
        let schema = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        insert_session_row(&schema, session_id.text().as_str(), None, None);
        let drivers = drivers
            .into_iter()
            .map(|driver| Arc::new(driver) as Arc<dyn ProviderDriver>)
            .collect();
        let sources = DriverMethodSources {
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                DRIVER_METHODS_STATEMENT_CAPACITY,
            )),
            providers: Arc::new(registry_of_first_providers(drivers)),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        };
        Fixture {
            database,
            sources,
            session_id,
        }
    }

    fn provider(index: usize) -> ProviderId {
        ProviderId::new(PROVIDERS[index].id.to_owned()).expect("a table id")
    }

    fn model(id: &str) -> ProviderModel {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "capabilities": [],
            "fast": false,
            "largerWindow": false,
        }))
        .expect("the test's model reads")
    }

    /// How the second provider's reads of its models and modes end.
    #[derive(Clone, Copy, Debug)]
    enum SecondRead {
        /// The provider refused them, saying why.
        Fails,
        /// The provider's bare command name names no build: it is not installed.
        NotInstalled,
        /// Nothing runnable sits at the command path the person typed.
        TypedPathNotRunnable,
    }

    impl SecondRead {
        /// What the second provider's driver answers each read.
        fn error(self) -> DriverError {
            match self {
                Self::Fails => DriverError::Refused(
                    DomainError::new("the provider did not answer", RefusalCode::ProviderTimeout)
                        .with_detail(json!({ "providerFailureDetail": "provider down" })),
                ),
                Self::NotInstalled => DriverError::ExecutableUnresolvable(ExecutableUnresolvable {
                    provider: provider(1),
                    requested_command: "missing".to_owned(),
                    is_typed_path: false,
                    is_build_found: false,
                    cause: io::Error::from(io::ErrorKind::NotFound),
                }),
                Self::TypedPathNotRunnable => {
                    DriverError::ExecutableUnresolvable(ExecutableUnresolvable {
                        provider: provider(1),
                        requested_command: "/opt/provider/missing".to_owned(),
                        is_typed_path: true,
                        is_build_found: false,
                        cause: io::Error::from(io::ErrorKind::NotFound),
                    })
                }
            }
        }

        /// The failure the second provider's heading shows, `None` where it is left out.
        fn failure(self) -> Option<ProviderReadFailure> {
            match self {
                Self::Fails => Some(ProviderReadFailure {
                    code: RefusalCode::ProviderTimeout.as_str().to_owned(),
                    provider_failure_detail: Some(
                        FreeFormText::new("provider down".to_owned()).expect("the detail is text"),
                    ),
                }),
                Self::NotInstalled => None,
                Self::TypedPathNotRunnable => Some(ProviderReadFailure {
                    code: RefusalCode::ProviderCommandPathNotRunnable
                        .as_str()
                        .to_owned(),
                    provider_failure_detail: None,
                }),
            }
        }
    }

    fn mode(id: &str) -> ProviderMode {
        ProviderMode {
            id: FreeFormText::new(id.to_owned()).expect("a mode id"),
            name: FreeFormText::new(id.to_owned()).expect("a mode name"),
        }
    }

    // One provider's failed read of its models, and of its modes, shows under its own heading as its
    // failure while the other's still list, a typed command path with nothing runnable at it among the
    // failures, and a provider that is not installed is left out of both. Killed by failing a whole
    // list on one provider's failure, by listing a provider that is not installed, or by leaving out a
    // typed path that does not run.
    #[rstest]
    #[case::fails(SecondRead::Fails)]
    #[case::not_installed(SecondRead::NotInstalled)]
    #[case::typed_path_not_runnable(SecondRead::TypedPathNotRunnable)]
    #[tokio::test]
    async fn one_providers_failed_read_never_hides_the_others(#[case] second: SecondRead) {
        let mut first = MockProviderDriver::new();
        first
            .expect_list_models()
            .times(1)
            .returning(|_| async { Ok(vec![model("model-a")]) }.boxed());
        first
            .expect_list_modes()
            .times(1)
            .returning(|| async { Ok(vec![mode("mode-a")]) }.boxed());
        let mut failing = MockProviderDriver::new();
        failing.expect_list_models().times(1).returning(move |_| {
            let failed = second.error();
            async move { Err(failed) }.boxed()
        });
        failing.expect_list_modes().times(1).returning(move || {
            let failed = second.error();
            async move { Err(failed) }.boxed()
        });
        let fixture = fixture(vec![first, failing]);

        let models = list_models(&fixture.sources, fixture.session_id)
            .await
            .expect("the model list answers");
        let modes = list_modes(&fixture.sources.providers)
            .await
            .expect("the mode list answers");

        let mut expected_models = vec![ProviderModelReport::Listed(ProviderModelsListed {
            provider_name: provider(0),
            models: vec![model("model-a")],
            failure: None,
        })];
        let mut expected_modes = vec![ProviderModeReport::Listed(ProviderModesListed {
            provider_name: provider(0),
            modes: vec![mode("mode-a")],
            failure: None,
        })];
        if let Some(failure) = second.failure() {
            expected_models.push(ProviderModelReport::Failed(ProviderModelsFailed {
                provider_name: provider(1),
                failure: failure.clone(),
                models: None,
            }));
            expected_modes.push(ProviderModeReport::Failed(ProviderModesFailed {
                provider_name: provider(1),
                failure,
                modes: None,
            }));
        }
        assert_eq!(models.providers, expected_models);
        assert_eq!(modes.providers, expected_modes);
    }

    // The session's own provider lists first, read against the session and its bound account, while
    // every other provider reads its default account with no session, in the table's order. Killed by
    // keeping the table's order, or by passing the session or the account to another provider.
    #[tokio::test]
    async fn the_sessions_own_provider_lists_first_on_its_own_account() {
        let reads: Arc<Mutex<Vec<(usize, ListModelsParams)>>> = Arc::default();
        let drivers = (0..2)
            .map(|index| {
                let reads = Arc::clone(&reads);
                let mut driver = MockProviderDriver::new();
                driver
                    .expect_list_models()
                    .times(1)
                    .returning(move |params| {
                        reads
                            .lock()
                            .expect("the reads are not poisoned")
                            .push((index, params));
                        async move { Ok(vec![model(&format!("model-{index}"))]) }.boxed()
                    });
                driver
            })
            .collect();
        let fixture = fixture(drivers);
        let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
                 VALUES (?1, ?2, 0, ?3, 0, 'sessionLifecycle', 'session.created', ?4)",
                params![
                    mint_uuid_v7().to_string(),
                    fixture.session_id.text().as_str(),
                    AT,
                    json!({
                        "mainAgent": {
                            "agentId": mint_uuid_v7().to_string(),
                            "binding": {
                                "providerName": PROVIDERS[1].id,
                                "providerAccountId": account,
                            },
                        },
                    })
                    .to_string(),
                ],
            )
            .expect("the test creates the session's lead");

        let listed = list_models(&fixture.sources, fixture.session_id)
            .await
            .expect("the list answers");

        let names: Vec<ProviderId> = listed
            .providers
            .iter()
            .map(|report| match report {
                ProviderModelReport::Listed(listed) => listed.provider_name.clone(),
                ProviderModelReport::Failed(failed) => failed.provider_name.clone(),
            })
            .collect();
        assert_eq!(names, [provider(1), provider(0)]);
        let mut reads = reads.lock().expect("the reads are not poisoned").clone();
        reads.sort_by_key(|(index, _)| *index);
        assert_eq!(
            reads,
            [
                (
                    0,
                    ListModelsParams {
                        session_id: None,
                        provider_account_id: None,
                    }
                ),
                (
                    1,
                    ListModelsParams {
                        session_id: Some(fixture.session_id),
                        provider_account_id: Some(account),
                    }
                ),
            ]
        );
    }

    // An agent live on two bindings, the second's driver without the command list, is refused at the
    // gate before any list is read. Killed by reading each binding as it is admitted.
    #[tokio::test]
    async fn every_binding_is_admitted_before_any_command_list_is_read() {
        let mut first = MockProviderDriver::new();
        first.expect_list_provider_commands().times(0);
        let mut second = MockProviderDriver::new();
        second.expect_list_provider_commands().times(0);
        let fixture = fixture(vec![first, second]);
        let agent_id =
            AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
        for index in 0..2 {
            live_run_of_agent(&fixture, &agent_id, index);
        }
        fixture
            .sources
            .providers
            .record_capabilities(
                &provider(0),
                DriverCapabilities {
                    flags: DriverCapabilityFlags::from_fn(|flag| {
                        flag == DriverCapabilityFlag::ProviderCommands
                    }),
                    contract_version: FreeFormText::new("1".to_owned()).expect("valid text"),
                },
            )
            .expect("the first provider is registered");

        let listed = list_provider_commands(
            &fixture.sources,
            ProviderCommandListRequest {
                session_id: fixture.session_id,
                agent_id,
            },
        )
        .await;

        let Err(HandlerError::Refused(refusal)) = listed else {
            panic!("the second binding is refused, got {listed:?}");
        };
        assert_eq!(refusal.code, RefusalCode::ProviderCapabilityUnsupported);
    }

    // Writes a live run of `agent_id`, queued for it, bound to the table's provider at `index`.
    fn live_run_of_agent(fixture: &Fixture, agent_id: &AgentId, index: usize) {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&fixture.database, fixture.session_id, run_id);
        let connection = fixture.database.reader();
        connection
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload,
                    run_id)
                 VALUES (?1, ?2, ?3, ?4, 0, 'runLifecycle', 'agent.run.queued', ?5, ?6)",
                params![
                    mint_uuid_v7().to_string(),
                    fixture.session_id.text().as_str(),
                    i64::try_from(index).expect("a small index"),
                    AT,
                    json!({ "agentId": agent_id }).to_string(),
                    run_id.text().as_str(),
                ],
            )
            .expect("the test queues the run");
        connection
            .execute(
                "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
                   cli_version_raw, spawn_config, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '1.0.0', '1.0.0', ?4, '', '')",
                params![
                    format!("binding-{index}"),
                    run_id.text().as_str(),
                    PROVIDERS[index].id,
                    json!({ "resolvedExecutablePath": "/bin/provider" }).to_string(),
                ],
            )
            .expect("the test binds the run");
    }
}
