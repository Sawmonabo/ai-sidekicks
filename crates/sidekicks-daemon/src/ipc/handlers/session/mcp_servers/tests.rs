//! The session's server list, its switch and its resources' gate.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerStatus::{Connected, Failed, Unknown};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    McpResourceListRequest, SessionMcpServer, SessionMcpServerEnabledUpdateRequest,
    SessionMcpServerList,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::feed::{CreditGate, Feed};
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::client::McpClient;
use sidekicks_mcp::status::normalizer::{McpSessionAttribution, open_mcp_leg_status_producer};
use sidekicks_mcp::status::open_test_tracker;
use sidekicks_platforms::Spawner;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::mcp_server::resources::McpResourceSource;
use sidekicks_provider::driver::mcp_server::session_switch::McpSessionSwitch;
use sidekicks_provider::driver::mcp_server::status::{
    McpServerReading, McpServerStatusEmission, McpServerStatusProducer,
};
use sidekicks_provider::driver::session_control::SessionToolServer;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
use sidekicks_provider::runtime_binding::test_store::{open_store, resumable_binding_input};
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, test_run_id, test_session_id,
};
use sidekicks_store::events::session::followers::SessionEventFollowers;

use super::{
    McpServerMethods, SessionMcpSwitches, follow_session_servers, list_resources,
    switch_session_server,
};
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::schema::schema_parts;
use crate::ipc::handlers::driver::{DRIVER_METHODS_STATEMENT_CAPACITY, DriverMethodSources};

// A session on the first provider over the driver `driver` builds on the session's binding
// store, whose stored leg holds its `tracker` server on and whose one live leg reads it as
// `reading`; the producer is kept, since dropping it retires the leg.
struct Fixture {
    _database: TestDatabase,
    _leg: McpServerStatusProducer,
    methods: Arc<McpServerMethods>,
    session_id: SessionId,
    server_name: McpServerName,
    binding: McpServerBindingRef,
    run_id: RunId,
}

async fn session_reading(
    driver: impl FnOnce(Arc<RuntimeBindingStore>) -> MockProviderDriver,
    reading: McpServerReading,
) -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let schema = database.opener()().expect("the test creates its database");
    let session_id = test_session_id();
    insert_session_row(&schema, session_id.text().as_str(), None, None);
    insert_lead(&database, session_id, PROVIDERS[0].id);
    let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
    let server_name = McpServerName::new("tracker".to_owned()).expect("a server name");
    let binding = McpServerBindingRef::User {
        provider: provider.clone(),
        server_name: server_name.clone(),
    };
    let tool_servers = vec![SessionToolServer {
        binding: binding.clone(),
        is_enabled: true,
    }];
    let run_id = test_run_id();
    schema
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'completed', 1)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the session's run is stored");
    let bindings = Arc::new(open_store(&database).await);
    let mut leg_input = resumable_binding_input(run_id, provider.clone());
    leg_input.spawn_config.tool_servers = Some(tool_servers.clone());
    bindings
        .create(leg_input)
        .await
        .expect("the session's leg is stored");
    let (statuses, _subscriber, _first_observations) = open_test_tracker().await;
    let attribution = McpSessionAttribution::new(
        Arc::new(McpAttributionTable::default()),
        provider,
        None,
        &tool_servers,
    )
    .expect("a session in no root attributes");
    let leg = open_mcp_leg_status_producer(
        &statuses,
        attribution,
        session_id,
        RuntimeBindingId::new("leg-a".to_owned()).expect("a binding id"),
    );
    leg.report_status(McpServerStatusEmission::new(
        server_name.clone(),
        reading,
        None,
        None,
    ));
    let methods = Arc::new(McpServerMethods {
        sources: Arc::new(DriverMethodSources {
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                DRIVER_METHODS_STATEMENT_CAPACITY,
            )),
            providers: Arc::new(registry_of_first_provider(Arc::new(driver(bindings)))),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        }),
        statuses,
        client: Arc::new(
            McpClient::new(
                Arc::new(PortRegistration::new("questions")),
                this_build_release_version(),
            )
            .expect("the client builds"),
        ),
        spawner: Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts"),
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(&[])),
        followers: Arc::new(SessionEventFollowers::default()),
    });
    Fixture {
        _database: database,
        _leg: leg,
        methods,
        session_id,
        server_name,
        binding,
        run_id,
    }
}

fn refusal_of(answer: Result<impl std::fmt::Debug, HandlerError>) -> (RefusalCode, String) {
    let Err(HandlerError::Refused(refusal)) = answer else {
        panic!("the list is refused: {answer:?}");
    };
    (refusal.code, refusal.message)
}

// A server whose sign-in the provider holds is refused as not running, its message naming the
// sign-in, and nothing is reached. Killed by the arm answering an empty list or reaching the
// server, and by the arm refused as unavailable.
#[tokio::test]
async fn a_server_signed_in_by_its_provider_is_refused_without_a_reach() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_list_mcp_resources()
        .times(1)
        .returning(|_, _| Box::pin(async { Ok(McpResourceSource::SignedInByProvider) }));
    let fixture = session_reading(|_| driver, McpServerReading::Observed(Connected)).await;

    let answer = list_resources(
        &fixture.methods,
        McpResourceListRequest {
            session_id: fixture.session_id,
            server_name: fixture.server_name.clone(),
        },
    )
    .await;

    let (code, message) = refusal_of(answer);
    assert_eq!(code, RefusalCode::McpServerNotRunning);
    assert!(
        message.contains("sign-in"),
        "the refusal names the sign-in: {message}"
    );
}

