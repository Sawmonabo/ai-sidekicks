//! `daemon.status.read`: the service's own facts in one reply, for Settings › Runtime and
//! `sidekicks daemon status`. Processor and memory are read on each call, never on a timer; a call
//! whose reading fails still answers, with both `null` and the failure in the service log.

use std::sync::Arc;

use futures::FutureExt as _;
use jiff::Timestamp;
use sidekicks_contracts::daemon::status::{
    DAEMON_STATUS_TEXT_MAX_LEN, DaemonMemoryReading, DaemonProcessState, DaemonProcessorReading,
    DaemonStatusRead, DaemonStatusReadResponse,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_store::credential_store::items::SecretItems;

use crate::daemon::process_tree_usage::ProcessTreeUsageReader;

/// The running daemon's facts the status read reports.
pub(crate) struct StatusMethodsDeps {
    /// The daemon's own process as the system knows it, read once at its start.
    pub(crate) process_identity: ProcessIdentity,
    /// Where the daemon is in its own life at the moment of the call.
    pub(crate) read_process_state: Arc<dyn Fn() -> DaemonProcessState + Send + Sync>,
    /// Where the daemon stands in its recovery from the last restart.
    pub(crate) recovery: Arc<RecoveryStatusTracker>,
    /// The service's own release version.
    pub(crate) version: ReleaseVersion,
    /// The socket the daemon listens on.
    pub(crate) transport_endpoint: BoundedText<1, DAEMON_STATUS_TEXT_MAX_LEN>,
    /// The data folder this daemon holds.
    pub(crate) data_directory: FilesystemPath,
    /// When the daemon started.
    pub(crate) started_at: Timestamp,
    /// Reads the daemon's process and every process under it.
    pub(crate) usage_reader: Arc<ProcessTreeUsageReader>,
    /// The daemon's secrets, read for the items file while it holds them.
    pub(crate) secret_items: Arc<SecretItems>,
}

/// Registers `daemon.status.read`, a read-only query. Fails the start when the method is already
/// registered.
pub(crate) fn register_status_methods(
    registry: &mut MethodRegistryBuilder,
    deps: StatusMethodsDeps,
) -> Result<(), RegistrationError> {
    let deps = Arc::new(deps);
    registry.register::<DaemonStatusRead, _>(move |_: EmptyPayload, _context: HandlerContext| {
        let deps = Arc::clone(&deps);
        async move { read_status(&deps).await }.boxed()
    })
}

// The status at this call; a failed processor and memory reading reads as `null` for both.
async fn read_status(deps: &StatusMethodsDeps) -> Result<DaemonStatusReadResponse, HandlerError> {
    let usage = match deps.usage_reader.read(std::process::id()).await {
        Ok(usage) => Some(usage),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The processor and memory reading failed"
            );
            None
        }
    };
    let read_at_timestamp = Timestamp::now();
    let read_at = WireInstant::from_timestamp(read_at_timestamp)
        .ok_or_else(|| internal("the clock reads before the year 0000"))?;
    let started_at = WireInstant::from_timestamp(deps.started_at)
        .ok_or_else(|| internal("the start reads before the year 0000"))?;
    let uptime_ms = u64::try_from(
        read_at_timestamp
            .duration_since(deps.started_at)
            .as_millis()
            .max(0),
    )
    .map_err(|error| HandlerError::Internal(Box::new(error)))?;
    let (processor, memory) = match usage {
        Some(usage) => (
            Some(DaemonProcessorReading {
                percent: Percent::new(usage.processor_percent.clamp(0.0, 100.0))
                    .ok_or_else(|| internal("the processor share is not a number"))?,
                read_at: read_at.clone(),
            }),
            Some(DaemonMemoryReading {
                resident_bytes: SafeInt::new(usage.resident_bytes)
                    .ok_or_else(|| internal("the resident bytes pass the safe integers"))?,
                read_at,
            }),
        ),
        None => (None, None),
    };
    let secrets_file = deps
        .secret_items
        .secrets_file()
        .await
        .map_err(|error| HandlerError::Internal(Box::new(error)))?;
    Ok(DaemonStatusReadResponse {
        process_state: (deps.read_process_state)(),
        process_identity: deps.process_identity.clone(),
        version: deps.version.clone(),
        protocol_version: BoundedText::new(CURRENT_PROTOCOL_VERSION.to_owned())
            .ok_or_else(|| internal("the protocol version is no status text"))?,
        transport_endpoint: deps.transport_endpoint.clone(),
        started_at,
        uptime_ms: SafeInt::new(uptime_ms)
            .ok_or_else(|| internal("the uptime passes the safe integers"))?,
        data_directory: deps.data_directory.clone(),
        processor,
        memory,
        recovery: deps.recovery.read(),
        relay: None,
        wsl: None,
        secrets_file,
    })
}

