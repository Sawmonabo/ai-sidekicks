use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::daemon::config::{DaemonConfigUpdate, DaemonConfigUpdateRequest};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::CAN_BIND_A_SOCKET_LISTENER;
use sidekicks_provider::port::raw_provider_messages::RawProviderMessages;
use sidekicks_provider::port::tool_traces::{ToolTrace, ToolTraces};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;
use tokio_util::sync::CancellationToken;

use super::TestHome;
use crate::daemon::configuration::{
    ConfigurationChange, ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
};
use crate::daemon::process::DaemonProcess;
use crate::daemon::process::stop::DaemonStopReason;
use crate::daemon::schema::schema_parts;
use crate::observability::diagnostic_buckets::recorders::{
    provider_messages_folder, raw_message_recorder, tool_trace_recorder, tool_traces_folder,
};

// One line as a provider wrote it, its spacing kept, which a recorder must not normalize.
const SCRIPTED_LINE: &str = r#"{"type":"result", "spaced" : 1}"#;

// Each line of every day file in `folder`, parsed, oldest file first; none where the folder was
// never made.
fn recorded_lines(folder: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .map(|entry| entry.expect("the folder lists").path())
        .collect();
    files.sort();
    files
        .iter()
        .flat_map(|file| {
            fs::read_to_string(file)
                .expect("the day file reads")
                .lines()
                .map(|line| serde_json::from_str(line).expect("a line is JSON"))
                .collect::<Vec<Value>>()
        })
        .collect()
}

// Asserts `line` is stamped in the stored instant form: three fraction digits and `Z`.
fn assert_stamped(line: &Value) {
    let recorded_at = line["recordedAt"].as_str().expect("the stamp is text");
    assert_eq!(
        recorded_at.len(),
        "2026-10-21T00:00:00.000Z".len(),
        "{recorded_at}"
    );
    assert!(recorded_at.ends_with('Z') && recorded_at.as_bytes()[19] == b'.');
}

// The daemon started on `home`, and a client connected to it.
async fn start_with_client(home: &TestHome) -> (DaemonProcess, DaemonConnection) {
    let process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    let client = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the client connects");
    (process, client)
}

async fn set_switch(client: &DaemonConnection, setting: DaemonConfigUpdateRequest) {
    client
        .client()
        .call::<DaemonConfigUpdate>(&setting)
        .await
        .expect("the switch is set");
}

fn provider() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the id is a provider id")
}

// A trace of the call `tool_call_id`, its arguments and result spaced as a provider wrote them.
fn trace(tool_call_id: &str) -> ToolTrace {
    ToolTrace {
        session_id: SessionId::new("7d3f8a52-2c1e-4f6b-9a0d-5e8b1c4d2f3a")
            .expect("the id is a UUID"),
        provider: provider(),
        tool_call_id: tool_call_id.to_owned(),
        tool_name: "Bash".to_owned(),
        arguments: RawValue::from_string(r#"{ "command" : "ls" }"#.to_owned())
            .expect("the arguments are JSON"),
        result: RawValue::from_string(SCRIPTED_LINE.to_owned()).expect("the result is JSON"),
    }
}

// The start hands the drivers' raw-message port a recorder of `Record raw provider messages`:
// with the switch off a scripted provider line writes nothing; turned on, the next line lands in
// the folder Settings names, word for word and stamped; turned off again, nothing more is
// written. Killed by the start leaving the port unregistered, by a recorder that ignores its
// switch or reads it once when made, by one following `Record traces`, and by one writing
// elsewhere or reshaping the line.
#[tokio::test(flavor = "multi_thread")]
async fn record_raw_provider_messages_gates_what_the_drivers_port_writes() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let (process, client) = start_with_client(&home).await;
    let raw_messages = process
        .providers
        .as_ref()
        .expect("the start keeps the providers")
        .ports
        .raw_provider_messages
        .port()
        .map(Arc::clone)
        .expect("the start registers the raw-message recorder");

    assert!(!raw_messages.is_recording());
    raw_messages
        .record(provider(), "while off".to_owned())
        .await;
    set_switch(
        &client,
        DaemonConfigUpdateRequest::RecordProviderMessages(true),
    )
    .await;
    assert!(raw_messages.is_recording());
    raw_messages
        .record(provider(), SCRIPTED_LINE.to_owned())
        .await;
    set_switch(
        &client,
        DaemonConfigUpdateRequest::RecordProviderMessages(false),
    )
    .await;
    raw_messages
        .record(provider(), "off again".to_owned())
        .await;
    client.close().await;
    process
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the stop fails nothing");

    let lines = recorded_lines(&provider_messages_folder(&home.data_folder()));
    assert_eq!(
        lines.len(),
        1,
        "only the line read while on is kept: {lines:?}"
    );
    assert_eq!(lines[0]["provider"], "claude");
    assert_eq!(
        lines[0]["message"], SCRIPTED_LINE,
        "the line is kept word for word"
    );
    assert_stamped(&lines[0]);
}

