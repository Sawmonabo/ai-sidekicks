//! The providers at the daemon's start: every driver built once from the one bundle of shared
//! services, the capability refresh over them, the ports the drivers read registered once the
//! services behind them exist, and the drivers' first capability reads, which a provider with a
//! lasting service answers by connecting to it.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use serde_json::{Map, Value};
use sidekicks_approval::permission_asks::PermissionAsks;
use sidekicks_approval::reviewer_denials::ReviewerDenials;
use sidekicks_approval::rules::ApprovalRules;
use sidekicks_artifact::plans::service::PlansService;
use sidekicks_contracts::machine::settings::{ProviderRowValue, ProviderSettingValues};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::declaration::{ProviderDeclarationId, ProviderValue};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_platforms::{PathRules, Spawner, current_user_id};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::background_work::BackgroundWorkForms;
use sidekicks_provider::callback_tools::host::CallbackToolHost;
use sidekicks_provider::capability::refresh::{CapabilityRefresher, CapabilityRefreshing};
use sidekicks_provider::command::running_set::RunningCommandSets;
use sidekicks_provider::command::waiting_checks::SystemInputWaitReader;
use sidekicks_provider::command_search::ProviderCommandSearch;
use sidekicks_provider::compaction_wait::PendingCompactionRegistry;
use sidekicks_provider::driver::attachments::AttachmentResolver;
use sidekicks_provider::driver::capabilities::writer::{
    CapabilityHydration, DriverCapabilitiesWriter,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ApplyRowValueParams;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_provider::driver::ports::{DriverPorts, ProcessGoneListener, SessionPlace};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{DriverServices, ProviderDescriptor, ProviderRegistration};
use sidekicks_provider::process_registry::ProviderProcessRegistry;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_queue::admission::QueueAdmission;
use sidekicks_queue::delivery::QueueDelivery;
use sidekicks_session::addresses::{ForeignPlaceError, SessionInboxAddresses};
use sidekicks_session::console_state::ConsoleStateAdvisors;
use sidekicks_session::idle_sleep::SessionIdleSleep;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::inbound::RunInboundDispatch;
use sidekicks_session::run::pause::RunPauseControl;
use sidekicks_session::usage_record::UsageRecord;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::port_registration::PortRegistrationError;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::naming::worktrees_folder;
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;
use tokio::task::JoinError;
use tokio_util::task::AbortOnDropHandle;

use crate::daemon::machine_settings::file::MachineSettingsFile;
use crate::daemon::process::session_services::stored_resumes::StoredSessionResumes;
use crate::program::dispatches_hook_mode;

/// What the providers' build takes from the steps before it.
pub(crate) struct ProviderStart {
    /// The one thread every child process is spawned from.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's session token file, which no provider process may read.
    pub(crate) session_token_path: PathBuf,
    /// The one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The one database writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// Binds a message's attachments to the artifact store's copies.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// The daemon's git, which the staged reviews' worktrees are made with.
    pub(crate) git: GitRunner,
    /// The login shell's environment captured at the start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Reads where a command channel's party runs.
    pub(crate) caller_processes: Arc<dyn CallerProcessReader>,
}

/// The providers the daemon runs: their registry, the ports their drivers read, the capability
/// refresh and the provider services the daemon holds a connection to.
pub(crate) struct Providers {
    /// Every driver, in the table's order.
    pub(crate) registry: Arc<ProviderRegistry>,
    /// The ports every driver reads, registered once their owners exist.
    pub(crate) ports: Arc<DriverPorts>,
    /// Reads every driver's capabilities again when asked.
    pub(crate) refresher: Arc<CapabilityRefresher>,
    /// Stores each provider's capability reading and rebuilds the stored one at the start.
    pub(crate) capabilities: Arc<DriverCapabilitiesWriter>,
    /// The refresh's pass task, which the stop ends.
    pub(crate) refreshing: CapabilityRefreshing,
    /// The processes serving the provider services the daemon holds a connection to, which the
    /// caller check refuses descendants of.
    pub(crate) provider_services: Arc<ProviderServiceProcesses>,
    /// Each posture's curated credential list, which the run engine and the permission check
    /// read too.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The one store of runtime bindings, which the run queue and the binding cursors write too.
    pub(crate) runtime_bindings: Arc<RuntimeBindingStore>,
    /// Which provider process runs each session, which every driver records at spawn and exit
    /// and the run queue reads.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The names every provider sets on its processes, which no environment row may set, for the
    /// terminals' shells too.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// Every provider's background work, which the permission check refuses too.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The staged reviews' worktrees, whose leftovers the start sweeps before the socket binds.
    staged_changes: StagedChangesWorktrees,
}

/// Builds the driver of every provider in `registrations`, in its order, over the one bundle of
/// shared services, with every port unregistered, and starts the capability refresh over them, no
/// pass asked yet. Builds start no process and do no I/O; called inside the daemon's runtime,
/// which the refresh's task runs on.
pub(crate) fn build_providers(
    registrations: &[ProviderRegistration],
    start: ProviderStart,
) -> Providers {
    let ports = Arc::new(DriverPorts::new());
    let descriptors: Vec<&'static ProviderDescriptor> = registrations
        .iter()
        .map(|registration| registration.descriptor)
        .collect();
    let reserved_names = Arc::new(ReservedEnvironmentNames::of_providers(&descriptors));
    let background_work = Arc::new(BackgroundWorkForms::of_providers(&descriptors));
    let processes = Arc::new(ProviderProcessRegistry::default());
    let provider_services = Arc::new(ProviderServiceProcesses::default());
    let staged_changes =
        StagedChangesWorktrees::new(&worktrees_folder(&start.home_folder), start.git);
    let execution_postures = Arc::new(ExecutionPostureService::new(
        &start.home_folder,
        start.session_token_path,
    ));
    let runtime_bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&start.reads),
        Arc::clone(&start.writer),
    ));
    let services = DriverServices {
        spawner: start.spawner.clone(),
        data_folder: start.data_folder,
        home_folder: start.home_folder.clone(),
        pool: Arc::clone(&start.reads),
        attachments: start.attachments,
        staged_changes: staged_changes.clone(),
        execution_postures: Arc::clone(&execution_postures),
        base_environment: start.base_environment,
        reserved_names: Arc::clone(&reserved_names),
        command_search: Arc::new(ProviderCommandSearch::new(start.spawner.clone())),
        pending_compactions: PendingCompactionRegistry::default(),
        processes: Arc::clone(&processes),
        provider_services: Arc::clone(&provider_services),
        runtime_bindings: Arc::clone(&runtime_bindings) as _,
        shell_lines: start.shell_lines,
        background_work: Arc::clone(&background_work),
        dispatches_hook_mode: dispatches_hook_mode(),
        caller_processes: start.caller_processes,
        input_waits: Arc::new(SystemInputWaitReader {
            spawner: start.spawner,
        }),
        ports: Arc::clone(&ports),
    };
    let registry = Arc::new(ProviderRegistry::register_from(registrations, &services));
    let capabilities = Arc::new(DriverCapabilitiesWriter::new(start.reads, start.writer));
    let (refresher, refreshing) =
        CapabilityRefresher::start(Arc::clone(&registry), Arc::clone(&capabilities));
    Providers {
        registry,
        ports,
        refresher: Arc::new(refresher),
        capabilities,
        refreshing,
        provider_services,
        execution_postures,
        runtime_bindings,
        processes,
        reserved_names,
        background_work,
        staged_changes,
    }
}

