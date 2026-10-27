//! The service's three diagnostic buckets, each a [`DailyFileBucket`] under the data folder: the
//! workflow engine's event record, always written; `tool_traces`, one record per tool call while
//! `Record traces` is on; and `driver_raw_events`, every message a provider sends the service word
//! for word while `Record raw provider messages` is on. A switch is read at each record, so a
//! change takes effect from the next record on.

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::watch;

use crate::daemon::configuration::{ConfigurationStore, DaemonConfiguration};
use crate::observability::diagnostic_buckets::daily_file::DailyFileBucket;

// The folder in the data folder that holds every diagnostic bucket's own folder.
const DIAGNOSTICS_FOLDER_NAME: &str = "diagnostics";

const WORKFLOW_ENGINE_EVENTS_FOLDER_NAME: &str = "workflow-engine-events";

const TOOL_TRACES_FOLDER_NAME: &str = "tool-traces";

const DRIVER_RAW_EVENTS_FOLDER_NAME: &str = "driver-raw-events";

/// Every diagnostic bucket's folder under `data_folder`, which the expiry walks.
pub(crate) fn diagnostic_bucket_folders(data_folder: &Path) -> [PathBuf; 3] {
    [
        WORKFLOW_ENGINE_EVENTS_FOLDER_NAME,
        TOOL_TRACES_FOLDER_NAME,
        DRIVER_RAW_EVENTS_FOLDER_NAME,
    ]
    .map(|bucket| data_folder.join(DIAGNOSTICS_FOLDER_NAME).join(bucket))
}

/// The folder raw provider messages are written to, which Settings › Runtime names.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start names the folder to the config methods"
    )
)]
pub(crate) fn provider_messages_folder(data_folder: &Path) -> PathBuf {
    data_folder
        .join(DIAGNOSTICS_FOLDER_NAME)
        .join(DRIVER_RAW_EVENTS_FOLDER_NAME)
}

/// The workflow engine's event record, written whatever the switches say.
#[expect(
    dead_code,
    reason = "the workflow engine's event log is given the bucket it appends each record to"
)]
pub(crate) fn workflow_engine_events_bucket(data_folder: &Path) -> DailyFileBucket {
    DailyFileBucket::new(
        data_folder
            .join(DIAGNOSTICS_FOLDER_NAME)
            .join(WORKFLOW_ENGINE_EVENTS_FOLDER_NAME),
    )
}

/// One tool call as the provider gave it: its own arguments and result body, a superset of what
/// the session's events carry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver records its tool calls through the recorder"
    )
)]
pub(crate) struct ToolTrace {
    /// The session the call ran in.
    pub(crate) session_id: SessionId,
    /// The provider that made the call.
    pub(crate) provider: ProviderId,
    /// The provider's own id for the call.
    pub(crate) tool_call_id: String,
    /// The tool's name in the provider's spelling.
    pub(crate) tool_name: String,
    /// The arguments as the provider sent them.
    pub(crate) arguments: Value,
    /// The result body as the provider sent it.
    pub(crate) result: Value,
}

/// One message a provider sent the service, word for word.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver's transport hands every message to the recorder"
    )
)]
pub(crate) struct RawProviderMessage {
    /// The provider that sent it.
    pub(crate) provider: ProviderId,
    /// The message's text exactly as it arrived.
    pub(crate) message: String,
}

/// A bucket written only while its switch in the configuration is on.
pub(crate) struct SwitchedRecorder<Record> {
    bucket: DailyFileBucket,
    configuration: watch::Receiver<DaemonConfiguration>,
    is_on: fn(&DaemonConfiguration) -> bool,
    record: PhantomData<fn(&Record)>,
}

impl<Record: Serialize> SwitchedRecorder<Record> {
    /// Appends `record` when the switch is on now, resolving once it is written; while it is off
    /// nothing is written.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "each driver records through the recorder it is given"
        )
    )]
    pub(crate) async fn record(&self, record: &Record) {
        let is_on = (self.is_on)(&self.configuration.borrow());
        if is_on {
            self.bucket.append(record).await;
        }
    }
}

/// The `tool_traces` recorder, on while `Record traces` is.
pub(crate) type ToolTraceRecorder = SwitchedRecorder<ToolTrace>;

/// The `driver_raw_events` recorder, on while `Record raw provider messages` is.
pub(crate) type RawMessageRecorder = SwitchedRecorder<RawProviderMessage>;

/// The tool-trace recorder each driver is given, writing under `data_folder`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start gives each driver the recorder"
    )
)]
pub(crate) fn tool_trace_recorder(
    data_folder: &Path,
    configuration: &ConfigurationStore,
) -> ToolTraceRecorder {
    SwitchedRecorder {
        bucket: DailyFileBucket::new(
            data_folder
                .join(DIAGNOSTICS_FOLDER_NAME)
                .join(TOOL_TRACES_FOLDER_NAME),
        ),
        configuration: configuration.follow(),
        is_on: |configuration| configuration.record_traces,
        record: PhantomData,
    }
}

