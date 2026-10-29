use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, ready};
use rstest::rstest;
use rusqlite::{Connection, params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::{
    McpAnsweredInventoryEntry, McpServerIdempotencyClass, McpServerInventoryEntry, McpToolReading,
    McpToolSetting,
};
use sidekicks_contracts::mcp::server::requests::McpServerListRequest;
use sidekicks_contracts::mcp::server::{
    McpApprovalMode, McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::mcp_server::read::{
    McpProbeReading, McpProbeScope, McpServerDeclaration, McpServerPolicy, McpServerToolDefaults,
    McpServersReadRequest, ProviderMcpServersReading,
};
use sidekicks_provider::driver::mcp_server::status::{McpServerReading, McpServerStatusEmission};
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_workspace::project::records::{
    ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use tokio::sync::oneshot;

use super::{McpInventoryService, McpInventorySources};
use crate::binding::resolver::McpAttributionTable;
use crate::binding::store::{McpBindingKey, McpBindingStore, open_first_observation_drain};
use crate::schema::schema_parts;
use crate::status::McpServerStatusTracker;
use crate::status::machine_probe::McpMachineProbeGate;
use crate::status::notices::McpNoticeBoard;

/// The statements a read connection keeps prepared: the store's, the accounts' and the roots'.
const READ_STATEMENT_CAPACITY: usize = 8;

/// How long a wait the test expects to end lasts before the test fails instead of hanging.
const WAIT_BOUND: Duration = Duration::from_secs(10);

/// No project has a session; the inventory reads only the attached roots.
struct NoProjectSessions;

impl ProjectSessionActivity for NoProjectSessions {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        _project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        Ok(Vec::new())
    }
}

/// What a test's driver answers a read with, given the registry's provider and the request.
type DriverAnswer = Box<
    dyn FnMut(
            ProviderId,
            McpServersReadRequest,
        ) -> BoxFuture<'static, Result<ProviderMcpServersReading, DriverError>>
        + Send,
>;

/// An inventory over one provider whose driver answers through a test's closure, with the real
/// store, tracker, gate and attribution table, and the binding `docs`'s row stored.
struct TestInventory {
    database: TestDatabase,
    provider: ProviderId,
    service: McpInventoryService,
    tracker: Arc<McpServerStatusTracker>,
    gate: Arc<McpMachineProbeGate>,
    /// The probe scope of each read the driver was asked, in order.
    probes: Arc<Mutex<Vec<McpProbeScope>>>,
}

async fn open_inventory(mut answer: DriverAnswer) -> TestInventory {
    let database = TestDatabase::new(schema_parts());
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let store = McpBindingStore::new(writer, Arc::clone(&reads));
    let (outlet, drain) = open_first_observation_drain(store.clone()).await;
    // The drain records each binding the tracker observes; it ends when the tracker drops.
    tokio::spawn(drain);
    let provider_of_registry: Arc<OnceLock<ProviderId>> = Arc::new(OnceLock::new());
    let probes = Arc::new(Mutex::new(Vec::new()));
    let mut driver = MockProviderDriver::new();
    let provider_of_driver = Arc::clone(&provider_of_registry);
    let driver_probes = Arc::clone(&probes);
    driver.expect_read_mcp_servers().returning(move |request| {
        let provider = provider_of_driver
            .get()
            .expect("the registry names the provider")
            .clone();
        lock(&driver_probes).push(request.probe.clone());
        answer(provider, request)
    });
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    let (provider, _driver) = providers.drivers().next().expect("one provider");
    let provider = provider.clone();
    provider_of_registry
        .set(provider.clone())
        .expect("the provider is named once");
    database
        .reader()
        .execute(
            "INSERT INTO mcp_server_bindings
               (provider, scope, server_name, first_observed_at, updated_at)
             VALUES (?1, 'user', 'docs', 't', 't')",
            params![provider.as_str()],
        )
        .expect("the binding's row is stored");
    let tracker = Arc::new(McpServerStatusTracker::new(
        Arc::new(McpNoticeBoard::default()),
        outlet,
    ));
    let gate = Arc::new(McpMachineProbeGate::default());
    let service = McpInventoryService::new(McpInventorySources {
        providers,
        reads: Arc::clone(&reads),
        meter: ProcessorMeter::default(),
        projects: Arc::new(ProjectRecords::new(reads, Arc::new(NoProjectSessions))),
        store,
        tracker: Arc::clone(&tracker),
        attribution: Arc::new(McpAttributionTable::default()),
        probe_gate: Arc::clone(&gate),
    });
    TestInventory {
        database,
        provider,
        service,
        tracker,
        gate,
        probes,
    }
}

fn tool(name: &str) -> McpToolName {
    McpToolName::new(name.to_owned()).expect("a tool name")
}

fn docs_binding(provider: &ProviderId) -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: provider.clone(),
        server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
    }
}