// A fault inside the daemon, answered `-32603` with no detail.
fn internal(why: &'static str) -> HandlerError {
    HandlerError::Internal(why.into())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use jiff::Timestamp;
    use serde_json::{Value, json};
    use sidekicks_contracts::daemon::status::{DaemonProcessState, DaemonStatusRead};
    use sidekicks_contracts::method::Method as _;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistryBuilder, Reply};
    use sidekicks_platforms::CredentialStore;
    use sidekicks_recovery::status::RecoveryStatusTracker;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
    use sidekicks_store::credential_store::os::TestStoreAccess;

    use super::{StatusMethodsDeps, register_status_methods};
    use crate::daemon::process_tree_usage::ProcessTreeUsageReader;

    // Every process state the daemon is in at the call is the one the read reports, read at each
    // call on one registry. Killed by the state read once when the method is registered, and by
    // any state projected as another.
    #[tokio::test]
    async fn each_process_state_is_reported_as_it_stands_at_the_call() {
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let state = Arc::new(Mutex::new(DaemonProcessState::Starting));
        let read_state = Arc::clone(&state);
        let mut builder = MethodRegistryBuilder::new();
        register_status_methods(
            &mut builder,
            StatusMethodsDeps {
                process_identity: serde_json::from_value(json!({
                    "processId": 4242,
                    "bootId": "boot",
                    "processStartTime": "start",
                }))
                .expect("an identity reads"),
                read_process_state: Arc::new(move || *lock(&read_state)),
                recovery: Arc::new(RecoveryStatusTracker::new()),
                version: serde_json::from_value(json!("0.1.0")).expect("a version reads"),
                transport_endpoint: serde_json::from_value(json!("/run/daemon.sock"))
                    .expect("an endpoint reads"),
                data_directory: serde_json::from_value(json!(data_folder.path()))
                    .expect("a folder reads"),
                started_at: Timestamp::now(),
                usage_reader: Arc::new(ProcessTreeUsageReader::new()),
                secret_items: SecretItems::new(SecretItemsStart {
                    data_folder: data_folder.path().to_path_buf(),
                    runs_while_logged_out: false,
                    access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
                    call_timeout: Duration::from_secs(5),
                })
                .expect("the system gives random bytes"),
            },
        )
        .expect("the status read registers");
        let registry = builder.freeze();

        for expected in [
            DaemonProcessState::Starting,
            DaemonProcessState::Running,
            DaemonProcessState::Degraded,
            DaemonProcessState::Stopping,
        ] {
            *lock(&state) = expected;
            let Ok(Reply::Result(read)) = registry
                .dispatch(
                    request(DaemonStatusRead::DESCRIPTOR.method, Some(&json!({}))),
                    context(1),
                )
                .await
            else {
                panic!("the status read answers");
            };
            let read: Value = serde_json::from_slice(&read.json).expect("the read is JSON");
            assert_eq!(
                read["processState"],
                serde_json::to_value(expected).expect("a state writes"),
            );
        }
    }
}
