use std::sync::OnceLock;
use std::time::Duration;

use futures::future::ready;
use serde_json::{Value, json};
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::governance::{
    McpServerList, McpServerRead, McpServerStatusChangedNotice,
};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef};
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::registry::{Dispatch as _, DispatchError, EncodedFeed, Reply};
use sidekicks_ipc::stream::feed::CreditGate;
use sidekicks_mcp::binding::resolver::McpAttributionTable;
use sidekicks_mcp::binding::store::{McpBindingStore, open_first_observation_drain};
use sidekicks_mcp::inventory_service::McpInventorySources;
use sidekicks_mcp::status::McpServerStatusTracker;
use sidekicks_mcp::status::machine_probe::McpMachineProbeGate;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::mcp_server::read::{
    McpAccountServers, McpServerDeclaration, McpServerPolicy, McpServerToolDefaults,
    ProviderMcpServersReading,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_session::directory::run_activity::ProjectSessionActivityReader;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope};
use sidekicks_store::events::log_service::EventLogAppendOptions;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_workspace::project::records::ProjectRecords;

use super::*;
use crate::daemon::schema::schema_parts;

/// The statements the inventory's read connections keep prepared: the binding store's, the
/// accounts' and the attached roots'.
const INVENTORY_READ_STATEMENT_CAPACITY: usize = 8;

/// Long enough for a frame that is coming to come, many windows over.
const QUIET: Duration = Duration::from_millis(250);

/// How long a read the test expects waits before the test fails instead of hanging.
const READ_BOUND: Duration = Duration::from_secs(10);

/// Appends a finished sign-in to `server_name` to the sentinel session's log.
async fn sign_in_completed(log: &EventLogService, server_name: &str) {
    let completed = serde_json::from_value(json!({
        "type": "mcp.server.signIn.completed",
        "payload": {
            "provider": "provider-a",
            "scope": "user",
            "serverName": server_name,
            "outcome": "success",
        },
    }))
    .expect("the test writes an mcp.server.signIn.completed event");
    log.append(
        test_envelope(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &completed),
        EventLogAppendOptions::default(),
    )
    .await
    .expect("the append commits");
}

/// The `mcp.*` methods over `log`, `board` and an inventory of `providers` on `database`.
async fn mcp_methods_over(
    database: &TestDatabase,
    log: &TestLog,
    board: &Arc<McpNoticeBoard>,
    providers: ProviderRegistry,
) -> MethodRegistryBuilder {
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        INVENTORY_READ_STATEMENT_CAPACITY,
    ));
    let store = McpBindingStore::new(Arc::clone(&log.writer), Arc::clone(&reads));
    let (first_observations, drain) = open_first_observation_drain(store.clone()).await;
    // The drain records each binding the tracker observes; it ends when the tracker drops.
    tokio::spawn(drain);
    let inventory = Arc::new(McpInventoryService::new(McpInventorySources {
        providers: Arc::new(providers),
        reads: Arc::clone(&reads),
        meter: ProcessorMeter::default(),
        projects: Arc::new(ProjectRecords::new(
            reads,
            Arc::new(ProjectSessionActivityReader::new(&StoredPlanHolds)),
        )),
        store,
        tracker: Arc::new(McpServerStatusTracker::new(
            Arc::clone(board),
            first_observations,
        )),
        attribution: Arc::new(McpAttributionTable::default()),
        probe_gate: Arc::new(McpMachineProbeGate::default()),
    }));
    let mut builder = MethodRegistryBuilder::new();
    register_mcp_methods(
        &mut builder,
        McpMethodSources {
            log: Arc::clone(&log.service),
            board: Arc::clone(board),
            inventory,
        },
    )
    .expect("the methods register");
    builder
}