/// The driver's reading: one `user` server, which the probe, where the request asks for one,
/// reads connected with two tools.
fn reading_of(provider: &ProviderId, request: &McpServersReadRequest) -> ProviderMcpServersReading {
    let binding = docs_binding(provider);
    let probe_readings = if request.probe == McpProbeScope::EveryBinding {
        vec![McpProbeReading {
            binding: binding.clone(),
            reading: McpServerReading::Observed(McpServerStatus::Connected),
            failure_text: None,
            tool_names: vec![tool("search"), tool("delete")],
        }]
    } else {
        Vec::new()
    };
    ProviderMcpServersReading {
        declarations: vec![McpServerDeclaration {
            binding,
            config: McpServerConfigView::Stdio {
                command: "docs-server".to_owned(),
                args: None,
                env_var_names: None,
                enabled: None,
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
            },
            superseded_in: Vec::new(),
            disabled_in: Vec::new(),
            is_read_only: false,
            sign_in_client: None,
            is_switch_kept_by_daemon: true,
            tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
            organization_managed: None,
        }],
        roots: Vec::new(),
        is_machine_managed: false,
        server_policy: McpServerPolicy::default(),
        account_servers: Vec::new(),
        probe_readings,
    }
}

/// A driver that answers at once.
fn answering_at_once() -> DriverAnswer {
    Box::new(|provider, request| ready(Ok(reading_of(&provider, &request))).boxed())
}

const REFRESH: McpServerListRequest = McpServerListRequest {
    refresh: Some(true),
};

const PLAIN_LIST: McpServerListRequest = McpServerListRequest { refresh: None };

/// The one entry of a list, as the answered `user` entry's status and tools.
fn docs_entry(entries: Vec<McpServerInventoryEntry>) -> (McpServerStatus, Vec<McpToolReading>) {
    let [entry] = <[_; 1]>::try_from(entries).expect("one entry");
    answered_status_and_tools(entry)
}

fn answered_status_and_tools(
    entry: McpServerInventoryEntry,
) -> (McpServerStatus, Vec<McpToolReading>) {
    let McpServerInventoryEntry::Answered(McpAnsweredInventoryEntry::User {
        status, tools, ..
    }) = entry
    else {
        panic!("the user binding's answered entry: {entry:?}");
    };
    (status, tools)
}

/// A tool the server offers, every facet the server's own.
fn server_tool(tool_name: &str) -> McpToolReading {
    McpToolReading {
        tool_name: tool(tool_name),
        enabled: McpToolSetting::Server { value: true },
        approval_mode: McpToolSetting::Server {
            value: McpApprovalMode::Auto,
        },
        idempotency_class: McpToolSetting::Server {
            value: McpServerIdempotencyClass::Value,
        },
    }
}

/// A list without a refresh sends no probe and shows no tools; a refresh probes, and its reading
/// is recorded in the tracker, so the entry's status and tools are the probe's. Killed by a probe
/// reading not recorded (the status stays `unknown`), by its tool names dropped (no tools), and by
/// a probe sent on every list.
#[tokio::test]
async fn a_refresh_records_the_probes_reading_and_a_plain_list_sends_no_probe() {
    let inventory = open_inventory(answering_at_once()).await;

    let (plain_status, plain_tools) = docs_entry(
        inventory
            .service
            .list(&PLAIN_LIST)
            .await
            .expect("the inventory lists"),
    );
    let (refreshed_status, refreshed_tools) = docs_entry(
        inventory
            .service
            .list(&REFRESH)
            .await
            .expect("the inventory lists on a refresh"),
    );

    assert_eq!(
        *lock(&inventory.probes),
        [McpProbeScope::None, McpProbeScope::EveryBinding]
    );
    assert_eq!(plain_status, McpServerStatus::Unknown);
    assert_eq!(plain_tools, [] as [McpToolReading; 0]);
    assert_eq!(refreshed_status, McpServerStatus::Connected);
    assert_eq!(
        refreshed_tools,
        [server_tool("search"), server_tool("delete")]
    );
    let held = inventory
        .tracker
        .reading(&McpBindingKey::of(&docs_binding(&inventory.provider)));
    assert_eq!(held.status, McpServerStatus::Connected);
    assert_eq!(held.tool_names, [tool("search"), tool("delete")]);
}