/// Records on the registry each provider's last stored capability reading, without asking its
/// driver, so a gated call is answered from it before the first refresh lands; a provider never
/// read, or read with no version, stays refused until then. A stored reading that cannot be
/// rebuilt is reported as a driver diagnostic and its provider's gate stays closed.
pub(crate) async fn hydrate_capabilities(providers: &Providers) {
    for (provider, _) in providers.registry.drivers() {
        let descriptor = providers
            .registry
            .descriptor(provider)
            .expect("a provider the registry lists has a descriptor");
        match providers.capabilities.hydrate(provider, descriptor).await {
            Ok(CapabilityHydration::Hit { result }) => providers
                .registry
                .record_capabilities(provider, result.capabilities)
                .expect("a provider the registry lists has an entry"),
            Ok(
                CapabilityHydration::NeverWritten {} | CapabilityHydration::CliVersionMissing {},
            ) => {}
            Err(error) => emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: provider.clone(),
                provider_account_id: None,
                kind: DriverDiagnosticKind::StoredCapabilitiesUnreadable,
                raw_wire_type: None,
                disposition_reason: "stored capability reading could not be rebuilt; gated calls \
                                     wait for the first refresh"
                    .to_owned(),
                details: Map::from_iter([(
                    "message".to_owned(),
                    Value::from(describe_error(&error)),
                )]),
            }),
        }
    }
}

