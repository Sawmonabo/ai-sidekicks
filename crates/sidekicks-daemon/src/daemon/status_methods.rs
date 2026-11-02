//! `daemon.status.read`: the service's own facts in one reply, for Settings › Runtime and
//! `sidekicks daemon status`. Processor and memory are read on each call, never on a timer; a call
//! whose reading fails still answers, with both `null` and the failure in the service log, and so
//! does one whose wake helper status cannot be read, with no `wakeHelper`.

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
use sidekicks_contracts::provider::account::methods::ProviderWakeHelperState;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::wake_helper::{MachineWakeHelper, wake_helper_state};
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::machine::identity_key::MachineIdentity;

use crate::daemon::process_tree_usage::ProcessTreeUsageReader;

/// The running daemon's facts the status read reports.
pub(crate) struct StatusMethodsDeps {
    /// The daemon's own process as the system knows it, read once at its start.
    pub(crate) process_identity: ProcessIdentity,
    /// Where the daemon is in its own life at the moment of the call.
    pub(crate) read_process_state: Arc<dyn Fn() -> DaemonProcessState + Send + Sync>,
    /// Where the daemon stands in its recovery from the last restart.
    pub(crate) recovery: Arc<RecoveryStatusTracker>,
    /// The reads the recovery state checks its halted runs through.
    pub(crate) reads: Arc<DatabaseReadPool>,
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
    /// This machine's two keys, whose last read the status reports while they are not held.
    pub(crate) machine_identity: Arc<MachineIdentity>,
    /// The provider accounts, whose wake switches decide whether the wake helper is reported.
    pub(crate) accounts: Arc<ProviderAccountRegistry>,
    /// The machine's wake helper; `None` on a system with none.
    pub(crate) wake_helper: Option<Arc<dyn MachineWakeHelper>>,
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
    let recovery = deps.recovery.read(&deps.reads).await;
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
        recovery,
        relay: None,
        wsl: None,
        secrets_file,
        machine_key: deps.machine_identity.machine_key().await,
        wake_helper: read_wake_helper(deps).await?,
    })
}

// The wake helper's status while any account's wake switch is on; none on a system with no
// helper, while every switch is off, or when the status cannot be read, which is logged.
async fn read_wake_helper(
    deps: &StatusMethodsDeps,
) -> Result<Option<ProviderWakeHelperState>, HandlerError> {
    let Some(helper) = &deps.wake_helper else {
        return Ok(None);
    };
    let accounts = deps.accounts.list(None).await?;
    if !accounts
        .iter()
        .any(|account| account.wake_for_window_start_enabled)
    {
        return Ok(None);
    }
    match helper.status().await {
        Ok(status) => Ok(Some(wake_helper_state(status))),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the wake helper's status could not be read"
            );
            Ok(None)
        }
    }
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
    use sidekicks_contracts::machine::id::MachineId;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::provider::account::record::BillingMode;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::UserId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistryBuilder, Reply};
    use sidekicks_platforms::{CredentialStore, WakeHelperStatus};
    use sidekicks_provider::account::registry::{
        AccountAdmission, AccountSettingsChange, ProviderAccountRegistry,
    };
    use sidekicks_provider::account::wake_helper::{MachineWakeHelper, ScriptedWakeHelper};
    use sidekicks_recovery::status::RecoveryStatusTracker;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
    use sidekicks_store::credential_store::os::TestStoreAccess;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_fixture::open_log;
    use sidekicks_store::machine::identity_key::MachineIdentity;
    use sidekicks_store::machine::local::LocalMachine;

    use super::{StatusMethodsDeps, register_status_methods};
    use crate::daemon::process_tree_usage::ProcessTreeUsageReader;
    use crate::daemon::schema::schema_parts;

    // Every process state the daemon is in at the call is the one the read reports, read at each
    // call on one registry, and the wake helper's status is the helper's own, reported only once
    // an account's wake switch is on. Killed by the state read once when the method is
    // registered, by any state projected as another, by the helper's status read as another, and
    // by the helper reported while every switch is off.
    #[tokio::test]
    async fn each_process_state_and_the_wake_helper_are_reported_as_they_stand_at_the_call() {
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let state = Arc::new(Mutex::new(DaemonProcessState::Starting));
        let read_state = Arc::clone(&state);
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let machine = LocalMachine {
            machine_id: MachineId::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is a machine id"),
            owner_user_id: UserId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is a user id"),
            name: "Studio".to_owned(),
        };
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder: data_folder.path().to_path_buf(),
            runs_while_logged_out: false,
            access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes");
        let reads = Arc::new(DatabaseReadPool::new(database.path(), 1));
        let machine_identity = MachineIdentity::new(
            &machine,
            &secret_items,
            Arc::clone(&reads),
            Arc::clone(&log.writer),
        );
        let accounts = Arc::new(ProviderAccountRegistry::new(
            Arc::clone(&reads),
            Arc::clone(&log.writer),
            data_folder.path().to_owned(),
        ));
        let wake_helper = Arc::new(ScriptedWakeHelper::new(WakeHelperStatus::TurnedOff));
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
                reads,
                version: serde_json::from_value(json!("0.1.0")).expect("a version reads"),
                transport_endpoint: serde_json::from_value(json!("/run/daemon.sock"))
                    .expect("an endpoint reads"),
                data_directory: serde_json::from_value(json!(data_folder.path()))
                    .expect("a folder reads"),
                started_at: Timestamp::now(),
                usage_reader: Arc::new(ProcessTreeUsageReader::new()),
                secret_items,
                machine_identity,
                accounts: Arc::clone(&accounts),
                wake_helper: Some(wake_helper as Arc<dyn MachineWakeHelper>),
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
            assert_eq!(
                read.get("wakeHelper"),
                None,
                "no account's wake switch is on"
            );
        }

        let minted = accounts
            .mint(ProviderId::new("claude".to_owned()).expect("a provider id"))
            .expect("the account is minted");
        let account = accounts
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: None,
                    observed_auth_mode: None,
                },
            )
            .await
            .expect("the account is admitted");
        accounts
            .change_settings(
                account.account_id,
                AccountSettingsChange {
                    wake_for_window_start_enabled: Some(true),
                    ..AccountSettingsChange::default()
                },
            )
            .await
            .expect("the wake switch turns on");
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
        assert_eq!(read["wakeHelper"], json!({"state": "turnedOff"}));
    }
}
