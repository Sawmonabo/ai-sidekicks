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
use sidekicks_contracts::agent::definition::binding::ProviderToken;
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
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::{ListModelsParams, ListModesParams};
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
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
            Self::Fails => DriverError::from(
                DomainError::new("the provider did not answer", RefusalCode::ProviderTimeout)
                    .with_detail(json!({ "providerFailureDetail": "provider down" })),
            ),
            Self::NotInstalled => DriverError::from(ExecutableUnresolvable {
                provider: provider(1),
                requested_command: "missing".to_owned(),
                is_typed_path: false,
                is_build_found: false,
                cause: io::Error::from(io::ErrorKind::NotFound),
            }),
            Self::TypedPathNotRunnable => DriverError::from(ExecutableUnresolvable {
                provider: provider(1),
                requested_command: "/opt/provider/missing".to_owned(),
                is_typed_path: true,
                is_build_found: false,
                cause: io::Error::from(io::ErrorKind::NotFound),
            }),
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

// One provider's failed read of its models, and of its modes, shows under its own heading as
// its failure while the other's still list, a typed command path with nothing runnable at it
// among the failures, and a provider that is not installed is left out of both. Killed by
// failing a whole list on one provider's failure, by listing a provider that is not installed,
// or by leaving out a typed path that does not run.
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
        .returning(|_| async { Ok(vec![mode("mode-a")]) }.boxed());
    let mut failing = MockProviderDriver::new();
    failing.expect_list_models().times(1).returning(move |_| {
        let failed = second.error();
        async move { Err(failed) }.boxed()
    });
    failing.expect_list_modes().times(1).returning(move |_| {
        let failed = second.error();
        async move { Err(failed) }.boxed()
    });
    let fixture = fixture(vec![first, failing]);

    let models = list_models(&fixture.sources, fixture.session_id)
        .await
        .expect("the model list answers");
    let modes = list_modes(&fixture.sources, fixture.session_id)
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

// The session's own provider lists first, its models read against the session and its bound
// account and its levels against those and the model the lead runs, while every other
// provider reads its default account with no session or model, in the table's order. Killed
// by keeping the table's order, by passing the session, the account or the model to another
// provider, and by reading the own provider's levels with no account or model.
#[tokio::test]
async fn the_sessions_own_provider_lists_first_on_its_own_account() {
    let reads: Arc<Mutex<Vec<(usize, ListModelsParams)>>> = Arc::default();
    let mode_reads: Arc<Mutex<Vec<(usize, ListModesParams)>>> = Arc::default();
    let drivers = (0..2)
        .map(|index| {
            let reads = Arc::clone(&reads);
            let mode_reads = Arc::clone(&mode_reads);
            let mut driver = MockProviderDriver::new();
            driver
                .expect_list_modes()
                .times(1)
                .returning(move |params| {
                    mode_reads
                        .lock()
                        .expect("the reads are not poisoned")
                        .push((index, params));
                    async move { Ok(vec![mode(&format!("mode-{index}"))]) }.boxed()
                });
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
                            "modelId": "model-1",
                            "effort": null,
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
                    provider_account_id: Some(account.clone()),
                }
            ),
        ]
    );

    let listed = list_modes(&fixture.sources, fixture.session_id)
        .await
        .expect("the list answers");

    let names: Vec<ProviderId> = listed
        .providers
        .iter()
        .map(|report| match report {
            ProviderModeReport::Listed(listed) => listed.provider_name.clone(),
            ProviderModeReport::Failed(failed) => failed.provider_name.clone(),
        })
        .collect();
    assert_eq!(names, [provider(1), provider(0)]);
    let mut mode_reads = mode_reads
        .lock()
        .expect("the reads are not poisoned")
        .clone();
    mode_reads.sort_by_key(|(index, _)| *index);
    assert_eq!(
        mode_reads,
        [
            (
                0,
                ListModesParams {
                    session_id: None,
                    provider_account_id: None,
                    model: None,
                }
            ),
            (
                1,
                ListModesParams {
                    session_id: Some(fixture.session_id),
                    provider_account_id: Some(account),
                    model: Some(ProviderToken::new("model-1".to_owned()).expect("a model")),
                }
            ),
        ]
    );
}

// An agent live on two bindings, the second's driver without the command list, is refused at
// the gate before any list is read. Killed by reading each binding as it is admitted.
#[tokio::test]
async fn every_binding_is_admitted_before_any_command_list_is_read() {
    let mut first = MockProviderDriver::new();
    first.expect_list_provider_commands().times(0);
    let mut second = MockProviderDriver::new();
    second.expect_list_provider_commands().times(0);
    let fixture = fixture(vec![first, second]);
    let agent_id = AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
    for index in 0..2 {
        live_run_of_agent(&fixture, &agent_id, index);
    }
    for (index, offers_commands) in [(0, true), (1, false)] {
        fixture
            .sources
            .providers
            .record_capabilities(
                &provider(index),
                DriverCapabilities {
                    flags: DriverCapabilityFlags::from_fn(|flag| {
                        offers_commands && flag == DriverCapabilityFlag::ProviderCommands
                    }),
                    contract_version: FreeFormText::new("1".to_owned()).expect("valid text"),
                },
            )
            .expect("the provider is registered");
    }

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
                json!({
                    "providerAccountId": "account-1",
                    "resolvedExecutablePath": "/bin/provider"
                })
                .to_string(),
            ],
        )
        .expect("the test binds the run");
}