/// The services behind the drivers' ports, each built after the drivers.
pub(crate) struct DriverPortOwners {
    /// The run engine.
    pub(crate) run_engine: Arc<RunEngine>,
    /// The run engine's dispatch of what a provider delivers.
    pub(crate) inbound_dispatch: Arc<RunInboundDispatch>,
    /// The run queue's admission, which opens the binding of a turn the daemon starts.
    pub(crate) queue_admission: Arc<QueueAdmission>,
    /// The run queue's delivery, which hears of each message a provider took, refused or gave
    /// back, and holds the messages waiting for paused runs.
    pub(crate) queue_delivery: QueueDelivery,
    /// The run queue's intake of a session's provider process that ended.
    pub(crate) process_gone: Arc<dyn ProcessGoneListener>,
    /// The approval pipeline's permission asks.
    pub(crate) permission_asks: Arc<PermissionAsks>,
    /// The questions card's service.
    pub(crate) questions: Arc<QuestionsService>,
    /// The plan record's service.
    pub(crate) plans: Arc<PlansService>,
    /// The approval pipeline's reviewer blocks.
    pub(crate) reviewer_denials: Arc<ReviewerDenials>,
    /// The database writer, which records the advisor a provider resolved for a session and which
    /// the drivers store their measured limits through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The rules in force on each session.
    pub(crate) approval_rules: Arc<ApprovalRules>,
    /// The places the daemon runs sessions in.
    pub(crate) session_places: Arc<[SessionPlace]>,
    /// The one callback-tool dispatcher.
    pub(crate) callback_tool_host: Arc<CallbackToolHost>,
    /// The pause and continue of runs.
    pub(crate) run_pauses: Arc<RunPauseControl>,
    /// The usage record, which meters each provider reading and stops a run at its token limit.
    pub(crate) usage: Arc<UsageRecord>,
    /// Every session's running commands, which each driver reports its agent's commands to.
    pub(crate) running_commands: Arc<RunningCommandSets>,
    /// Each run's latest turn readings.
    pub(crate) turn_readings: Arc<TurnReadings>,
    /// Each session's latest context reading.
    pub(crate) context_readings: Arc<ContextReadings>,
    /// The idle sleep, which wakes a sleeping session for a message.
    pub(crate) idle_sleep: Arc<SessionIdleSleep>,
    /// The stored resume of a sleeping session a driver holds nothing for.
    pub(crate) session_resumes: Arc<StoredSessionResumes>,
}

/// The places the daemon runs sessions in: this computer's own system alone, its login shell's
/// environment `base_environment` and the current user's id.
#[expect(
    dead_code,
    reason = "the daemon's start registers the session places through it"
)]
pub(crate) fn native_session_places(base_environment: &[(String, String)]) -> Arc<[SessionPlace]> {
    Arc::from([SessionPlace {
        place: None,
        login_shell: base_environment.to_vec(),
        user_id: current_user_id(),
    }])
}