/// The next emission, as JSON; fails the test when none comes within `READ_BOUND`.
async fn next_json(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Value {
    let value = tokio::time::timeout(READ_BOUND, feed.next(gate))
        .await
        .expect("an emission comes in time")
        .expect("the stream reads")
        .expect("the stream goes on");
    serde_json::from_slice(&value.json).expect("the emission is JSON")
}

// A notice sent the moment the acknowledgment is in hand, before any read of the stream, is read,
// so nothing falls between the subscribe call and a first list; the log is followed from its head.
#[tokio::test]
async fn the_stream_reads_what_is_sent_after_the_acknowledgment_and_nothing_stored_before() {
    let database = TestDatabase::new(schema_parts());
    let test_log = open_log(&database, None).await;
    let log = Arc::clone(&test_log.service);
    sign_in_completed(&log, "before").await;
    let board = Arc::new(McpNoticeBoard::default());
    let builder = mcp_methods_over(
        &database,
        &test_log,
        &board,
        registry_of_first_provider(Arc::new(MockProviderDriver::new())),
    )
    .await;
    let reply = builder
        .freeze()
        .dispatch(
            request(McpSubscribe::DESCRIPTOR.method, Some(&json!({}))),
            context(1),
        )
        .await;
    let Ok(Reply::Subscription { mut feed, .. }) = reply else {
        panic!("mcp.subscribe answers a subscription");
    };

    let binding: McpServerBindingRef = serde_json::from_value(json!({
        "provider": "provider-a",
        "scope": "user",
        "serverName": "github",
    }))
    .expect("the test writes a binding ref");
    let notice: McpServerStatusChangedNotice = serde_json::from_value(json!({
        "type": "mcp.server.status.changed",
        "origin": "machineProbe",
        "provider": "provider-a",
        "scope": "user",
        "serverName": "github",
        "serverBindingId": "0".repeat(64),
        "previousStatus": "unknown",
        "status": "connected",
    }))
    .expect("the test writes a probe notice");
    board.send_probe_notice(&binding, notice.clone());
    let gate = CreditGate::with_credit(1);
    assert_eq!(
        next_json(&mut feed, &gate).await,
        serde_json::to_value(&notice).expect("the notice is JSON")
    );

    sign_in_completed(&log, "after").await;
    let event = next_json(&mut feed, &gate).await;
    assert_eq!(event["type"], "mcp.server.signIn.completed");
    assert_eq!(event["payload"]["serverName"], "after");
    assert!(
        tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
        "the event stored before the call is not read"
    );
}

/// A declaration the driver reads of `binding`, switched off by the provider's own list at
/// `switched_off_at`, its switch kept in the store.
fn declaration_of(
    binding: McpServerBindingRef,
    switched_off_at: &PlacedPath,
) -> McpServerDeclaration {
    McpServerDeclaration {
        binding,
        config: McpServerConfigView::Stdio {
            command: "server".to_owned(),
            args: None,
            env_var_names: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        superseded_in: Vec::new(),
        disabled_in: vec![McpOverrideOrigin::Placed(switched_off_at.clone())],
        is_read_only: false,
        sign_in_client: None,
        is_switch_kept_by_daemon: true,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Prompt),
        organization_managed: None,
    }
}

/// The binding of `scope` named `server_name` under `scope_ref` for `provider`.
fn binding_of(provider: &ProviderId, scope: &str, scope_ref: &str, server_name: &str) -> Value {
    json!({
        "provider": provider.as_str(),
        "scope": scope,
        "scopeRef": scope_ref,
        "serverName": server_name,
    })
}

// With the binding store failing, every row reads the store-unavailable arm: no tools and no
// store-held switch, and no `disabledIn` on a connector, whose per-project switch lives in the
// store, while a project-local row keeps the driver's roots; a binding no provider declares is
// refused as not found. Killed by an empty or false fill, by a default answered entry, and by a
// connector's `disabledIn` taken from the driver alone.
#[tokio::test]
async fn with_the_store_failing_the_list_leaves_out_what_the_store_holds_and_an_unknown_binding_is_not_found()
 {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    // The bindings' table gone, every read of the store fails; the tables that reference it hold
    // no row, so the drop's implicit delete breaks no foreign key.
    database
        .reader()
        .execute_batch("DROP TABLE mcp_server_bindings")
        .expect("the bindings' table is dropped");
    let switched_off_at = PlacedPath {
        path: FilesystemPath::new("/work/other".to_owned()).expect("a path"),
        place: None,
    };
    let provider_of_registry: Arc<OnceLock<ProviderId>> = Arc::new(OnceLock::new());
    let provider_of_driver = Arc::clone(&provider_of_registry);
    let driver_switched_off_at = switched_off_at.clone();
    let mut driver = MockProviderDriver::new();
    driver.expect_read_mcp_servers().returning(move |_request| {
        let provider = provider_of_driver
            .get()
            .expect("the registry names the provider");
        let local: McpServerBindingRef =
            serde_json::from_value(binding_of(provider, "local", "/work/app", "notes"))
                .expect("a local binding");
        let connector: McpServerBindingRef =
            serde_json::from_value(binding_of(provider, "connector", "account-1", "slack"))
                .expect("a connector binding");
        ready(Ok(ProviderMcpServersReading {
            declarations: vec![declaration_of(local, &driver_switched_off_at)],
            roots: Vec::new(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: vec![McpAccountServers {
                provider_account_id: ProviderAccountId::new("account-1".to_owned())
                    .expect("an account id"),
                declarations: vec![McpServerDeclaration {
                    is_read_only: true,
                    ..declaration_of(connector, &driver_switched_off_at)
                }],
            }],
            probe_readings: Vec::new(),
        }))
        .boxed()
    });
    let providers = registry_of_first_provider(Arc::new(driver));
    let (provider, _driver) = providers.drivers().next().expect("one provider");
    let provider = provider.clone();
    provider_of_registry
        .set(provider.clone())
        .expect("the provider is named once");
    let board = Arc::new(McpNoticeBoard::default());
    let methods = mcp_methods_over(&database, &log, &board, providers)
        .await
        .freeze();

    let list = methods
        .dispatch(
            request(McpServerList::DESCRIPTOR.method, Some(&json!({}))),
            context(1),
        )
        .await;
    let unknown = methods
        .dispatch(
            request(
                McpServerRead::DESCRIPTOR.method,
                Some(&json!({
                    "provider": provider.as_str(),
                    "scope": "user",
                    "serverName": "missing",
                })),
            ),
            context(1),
        )
        .await;

    let Ok(Reply::Result(list)) = list else {
        panic!("mcp.server.list answers a result");
    };
    let list: Value = serde_json::from_slice(&list.json).expect("the result is JSON");
    let entry_of = |scope: &str| {
        list["servers"]
            .as_array()
            .expect("the list holds servers")
            .iter()
            .find(|entry| entry["scope"] == scope)
            .unwrap_or_else(|| panic!("the {scope} row is listed"))
            .clone()
    };
    for scope in ["local", "connector"] {
        let entry = entry_of(scope);
        assert_eq!(entry["bindingStoreUnavailable"], true, "{scope}");
        assert!(entry.get("tools").is_none(), "{scope}");
        assert!(entry.get("enabled").is_none(), "{scope}");
    }
    assert!(entry_of("connector").get("disabledIn").is_none());
    assert_eq!(
        entry_of("local")["disabledIn"],
        json!([serde_json::to_value(&switched_off_at).expect("a path is JSON")])
    );
    let Err(DispatchError::Refused(refusal)) = unknown else {
        panic!("mcp.server.read of an unknown binding is refused");
    };
    assert_eq!(refusal.code, RefusalCode::McpServerNotFound);
}