/// The raw-message recorder each driver's transport is given, writing into
/// [`provider_messages_folder`].
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start gives each driver the recorder"
    )
)]
pub(crate) fn raw_message_recorder(
    data_folder: &Path,
    configuration: &ConfigurationStore,
) -> RawMessageRecorder {
    SwitchedRecorder {
        bucket: DailyFileBucket::new(provider_messages_folder(data_folder)),
        configuration: configuration.follow(),
        is_on: |configuration| configuration.record_provider_messages,
        record: PhantomData,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;

    use serde_json::{Value, json};
    use sidekicks_contracts::daemon::config::DaemonConfigUpdateRequest;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_log::open_log;

    use super::{
        RawProviderMessage, TOOL_TRACES_FOLDER_NAME, ToolTrace, provider_messages_folder,
        raw_message_recorder, tool_trace_recorder,
    };
    use crate::daemon::configuration::{
        ConfigurationChange, ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    };
    use crate::observability::diagnostic_buckets::recorders::DIAGNOSTICS_FOLDER_NAME;
    use crate::remote::shared_ports::schema::schema_parts;

    // Each line of every day file in `folder`, parsed, oldest file first.
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

    async fn set(store: &ConfigurationStore, setting: DaemonConfigUpdateRequest) {
        store
            .update(ConfigurationChange::Setting(&setting))
            .await
            .expect("the switch is set");
    }

    // With each switch off a record writes nothing; turned on, the next record lands whole and
    // stamped in the stored instant form; turned off again, nothing more is written. Killed by a
    // switch read once when the recorder is made, by a recorder that ignores its switch, and by a
    // stamp written in another form than three fraction digits and `Z`.
    #[tokio::test]
    async fn each_switch_gates_its_bucket_from_the_change_on() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let reads = DatabaseReadPool::new(database.path(), DAEMON_CONFIGURATION_STATEMENT_CAPACITY);
        let store = Arc::new(
            ConfigurationStore::open(Arc::clone(&log.writer), &reads)
                .await
                .expect("the configuration store opens"),
        );
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let traces = tool_trace_recorder(data_folder.path(), &store);
        let messages = raw_message_recorder(data_folder.path(), &store);
        let provider = ProviderId::new("claude".to_owned()).expect("the id is a provider id");
        let trace = |tool_call_id: &str| ToolTrace {
            session_id: SessionId::new("7d3f8a52-2c1e-4f6b-9a0d-5e8b1c4d2f3a")
                .expect("the id is a UUID"),
            provider: provider.clone(),
            tool_call_id: tool_call_id.to_owned(),
            tool_name: "Bash".to_owned(),
            arguments: json!({ "command": "ls" }),
            result: json!({ "stdout": "README.md\n" }),
        };
        let message = |text: &str| RawProviderMessage {
            provider: provider.clone(),
            message: text.to_owned(),
        };

        traces.record(&trace("while-off")).await;
        messages.record(&message("while off")).await;
        set(&store, DaemonConfigUpdateRequest::RecordTraces(true)).await;
        set(
            &store,
            DaemonConfigUpdateRequest::RecordProviderMessages(true),
        )
        .await;
        traces.record(&trace("while-on")).await;
        messages
            .record(&message("{\"type\":\"result\", \"spaced\" : 1}"))
            .await;
        set(&store, DaemonConfigUpdateRequest::RecordTraces(false)).await;
        set(
            &store,
            DaemonConfigUpdateRequest::RecordProviderMessages(false),
        )
        .await;
        traces.record(&trace("off-again")).await;
        messages.record(&message("off again")).await;

        let trace_lines = recorded_lines(
            &data_folder
                .path()
                .join(DIAGNOSTICS_FOLDER_NAME)
                .join(TOOL_TRACES_FOLDER_NAME),
        );
        assert_eq!(
            trace_lines.len(),
            1,
            "only the call made while on is traced"
        );
        assert_eq!(trace_lines[0]["toolCallId"], "while-on");
        assert_eq!(trace_lines[0]["result"], json!({ "stdout": "README.md\n" }));
        let recorded_at = trace_lines[0]["recordedAt"]
            .as_str()
            .expect("the stamp is text");
        assert_eq!(
            recorded_at.len(),
            "2026-10-21T00:00:00.000Z".len(),
            "{recorded_at}"
        );
        assert!(recorded_at.ends_with('Z') && recorded_at.as_bytes()[19] == b'.');
        let message_lines = recorded_lines(&provider_messages_folder(data_folder.path()));
        assert_eq!(
            message_lines.len(),
            1,
            "only the message sent while on is kept"
        );
        assert_eq!(
            message_lines[0]["message"], "{\"type\":\"result\", \"spaced\" : 1}",
            "the message is kept word for word"
        );
    }
}