/// Registers each port whose owner is built, once, the run engine, its dispatch and the queue's
/// turn bindings first, so they stand before any driver call. Fails when a port is registered
/// already, which only a second call does.
#[expect(
    dead_code,
    reason = "the daemon's start registers the ports through it"
)]
pub(crate) fn register_driver_ports(
    ports: &DriverPorts,
    owners: DriverPortOwners,
) -> Result<(), PortRegistrationError> {
    ports.run_engine.register(owners.run_engine)?;
    ports.inbound_dispatch.register(owners.inbound_dispatch)?;
    ports
        .daemon_turn_bindings
        .register(owners.queue_admission)?;
    let queue_delivery = Arc::new(owners.queue_delivery);
    ports
        .message_taken
        .register(Arc::clone(&queue_delivery) as _)?;
    ports
        .message_refused
        .register(Arc::clone(&queue_delivery) as _)?;
    ports
        .message_given_back
        .register(Arc::clone(&queue_delivery) as _)?;
    ports.continued_messages.register(queue_delivery)?;
    ports.process_gone.register(owners.process_gone)?;
    ports.permission_asks.register(owners.permission_asks)?;
    ports.questions.register(owners.questions)?;
    ports.plans.register(owners.plans)?;
    ports.reviewer_denials.register(owners.reviewer_denials)?;
    ports.usage.register(owners.usage)?;
    ports.command_output.register(owners.running_commands)?;
    ports.turn_readings.register(owners.turn_readings)?;
    ports.context_readings.register(owners.context_readings)?;
    ports.session_wakes.register(owners.idle_sleep)?;
    ports.session_resumes.register(owners.session_resumes)?;
    ports.database_writer.register(Arc::clone(&owners.writer))?;
    ports
        .session_advisors
        .register(Arc::new(ConsoleStateAdvisors(owners.writer)))?;
    ports.session_rules.register(owners.approval_rules)?;
    ports.session_places.register(owners.session_places)?;
    ports
        .callback_tool_host
        .register(owners.callback_tool_host)?;
    ports.run_pauses.register(owners.run_pauses)
}

/// Why no session's inbox addresses can be composed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionInboxAddressesError {
    /// No registered driver's sessions answer an inbox.
    #[error("no registered provider's sessions answer an inbox")]
    NoAddresser,
    /// A place the daemon runs sessions in is not one this computer's system holds.
    #[error(transparent)]
    ForeignPlace(#[from] ForeignPlaceError),
}

/// The inbox addresses of every session, answered by the first driver in the table's order whose
/// sessions answer an inbox, in each of `session_places`; this computer has no WSL 2 distribution.
/// Fails when no driver answers one, or a place is foreign to this computer's system.
#[expect(
    dead_code,
    reason = "the daemon's start builds session.read's addresses \
              through it"
)]
pub(crate) fn compose_session_inbox_addresses(
    registry: &ProviderRegistry,
    session_places: &[SessionPlace],
) -> Result<SessionInboxAddresses, SessionInboxAddressesError> {
    let addresser = registry
        .drivers()
        .find_map(|(_, driver)| driver.session_inbox_addresser())
        .ok_or(SessionInboxAddressesError::NoAddresser)?;
    let installed_places = session_places
        .iter()
        .map(|session_place| session_place.place.clone())
        .collect();
    Ok(SessionInboxAddresses::new(
        PathRules::NATIVE,
        installed_places,
        false,
        addresser,
    )?)
}