// The start hands the drivers' tool-trace port a recorder of `Record traces`: with the switch off
// a scripted call's trace writes nothing; turned on, the next lands with its arguments and result
// as the provider wrote them; turned off again, nothing more is written. Killed by the start
// leaving the port unregistered, by a recorder that ignores its switch or reads it once when
// made, by one following `Record raw provider messages`, and by one writing elsewhere or
// reshaping the call's bodies.
#[tokio::test(flavor = "multi_thread")]
async fn record_traces_gates_what_the_drivers_port_writes() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let (process, client) = start_with_client(&home).await;
    let tool_traces = process
        .providers
        .as_ref()
        .expect("the start keeps the providers")
        .ports
        .tool_traces
        .port()
        .map(Arc::clone)
        .expect("the start registers the tool-trace recorder");
    assert!(!tool_traces.is_recording());
    tool_traces.record(trace("while-off")).await;
    set_switch(&client, DaemonConfigUpdateRequest::RecordTraces(true)).await;
    assert!(tool_traces.is_recording());
    tool_traces.record(trace("while-on")).await;
    set_switch(&client, DaemonConfigUpdateRequest::RecordTraces(false)).await;
    tool_traces.record(trace("off-again")).await;
    client.close().await;
    process
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the stop fails nothing");

    let lines = recorded_lines(&tool_traces_folder(&home.data_folder()));
    assert_eq!(
        lines.len(),
        1,
        "only the call made while on is traced: {lines:?}"
    );
    assert_eq!(lines[0]["toolCallId"], "while-on");
    assert_eq!(lines[0]["toolName"], "Bash");
    assert_eq!(lines[0]["arguments"], json!({ "command": "ls" }));
    assert_eq!(lines[0]["result"], json!({ "type": "result", "spaced": 1 }));
    assert_stamped(&lines[0]);
}

async fn set_in_store(store: &ConfigurationStore, setting: DaemonConfigUpdateRequest) {
    store
        .update(ConfigurationChange::Setting(&setting))
        .await
        .expect("the switch is set");
}

// Each recorder over the configuration store, with no socket: off, nothing is written; with only
// its own switch on, its next record lands, a message word for word; off again, nothing more.
// Killed by a recorder that ignores its switch, reads it once when made or follows the other
// switch, and by one reshaping a message.
#[tokio::test]
async fn each_switch_gates_its_recorder_from_the_change_on() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    ));
    let store = ConfigurationStore::open(Arc::clone(&log.writer), reads)
        .await
        .expect("the configuration store opens");
    let data_folder = tempfile::tempdir().expect("the data folder is made");
    let tool_traces = tool_trace_recorder(data_folder.path(), &store);
    let raw_messages = raw_message_recorder(data_folder.path(), &store);

    ToolTraces::record(&tool_traces, trace("while-off")).await;
    RawProviderMessages::record(&raw_messages, provider(), "while off".to_owned()).await;
    set_in_store(&store, DaemonConfigUpdateRequest::RecordTraces(true)).await;
    assert!(ToolTraces::is_recording(&tool_traces));
    assert!(!RawProviderMessages::is_recording(&raw_messages));
    ToolTraces::record(&tool_traces, trace("while-on")).await;
    RawProviderMessages::record(&raw_messages, provider(), "traces only".to_owned()).await;
    set_in_store(&store, DaemonConfigUpdateRequest::RecordTraces(false)).await;
    set_in_store(
        &store,
        DaemonConfigUpdateRequest::RecordProviderMessages(true),
    )
    .await;
    ToolTraces::record(&tool_traces, trace("messages-only")).await;
    RawProviderMessages::record(&raw_messages, provider(), SCRIPTED_LINE.to_owned()).await;
    set_in_store(
        &store,
        DaemonConfigUpdateRequest::RecordProviderMessages(false),
    )
    .await;
    RawProviderMessages::record(&raw_messages, provider(), "off again".to_owned()).await;

    let trace_lines = recorded_lines(&tool_traces_folder(data_folder.path()));
    assert_eq!(trace_lines.len(), 1, "{trace_lines:?}");
    assert_eq!(trace_lines[0]["toolCallId"], "while-on");
    let message_lines = recorded_lines(&provider_messages_folder(data_folder.path()));
    assert_eq!(message_lines.len(), 1, "{message_lines:?}");
    assert_eq!(message_lines[0]["message"], SCRIPTED_LINE);
}