// A server the session's leg reads as failed is refused as not running before the driver is
// asked. Killed by the status gate removed or moved after the driver's call.
#[tokio::test]
async fn a_server_the_session_does_not_read_as_working_is_refused_before_the_driver() {
    let mut driver = MockProviderDriver::new();
    driver.expect_list_mcp_resources().never();
    let fixture = session_reading(|_| driver, McpServerReading::Observed(Failed)).await;

    let answer = list_resources(
        &fixture.methods,
        McpResourceListRequest {
            session_id: fixture.session_id,
            server_name: fixture.server_name.clone(),
        },
    )
    .await;

    assert_eq!(refusal_of(answer).0, RefusalCode::McpServerNotRunning);
}

// With a feed open, switching `tracker` off calls the driver once with the whole set, `tracker`
// off, and the stored leg's run; the feed's next list carries `tracker` off and waiting for an
// `AtNextTurn` answer, read from the stored leg the arm wrote; switching it off again calls no
// driver. Killed by a switch kept only in memory, by a feed not sent again, and by the same
// state sent again.
#[tokio::test]
async fn a_switch_is_kept_with_the_session_and_sent_to_its_feed() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&calls);
    let fixture = session_reading(
        move |bindings| {
            let mut driver = MockProviderDriver::new();
            driver
                .expect_switch_session_mcp_servers()
                .times(1)
                .returning(move |session_id, run_id, tool_servers| {
                    lock(&recorded).push((session_id, run_id, tool_servers.clone()));
                    let bindings = Arc::clone(&bindings);
                    Box::pin(async move {
                        let is_written = bindings
                            .replace_tool_servers(&run_id, &tool_servers)
                            .await
                            .expect("the arm writes the set");
                        assert!(is_written, "the run's leg holds the set");
                        Ok(McpSessionSwitch::AtNextTurn)
                    })
                });
            driver
        },
        McpServerReading::Observed(Connected),
    )
    .await;
    let switches = SessionMcpSwitches::new(&fixture.methods.followers);
    let mut feed = follow_session_servers(
        Arc::clone(&fixture.methods),
        Arc::clone(&switches),
        fixture.session_id,
    )
    .await
    .expect("the feed opens");
    let gate = CreditGate::with_credit(1);
    let row = |enabled: bool, pending_until_next_turn: bool| SessionMcpServerList {
        session_id: fixture.session_id,
        servers: vec![SessionMcpServer {
            server_name: fixture.server_name.clone(),
            status: Connected,
            reason: None,
            enabled,
            pending_until_next_turn,
        }],
    };
    let first = feed.next(&gate).await.expect("the feed reads");
    assert_eq!(first, Some(row(true, false)));
    let switch_off = || SessionMcpServerEnabledUpdateRequest {
        session_id: fixture.session_id,
        server_name: fixture.server_name.clone(),
        enabled: false,
    };

    let switched = switch_session_server(&fixture.methods, &switches, switch_off())
        .await
        .expect("the switch is made");

    assert!(!switched.enabled);
    let off = vec![SessionToolServer {
        binding: fixture.binding.clone(),
        is_enabled: false,
    }];
    assert_eq!(
        *lock(&calls),
        vec![(fixture.session_id, fixture.run_id, off)],
        "the driver gets the whole set and the stored leg's run once"
    );
    // Bounded, so a feed that is not sent again fails here rather than at the runner's limit.
    let sent = tokio::time::timeout(Duration::from_secs(5), feed.next(&gate))
        .await
        .expect("the feed sends again after the switch")
        .expect("the feed reads");
    assert_eq!(sent, Some(row(false, true)));
    switch_session_server(&fixture.methods, &switches, switch_off())
        .await
        .expect("the same state answers as it stands");
    assert_eq!(lock(&calls).len(), 1, "the same state calls no driver");
}

// A server the provider switched off for the session's one leg lists off, its status unknown and
// nothing waiting, both before a switch waits and while one does. Killed by the reader leaving a
// switched-off server out or the row reading the session's switch alone (it lists on), and by a
// leg's switch-off read as the server running (it lists waiting once a switch waits).
#[tokio::test]
async fn a_server_the_provider_switched_off_lists_off_with_nothing_waiting() {
    let fixture =
        session_reading(|_| MockProviderDriver::new(), McpServerReading::SwitchedOff).await;
    let switches = SessionMcpSwitches::new(&fixture.methods.followers);
    let mut feed = follow_session_servers(
        Arc::clone(&fixture.methods),
        Arc::clone(&switches),
        fixture.session_id,
    )
    .await
    .expect("the feed opens");
    let gate = CreditGate::with_credit(1);
    let off = Some(SessionMcpServerList {
        session_id: fixture.session_id,
        servers: vec![SessionMcpServer {
            server_name: fixture.server_name.clone(),
            status: Unknown,
            reason: None,
            enabled: false,
            pending_until_next_turn: false,
        }],
    });

    let first = feed.next(&gate).await.expect("the feed reads");
    switches.note_switched(fixture.session_id, Some(McpSessionSwitch::AtNextTurn));
    // Bounded, so a feed that is not sent again fails here rather than at the runner's limit.
    let waiting = tokio::time::timeout(Duration::from_secs(5), feed.next(&gate))
        .await
        .expect("the feed sends again after the switch")
        .expect("the feed reads");

    assert_eq!(first, off, "the provider's switch-off lists the server off");
    assert_eq!(
        waiting, off,
        "a waiting switch leaves the server off and not waiting"
    );
}