/// Removes the staged reviews' worktrees a stopped daemon left, before any call can open one, each
/// failure logged.
pub(crate) async fn sweep_left_staged_worktrees(providers: &Providers) {
    for failure in providers.staged_changes.sweep_left_worktrees().await {
        tracing::warn!(
            error = &failure as &(dyn std::error::Error + 'static),
            "a staged-review worktree a previous run left was not removed"
        );
    }
}

/// The providers' registration running on its own task, which the start waits for before the run
/// queue's recovery and the stop ends before the drivers.
pub(crate) struct ProvidersRegistration {
    /// The task, until it is seen to end; dropped, it ends the task.
    task: Option<AbortOnDropHandle<()>>,
}

/// Why the providers' registration did not end cleanly at the stop.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProvidersRegistrationStopFailure {
    /// It ran past what was left of the drain bound, so it was ended where it stood.
    #[error("the providers' registration did not end within {0:?} and was ended")]
    Aborted(Duration),
    /// Its task panicked.
    #[error("the providers' registration ended abnormally")]
    Ended(#[source] JoinError),
}

impl ProvidersRegistration {
    /// Waits until every driver's first read landed, failed or missed its deadline and every row
    /// value was applied; at once when it ended already. Fails when its task panicked.
    pub(crate) async fn finished(&mut self) -> Result<(), JoinError> {
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        let ended = task.await;
        self.task = None;
        ended
    }

    /// Lets the registration end within `remaining`, else ends it where it stands, so no read it
    /// started outlives the stop; called after the capability refresh stopped and before the
    /// drivers shut down. Fails as [`ProvidersRegistrationStopFailure`] says.
    pub(crate) async fn stop(
        mut self,
        remaining: Duration,
    ) -> Result<(), ProvidersRegistrationStopFailure> {
        let Some(mut task) = self.task.take() else {
            return Ok(());
        };
        if let Ok(ended) = tokio::time::timeout(remaining, &mut task).await {
            return ended.map_err(ProvidersRegistrationStopFailure::Ended);
        }
        task.abort();
        match task.await {
            Err(error) if error.is_cancelled() => {
                Err(ProvidersRegistrationStopFailure::Aborted(remaining))
            }
            ended => ended.map_err(ProvidersRegistrationStopFailure::Ended),
        }
    }
}

/// Starts the providers' registration on its own task, not awaited: once `index_opened` settles,
/// every driver's capabilities are read, declared and recorded at once, a provider with a lasting
/// service connecting to it in its read, then each driver's Settings rows take their values, each
/// one `settings_file` stores over the driver's default. It ends once every read landed, failed or
/// missed its deadline and every value was applied, or, applying none, once the refresh stopped
/// before the reads; a failure is logged, never returned. Dropping the handle ends it. A value
/// changed later is applied by the provider settings' update, through the same driver call.
pub(crate) fn register_providers(
    providers: &Providers,
    index_opened: impl Future<Output = ()> + Send + 'static,
    settings_file: Arc<MachineSettingsFile>,
) -> ProvidersRegistration {
    let refresher = Arc::clone(&providers.refresher);
    let registry = Arc::clone(&providers.registry);
    let task = tokio::spawn(async move {
        index_opened.await;
        if !refresher.refresh_now().await {
            tracing::warn!(
                "the capability refresh ended before the providers' first reads, so no row value \
                 is applied"
            );
            return;
        }
        match settings_file.read().await {
            Ok(reading) => apply_row_values(&registry, &reading.settings.provider_settings).await,
            Err(error) => tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "the providers' stored settings could not be read, so none was applied"
            ),
        }
    });
    ProvidersRegistration {
        task: Some(AbortOnDropHandle::new(task)),
    }
}

// Applies to every driver its rows' values, all drivers at once: each value `stored` holds for a
// row over the driver's default for it, place by place.
async fn apply_row_values(registry: &ProviderRegistry, stored: &ProviderSettingValues) {
    join_all(registry.drivers().map(|(provider, driver)| async move {
        let stored_rows = stored
            .as_map()
            .get(provider)
            .map(|rows| rows.as_map().clone())
            .unwrap_or_default();
        let mut defaults = driver.row_defaults().into_map();
        let row_ids: BTreeSet<ProviderDeclarationId> =
            defaults.keys().chain(stored_rows.keys()).cloned().collect();
        for row_id in row_ids {
            let mut values = defaults
                .remove(&row_id)
                .map(placed_values)
                .unwrap_or_default();
            let stored_row = stored_rows.get(&row_id).cloned();
            for (place, value) in stored_row.map(placed_values).unwrap_or_default() {
                match values.iter_mut().find(|(placed, _)| *placed == place) {
                    Some(placed) => placed.1 = value,
                    None => values.push((place, value)),
                }
            }
            for (place, value) in values {
                let applied = driver
                    .apply_row_value(ApplyRowValueParams {
                        row_id: row_id.clone(),
                        place,
                        value,
                    })
                    .await;
                if let Err(error) = applied {
                    report_row_apply_failure(provider, &row_id, &error);
                }
            }
        }
    }))
    .await;
}

// A row's value as each place's value: a switch's entry in each place it names, else one value
// naming no place.
fn placed_values(value: ProviderRowValue) -> Vec<(Option<Place>, Option<ProviderValue>)> {
    match value {
        ProviderRowValue::Places(switches) => switches
            .as_slice()
            .iter()
            .map(|switch| {
                (
                    switch.place.clone(),
                    Some(ProviderValue::Switch(switch.enabled)),
                )
            })
            .collect(),
        ProviderRowValue::Value(text) => vec![(None, text.map(ProviderValue::Text))],
    }
}

