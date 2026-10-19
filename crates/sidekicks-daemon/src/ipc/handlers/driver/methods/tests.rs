//! The driver methods over a test database holding one session and the table's first two
//! providers, each answered by a stand-in driver: one provider's failed catalog beside the
//! other's, and every binding admitted before any command list is read.

use std::io;
use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::methods::{
    ProviderCommandListRequest, ProviderModelListFailure, ProviderModelReport,
    ProviderModelsFailed, ProviderModelsListed,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{DriverMethodSources, list_models, list_provider_commands};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use crate::provider::driver::contract::{DriverError, MockProviderDriver, ProviderDriver};
use crate::provider::driver::error_causes::ExecutableUnresolvable;
use crate::provider::driver::test_registry::registry_of_first_providers;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::tests::insert_running_run;
use crate::uuid_v7::mint_uuid_v7;

/// The statements the tests' read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 8;

/// The instant the tests' events carry.
const AT: &str = "2026-10-19T12:00:00.000Z";

/// A session the daemon holds, and the drivers' registry.
struct Fixture {
    database: TestDatabase,
    sources: DriverMethodSources,
    session_id: SessionId,
}

fn fixture(drivers: Vec<MockProviderDriver>) -> Fixture {
    let database = TestDatabase::new();
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
            READ_STATEMENT_CAPACITY,
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

/// How the second provider's catalog read ends.
#[derive(Clone, Copy, Debug)]
enum SecondCatalog {
    /// The provider refused it, saying why.
    Fails,
    /// The provider's bare command name names no build: it is not installed.
    NotInstalled,
    /// Nothing runnable sits at the command path the person typed.
    TypedPathNotRunnable,
}

// One provider's failed catalog read shows under its own heading as its failure while the other's
// models still list, a typed command path with nothing runnable at it among the failures, and a
// provider that is not installed is left out. Killed by failing the whole list on one provider's
// failure, by listing a provider that is not installed, or by leaving out a typed path that does
// not run.
#[rstest]
#[case::fails(SecondCatalog::Fails)]
#[case::not_installed(SecondCatalog::NotInstalled)]
#[case::typed_path_not_runnable(SecondCatalog::TypedPathNotRunnable)]
#[tokio::test]
async fn one_providers_failed_catalog_never_hides_the_others(#[case] second: SecondCatalog) {
    let mut first = MockProviderDriver::new();
    first
        .expect_list_models()
        .times(1)
        .returning(|_| async { Ok(vec![model("model-a")]) }.boxed());
    let mut failing = MockProviderDriver::new();
    failing.expect_list_models().times(1).returning(move |_| {
        let failed = match second {
            SecondCatalog::Fails => DriverError::Refused(
                DomainError::new("the catalog did not answer", RefusalCode::ProviderTimeout)
                    .with_detail(json!({ "providerFailureDetail": "catalog down" })),
            ),
            SecondCatalog::NotInstalled => {
                DriverError::ExecutableUnresolvable(ExecutableUnresolvable {
                    provider: provider(1),
                    requested_command: "missing".to_owned(),
                    is_typed_path: false,
                    cause: io::Error::from(io::ErrorKind::NotFound),
                })
            }
            SecondCatalog::TypedPathNotRunnable => {
                DriverError::ExecutableUnresolvable(ExecutableUnresolvable {
                    provider: provider(1),
                    requested_command: "/opt/provider/missing".to_owned(),
                    is_typed_path: true,
                    cause: io::Error::from(io::ErrorKind::NotFound),
                })
            }
        };
        async move { Err(failed) }.boxed()
    });
    let fixture = fixture(vec![first, failing]);

    let listed = list_models(&fixture.sources, fixture.session_id)
        .await
        .expect("the list answers");

    let mut expected = vec![ProviderModelReport::Listed(ProviderModelsListed {
        provider_name: provider(0),
        models: vec![model("model-a")],
        failure: None,
    })];
    let failure = match second {
        SecondCatalog::Fails => Some(ProviderModelListFailure {
            code: RefusalCode::ProviderTimeout.as_str().to_owned(),
            provider_failure_detail: Some(
                FreeFormText::new("catalog down".to_owned()).expect("the detail is text"),
            ),
        }),
        SecondCatalog::NotInstalled => None,
        SecondCatalog::TypedPathNotRunnable => Some(ProviderModelListFailure {
            code: RefusalCode::ProviderCommandPathNotRunnable
                .as_str()
                .to_owned(),
            provider_failure_detail: None,
        }),
    };
    if let Some(failure) = failure {
        expected.push(ProviderModelReport::Failed(ProviderModelsFailed {
            provider_name: provider(1),
            failure,
            models: None,
        }));
    }
    assert_eq!(listed.providers, expected);
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
    let agent_id = AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id");
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