/// Two refreshes of one provider start one probe: the second waits for the first's and reads
/// what it recorded, so both answer the probe's reading. Killed by the gate dropped, which sends
/// a second probe and never leaves the second refresh waiting.
#[tokio::test]
async fn two_refreshes_of_one_provider_start_one_probe_and_both_answer_its_reading() {
    let (release, released) = oneshot::channel::<()>();
    let released = Mutex::new(Some(released));
    let inventory = open_inventory(Box::new(move |provider, request| {
        // The first read the driver is asked holds until the test lets it go.
        let hold = lock(&released).take();
        async move {
            if let Some(hold) = hold {
                hold.await.expect("the test lets the probe go");
            }
            Ok(reading_of(&provider, &request))
        }
        .boxed()
    }))
    .await;
    let let_the_probe_go = async {
        tokio::time::timeout(WAIT_BOUND, async {
            while inventory.gate.waiting_reads(&inventory.provider) != Some(1) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the second refresh waits for the running probe");
        release.send(()).expect("the probe is held");
    };

    let (first, second, ()) = tokio::join!(
        inventory.service.list(&REFRESH),
        inventory.service.list(&REFRESH),
        let_the_probe_go
    );

    assert_eq!(
        *lock(&inventory.probes),
        [McpProbeScope::EveryBinding, McpProbeScope::None]
    );
    for entries in [first, second] {
        let (status, tools) = docs_entry(entries.expect("the inventory lists on a refresh"));
        assert_eq!(status, McpServerStatus::Connected);
        assert_eq!(tools, [server_tool("search"), server_tool("delete")]);
    }
}

/// Which of the inventory's two reads the test asks.
enum InventoryRead {
    List,
    Read,
}

/// A tool whose override sets a facet reads the override's value with the server's own value
/// beside it, and a tool with none reads the server's own; through the list and through one
/// binding's read. Killed by the override join dropped, which reads a person's deny as allowed.
#[rstest]
#[case::list(InventoryRead::List)]
#[case::read(InventoryRead::Read)]
#[tokio::test]
async fn an_overrides_value_wins_and_keeps_the_servers_own_value(
    #[case] inventory_read: InventoryRead,
) {
    let inventory = open_inventory(answering_at_once()).await;
    inventory
        .database
        .reader()
        .execute(
            "INSERT INTO mcp_tool_overrides
               (provider, scope, server_name, tool_name, enabled, created_at, updated_at)
             VALUES (?1, 'user', 'docs', 'delete', 0, 't', 't')",
            params![inventory.provider.as_str()],
        )
        .expect("the person's deny is stored");
    inventory
        .service
        .list(&REFRESH)
        .await
        .expect("the refresh reads the server's tools");

    let entry = match inventory_read {
        InventoryRead::List => {
            let entries = inventory
                .service
                .list(&PLAIN_LIST)
                .await
                .expect("the inventory lists");
            let [entry] = <[_; 1]>::try_from(entries).expect("one entry");
            entry
        }
        InventoryRead::Read => inventory
            .service
            .read(&docs_binding(&inventory.provider))
            .await
            .expect("the binding is read"),
    };

    let (_status, tools) = answered_status_and_tools(entry);
    assert_eq!(
        tools,
        [
            server_tool("search"),
            McpToolReading {
                enabled: McpToolSetting::Override {
                    value: false,
                    server_value: true,
                },
                ..server_tool("delete")
            },
        ]
    );
}

/// A binding the driver no longer declares loses the probe's reading at the next read, while a
/// binding a live leg reports keeps that leg. A session's leg reports `news`, which no read
/// declares; the refresh declares `docs` and probes `docs` and `news`; the next read declares
/// neither. Killed by no pruning (`docs` keeps the probe's `connected` and tools, `news` the
/// probe's tools), by pruning a binding the read declares (the refresh's `docs` reads `unknown`),
/// and by pruning a live leg's binding whole (`news` loses its leg).
#[tokio::test]
async fn a_binding_gone_from_the_config_loses_its_probe_reading_and_a_live_leg_stays() {
    let news = |provider: &ProviderId| McpServerBindingRef::User {
        provider: provider.clone(),
        server_name: McpServerName::new("news".to_owned()).expect("a server name"),
    };
    let inventory = open_inventory(Box::new(move |provider, request| {
        let mut reading = reading_of(&provider, &request);
        if request.probe == McpProbeScope::None {
            reading.declarations.clear();
        } else {
            reading.probe_readings.push(McpProbeReading {
                binding: news(&provider),
                reading: McpServerReading::Observed(McpServerStatus::Connected),
                failure_text: None,
                tool_names: vec![tool("headlines")],
            });
        }
        ready(Ok(reading)).boxed()
    }))
    .await;
    let leg = inventory.tracker.open_leg(
        SessionId::try_from(mint_uuid_v7()).expect("a session id"),
        RuntimeBindingId::new("leg-a".to_owned()).expect("a binding id"),
    );
    leg.observe(
        &news(&inventory.provider),
        McpServerStatusEmission::new(
            McpServerName::new("news".to_owned()).expect("a server name"),
            McpServerReading::Observed(McpServerStatus::Failed),
            None,
            None,
        ),
    );
    let refreshed = docs_entry(
        inventory
            .service
            .list(&REFRESH)
            .await
            .expect("the inventory lists on a refresh"),
    );

    let entries = inventory
        .service
        .list(&PLAIN_LIST)
        .await
        .expect("the inventory lists");

    assert_eq!(
        refreshed,
        (
            McpServerStatus::Connected,
            vec![server_tool("search"), server_tool("delete")]
        )
    );
    assert_eq!(entries, [] as [McpServerInventoryEntry; 0]);
    let docs = inventory
        .tracker
        .reading(&McpBindingKey::of(&docs_binding(&inventory.provider)));
    assert_eq!(docs.status, McpServerStatus::Unknown);
    assert_eq!(docs.tool_names, [] as [McpToolName; 0]);
    let news = inventory
        .tracker
        .reading(&McpBindingKey::of(&news(&inventory.provider)));
    assert_eq!(news.legs.len(), 1);
    assert_eq!(news.status, McpServerStatus::Failed);
    assert_eq!(news.tool_names, [] as [McpToolName; 0]);
}

/// A `local` row the store keeps for the person's `docs` entry, which is off by default, reaches
/// the driver's read as an emulated binding, and a refresh's probe reading of that binding is
/// what the `local` row the inventory lists in the entry's place reads. Killed by the request
/// leaving the store's `local` bindings out, which leaves the row `unknown`.
#[tokio::test]
async fn a_refresh_reads_an_emulated_local_rows_status_from_its_probe() {
    let docs_local = |provider: &ProviderId| McpServerBindingRef::Local {
        provider: provider.clone(),
        scope_ref: FilesystemPath::new("/work/app".to_owned()).expect("a path"),
        place: None,
        server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
    };
    let inventory = open_inventory(Box::new(move |provider, request| {
        let local = docs_local(&provider);
        let mut reading = reading_of(&provider, &request);
        let McpServerConfigView::Stdio { enabled, .. } = &mut reading.declarations[0].config else {
            panic!("the test's entry runs a program");
        };
        *enabled = Some(false);
        reading.probe_readings = if request.probe == McpProbeScope::EveryBinding
            && request.emulated_local_bindings.contains(&local)
        {
            vec![McpProbeReading {
                binding: local,
                reading: McpServerReading::Observed(McpServerStatus::Connected),
                failure_text: None,
                tool_names: Vec::new(),
            }]
        } else {
            Vec::new()
        };
        ready(Ok(reading)).boxed()
    }))
    .await;
    inventory
        .database
        .reader()
        .execute(
            "INSERT INTO mcp_server_bindings
               (provider, scope, scope_ref, server_name, first_observed_at, updated_at)
             VALUES (?1, 'local', '/work/app', 'docs', 't', 't')",
            params![inventory.provider.as_str()],
        )
        .expect("the local binding's row is stored");

    let entries = inventory
        .service
        .list(&REFRESH)
        .await
        .expect("the inventory lists on a refresh");

    let [entry] = <[_; 1]>::try_from(entries).expect("one entry");
    let McpServerInventoryEntry::Answered(McpAnsweredInventoryEntry::Local {
        scope_ref,
        status,
        ..
    }) = entry
    else {
        panic!("the local binding's answered entry: {entry:?}");
    };
    assert_eq!(scope_ref.as_str(), "/work/app");
    assert_eq!(status, McpServerStatus::Connected);
}