fn report_row_apply_failure(
    provider: &ProviderId,
    row_id: &ProviderDeclarationId,
    error: &DriverError,
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: provider.clone(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::SettingsRowApplyFailed,
        raw_wire_type: None,
        disposition_reason: "settings row value not applied at the start; applied again at the \
                             next change"
            .to_owned(),
        details: Map::from_iter([
            ("rowId".to_owned(), Value::from(row_id.as_str())),
            ("message".to_owned(), Value::from(describe_error(error))),
        ]),
    });
}

/// Ends every driver's work for `intent`, all at once, and answers each driver's failure, in the
/// table's order.
pub(crate) async fn shut_down_drivers(
    registry: &ProviderRegistry,
    intent: DaemonStopIntent,
) -> Vec<DriverError> {
    futures::future::join_all(
        registry
            .drivers()
            .map(|(_, driver)| driver.shutdown(intent)),
    )
    .await
    .into_iter()
    .filter_map(Result::err)
    .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use sidekicks_contracts::machine::settings::{
        MachineSettings, ProviderRowValue, ProviderRowValues,
    };
    use sidekicks_contracts::provider::declaration::{
        ProviderDeclarationId, ProviderPlaceSwitch, ProviderPlaceSwitches, ProviderValue,
    };
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::record::Record;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
    use sidekicks_platforms::Spawner;
    use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
    use sidekicks_provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::contract::params_and_results::{
        ApplyRowValueParams, DriverCliVersionReport, GetCapabilitiesResult,
    };
    use sidekicks_provider::driver::test_registry::{
        NothingServed, registrations_of_first_providers,
    };
    use sidekicks_provider::driver::{PROVIDERS, ProviderRegistration};
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_fixture::open_log;
    use sidekicks_workspace::git::process::{GitLimits, GitRunner};
    use tempfile::TempDir;
    use tokio::runtime::Handle;

    use super::{
        ProviderStart, Providers, build_providers, hydrate_capabilities, register_providers,
    };
    use crate::daemon::machine_settings::file::MachineSettingsFile;
    use crate::daemon::schema::schema_parts;

    /// The statements the tests' read pool caches.
    const READ_STATEMENT_CAPACITY: usize = 16;

    /// The most line bytes the tests' bound lets the shell-line reader parse at once.
    const SHELL_LINE_LIMIT: usize = 1 << 20;

    /// The database and the home folder a test's providers are built on.
    struct TestStart {
        database: TestDatabase,
        home: TempDir,
    }

    impl TestStart {
        fn new() -> Self {
            Self {
                database: TestDatabase::new(schema_parts()),
                home: tempfile::tempdir().expect("the test makes a home folder"),
            }
        }

        /// The providers of `registrations`, built as the daemon's start builds them, on this
        /// start's database and home.
        async fn build(&self, registrations: &[ProviderRegistration]) -> Providers {
            let log = open_log(&self.database, None).await;
            let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
            let base_environment: Arc<[(String, String)]> = Arc::from([]);
            build_providers(
                registrations,
                ProviderStart {
                    spawner: spawner.clone(),
                    data_folder: self.home.path().join("data"),
                    home_folder: self.home.path().to_owned(),
                    session_token_path: self.home.path().join("daemon.token"),
                    reads: Arc::new(DatabaseReadPool::new(
                        self.database.path(),
                        READ_STATEMENT_CAPACITY,
                    )),
                    writer: Arc::clone(&log.writer),
                    attachments: Arc::new(NothingServed),
                    git: GitRunner::new(
                        spawner,
                        None,
                        Arc::clone(&base_environment),
                        GitLimits::DAEMON,
                    ),
                    base_environment,
                    shell_lines: Arc::new(ShellLineReadingBound::new(SHELL_LINE_LIMIT)),
                    caller_processes: Arc::new(
                        ProcessTableReader::for_this_program()
                            .expect("this program's reader builds"),
                    ),
                },
            )
        }
    }

    // A gated call the stored reading allows passes at a cold start, before any refresh pass has
    // read the driver. Killed by leaving the gate unseeded, which refuses it until a pass lands.
    #[tokio::test]
    async fn a_cold_start_answers_a_gated_call_from_the_stored_reading() {
        let start = TestStart::new();
        let providers = start
            .build(&registrations_of_first_providers(vec![Arc::new(
                MockProviderDriver::new(),
            )]))
            .await;
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
        let stored = GetCapabilitiesResult {
            capabilities: DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    flag == DriverCapabilityFlag::ContextCompaction
                }),
                contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a version"),
            },
            tools: Vec::new(),
            cli_version: DriverCliVersionReport {
                raw_version: "2.0.0".to_owned(),
                parsed_version: Some("2.0.0".to_owned()),
            },
            detection_source: None,
            output_speed_levels: None,
        };
        providers
            .capabilities
            .declare(&provider, &stored)
            .await
            .expect("an earlier run stored the reading");
        let before_seed = providers
            .registry
            .check_capability(&provider, DriverCapabilityFlag::ContextCompaction);

        hydrate_capabilities(&providers).await;

        assert!(before_seed.is_err());
        providers
            .registry
            .check_capability(&provider, DriverCapabilityFlag::ContextCompaction)
            .expect("the stored reading allows the call");
        assert!(
            providers
                .registry
                .check_capability(&provider, DriverCapabilityFlag::Steer)
                .is_err()
        );
    }

    fn row_id(id: &str) -> ProviderDeclarationId {
        ProviderDeclarationId::new(id.to_owned()).expect("a test row id")
    }

    fn switch_row(enabled: bool) -> ProviderRowValue {
        ProviderRowValue::Places(
            ProviderPlaceSwitches::new(vec![ProviderPlaceSwitch {
                place: None,
                enabled,
            }])
            .expect("one place is within the bounds"),
        )
    }

    fn rows(values: Vec<(&str, ProviderRowValue)>) -> ProviderRowValues {
        Record::new(
            values
                .into_iter()
                .map(|(id, value)| (row_id(id), value))
                .collect::<BTreeMap<_, _>>(),
        )
        .expect("no test row is the prototype key")
    }

    // The registration applies each row's value once the first reads ran: the driver's default
    // where the app stored none, the stored value over it where it did. Killed by leaving the
    // replay out, which applies nothing, or by applying the defaults alone.
    #[tokio::test]
    async fn the_registration_applies_each_rows_stored_value_over_the_drivers_default() {
        let start = TestStart::new();
        let applied = Arc::new(Mutex::new(Vec::new()));
        let mut driver = MockProviderDriver::new();
        driver.expect_get_capabilities().returning(|| {
            async { Err(DriverError::Internal("no read in the test".into())) }.boxed()
        });
        driver.expect_row_defaults().returning(|| {
            rows(vec![
                ("reach", switch_row(true)),
                ("style", switch_row(true)),
            ])
        });
        let applying = Arc::clone(&applied);
        driver
            .expect_apply_row_value()
            .returning(move |params: ApplyRowValueParams| {
                lock(&applying).push((
                    params.row_id.as_str().to_owned(),
                    params.place,
                    params.value,
                ));
                async { Ok(()) }.boxed()
            });
        let providers = start
            .build(&registrations_of_first_providers(vec![Arc::new(driver)]))
            .await;
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
        let settings_path = start.home.path().join("machine-settings.json");
        let settings = MachineSettings {
            provider_settings: Record::new(BTreeMap::from([(
                provider,
                rows(vec![("style", switch_row(false))]),
            )]))
            .expect("no provider id is the prototype key"),
            ..MachineSettings::default()
        };
        std::fs::write(
            &settings_path,
            serde_json::to_vec(&settings).expect("the settings serialize"),
        )
        .expect("the test stores the settings");

        register_providers(
            &providers,
            async {},
            Arc::new(MachineSettingsFile::new(settings_path)),
        )
        .finished()
        .await
        .expect("the registration ends");

        assert_eq!(
            *lock(&applied),
            [
                ("reach".to_owned(), None, Some(ProviderValue::Switch(true))),
                ("style".to_owned(), None, Some(ProviderValue::Switch(false))),
            ]
        );
    }
}
