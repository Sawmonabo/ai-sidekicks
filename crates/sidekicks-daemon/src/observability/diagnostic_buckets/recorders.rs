//! The service's three diagnostic buckets, each a [`DailyFileBucket`] under the data folder: the
//! workflow engine's event record, always written; `tool_traces`, one record per tool call while
//! `Record traces` is on; and `driver_raw_events`, every message a provider sends the service word
//! for word while `Record raw provider messages` is on. A switch is read at each record, so a
//! change takes effect from the next record on.

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::port::raw_provider_messages::RawProviderMessages;
use sidekicks_provider::port::tool_traces::{ToolTrace, ToolTraces};
use sidekicks_workflow::engine::ports::EngineRecordSink;
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
        workflow_engine_events_folder(data_folder),
        tool_traces_folder(data_folder),
        provider_messages_folder(data_folder),
    ]
}

// The folder the workflow engine's events are written to.
fn workflow_engine_events_folder(data_folder: &Path) -> PathBuf {
    bucket_folder(data_folder, WORKFLOW_ENGINE_EVENTS_FOLDER_NAME)
}

/// The folder tool traces are written to.
pub(crate) fn tool_traces_folder(data_folder: &Path) -> PathBuf {
    bucket_folder(data_folder, TOOL_TRACES_FOLDER_NAME)
}

/// The folder raw provider messages are written to, which Settings › Runtime names.
pub(crate) fn provider_messages_folder(data_folder: &Path) -> PathBuf {
    bucket_folder(data_folder, DRIVER_RAW_EVENTS_FOLDER_NAME)
}

// The folder of the bucket `bucket_name` under `data_folder`.
fn bucket_folder(data_folder: &Path, bucket_name: &str) -> PathBuf {
    data_folder.join(DIAGNOSTICS_FOLDER_NAME).join(bucket_name)
}

/// The workflow engine's event record, written whatever the switches say.
#[expect(
    dead_code,
    reason = "the workflow engine's event log is given the bucket it appends each record to"
)]
pub(crate) fn workflow_engine_events_bucket(data_folder: &Path) -> DailyFileBucket {
    DailyFileBucket::new(workflow_engine_events_folder(data_folder))
}

impl EngineRecordSink for DailyFileBucket {
    /// Appends the engine's line as one line of today's file; a line that is lost is told in the
    /// service log.
    fn record(&self, entry: Map<String, Value>) -> BoxFuture<'_, ()> {
        Box::pin(async move { self.append(&entry).await })
    }
}

/// One message a provider sent the service, word for word.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
    /// Whether the switch is on now.
    pub(crate) fn is_on(&self) -> bool {
        (self.is_on)(&self.configuration.borrow())
    }

    /// Appends `record` when the switch is on now, resolving once it is written; while it is off
    /// nothing is written.
    pub(crate) async fn record(&self, record: &Record) {
        if self.is_on() {
            self.bucket.append(record).await;
        }
    }
}

/// The `tool_traces` recorder, on while `Record traces` is.
pub(crate) type ToolTraceRecorder = SwitchedRecorder<ToolTrace>;

/// The `driver_raw_events` recorder, on while `Record raw provider messages` is.
pub(crate) type RawMessageRecorder = SwitchedRecorder<RawProviderMessage>;

/// The tool-trace recorder each driver is given, writing under `data_folder`.
pub(crate) fn tool_trace_recorder(
    data_folder: &Path,
    configuration: &ConfigurationStore,
) -> ToolTraceRecorder {
    SwitchedRecorder {
        bucket: DailyFileBucket::new(tool_traces_folder(data_folder)),
        configuration: configuration.follow(),
        is_on: |configuration| configuration.record_traces,
        record: PhantomData,
    }
}

/// The raw-message recorder each driver's transport is given, writing into
/// [`provider_messages_folder`].
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

impl ToolTraces for ToolTraceRecorder {
    fn is_recording(&self) -> bool {
        self.is_on()
    }

    fn record(&self, trace: ToolTrace) -> BoxFuture<'_, ()> {
        async move { SwitchedRecorder::record(self, &trace).await }.boxed()
    }
}

impl RawProviderMessages for RawMessageRecorder {
    fn is_recording(&self) -> bool {
        self.is_on()
    }

    fn record(&self, provider: ProviderId, message: String) -> BoxFuture<'_, ()> {
        async move { SwitchedRecorder::record(self, &RawProviderMessage { provider, message }).await }
            .boxed()
    }
}
