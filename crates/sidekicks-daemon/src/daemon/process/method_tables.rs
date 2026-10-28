//! The serving socket's methods and the gates in front of them: every table registered once, by
//! its owner, then, over the frozen registry, the chain a call passes through, the handshake's gate
//! first and the registry last.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{Dispatch, MethodRegistry, MethodRegistryBuilder, RegistrationError};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_recovery::damaged_history::DamagedHistory;
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_recovery::write_gate::RecoveryWriteGate;
use sidekicks_session::addresses::SessionInboxAddresses;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::draft_store::SessionDraftStore;
use sidekicks_session::links::service::SessionLinkService;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_session::service::SessionService;
use sidekicks_session::staged_attachments::StagedAttachments;
use sidekicks_session::tags::SessionTagService;
use sidekicks_shell::input_lookup::ShellInputLookup;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_workspace::git::worktree::branch_list::BranchListReader;
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;

use crate::daemon::app_diagnostic_methods::register_app_diagnostic_methods;
use crate::daemon::backup::methods::{BackupMethodsDeps, register_backup_methods};
use crate::daemon::config_methods::{ConfigMethodsDeps, register_config_methods};
use crate::daemon::crash::methods::register_crash_methods;
use crate::daemon::data_methods::{DataMethodsDeps, register_data_methods};
use crate::daemon::lifecycle_methods::{LifecycleMethodsDeps, register_lifecycle_methods};
use crate::daemon::machine_settings::methods::{
    MachineSettingsMethodsDeps, register_machine_settings_methods,
};
use crate::daemon::process::damage_gate::{DamageReportGate, DispatchDamageWatch};
use crate::daemon::process::jobs::IdleMemoryCollect;
use crate::daemon::retention_methods::{RetentionMethodsDeps, register_retention_methods};
use crate::daemon::status_methods::{StatusMethodsDeps, register_status_methods};
use crate::highlight::colorer::CodeHighlighter;
use crate::ipc::handlers::agent::command::{CommandMethodSources, register_command_methods};
use crate::ipc::handlers::agent::turn::register_turn_methods;
use crate::ipc::handlers::approval::{ApprovalMethodSources, register_approval_methods};
use crate::ipc::handlers::driver::{DriverMethodSources, register_driver_methods};
use crate::ipc::handlers::highlight::register_highlight_read;
use crate::ipc::handlers::question::register_question_resolve;
use crate::ipc::handlers::repo::branches::register_repo_branches;
use crate::ipc::handlers::repo::working_folder::register_working_folder;
use crate::ipc::handlers::run::control::{RunControlServices, register_run_control};
use crate::ipc::handlers::run::queue::{RunQueueMethods, register_run_queue};
use crate::ipc::handlers::run::safety_holds::RunSafetyHolds;
use crate::ipc::handlers::run::state::register_run_state_subscribe;
use crate::ipc::handlers::session::context::register_context_subscribe;
use crate::ipc::handlers::session::draft_update::register_session_draft_update;
use crate::ipc::handlers::session::event_subscribe::register_session_event_subscribe;
use crate::ipc::handlers::session::links::register_session_links;
use crate::ipc::handlers::session::list::register_session_list;
use crate::ipc::handlers::session::read::register_session_read;
use crate::ipc::handlers::session::recovery::register_session_recovery_methods;
use crate::ipc::handlers::session::restart::{RestartTargetReader, register_session_restart};
use crate::ipc::handlers::session::tags::register_session_tags;
use crate::ipc::handlers::terminal::register_terminal_write;
use crate::ipc::handlers::transcript::register_transcript_reads;

/// Every service the method tables take, each table's own inputs where its owner bundles them.
pub(crate) struct MethodTableServices {
    /// The status read's inputs.
    pub(crate) status: StatusMethodsDeps,
    /// The lifecycle verbs' inputs: the flush and the stop's acceptance.
    pub(crate) lifecycle: LifecycleMethodsDeps,
    /// The retention methods' inputs.
    pub(crate) retention: RetentionMethodsDeps,
    /// The backup methods' inputs.
    pub(crate) backups: BackupMethodsDeps,
    /// The configuration methods' inputs.
    pub(crate) config: ConfigMethodsDeps,
    /// The machine settings methods' inputs.
    pub(crate) machine_settings: MachineSettingsMethodsDeps,
    /// The data export and erase methods' inputs.
    pub(crate) data: DataMethodsDeps,
    /// The daemon's data folder, whose crash reports the crash methods read.
    pub(crate) data_folder: PathBuf,
    /// The driver methods' sources.
    pub(crate) driver_methods: Arc<DriverMethodSources>,
    /// The approval methods' sources.
    pub(crate) approval_methods: Arc<ApprovalMethodSources>,
    /// The run control methods' services.
    pub(crate) run_control: RunControlServices,
    /// The run queue methods' inputs.
    pub(crate) run_queue: RunQueueMethods,
    /// The command methods' sources.
    pub(crate) command_methods: Arc<CommandMethodSources>,
    /// Each run's latest turn readings, which the turn subscriptions follow.
    pub(crate) turn_readings: Arc<TurnReadings>,
    /// Each session's latest context reading, which the context subscription follows.
    pub(crate) context_readings: Arc<ContextReadings>,
    /// Every driver, which a session's restart goes through.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Reads where a session's restart lands.
    pub(crate) restart_targets: RestartTargetReader,
    /// The read pool a session's restart reads the session's state through.
    pub(crate) restart_state_pool: Arc<DatabaseReadPool>,
    /// The session-wide transition lock a session's restart runs under.
    pub(crate) session_transition_lock: Arc<KeyedLock<SessionId>>,
    /// The event log, which the session and run-state subscriptions read.
    pub(crate) event_log: Arc<EventLogService>,
    /// Each session's live safety holds.
    pub(crate) run_safety_holds: Arc<RunSafetyHolds>,
    /// The sessions, read by `session.read` and the transcript reads.
    pub(crate) sessions: Arc<SessionService>,
    /// Each session's draft.
    pub(crate) drafts: Arc<SessionDraftStore>,
    /// The files staged for each session.
    pub(crate) staged_attachments: Arc<dyn StagedAttachments>,
    /// Each session's inbox addresses.
    pub(crate) inbox_addresses: Arc<SessionInboxAddresses>,
    /// Each session's tags.
    pub(crate) tags: Arc<SessionTagService>,
    /// The links between sessions.
    pub(crate) links: Arc<SessionLinkService>,
    /// The ranking of a session's related sessions.
    pub(crate) related_ranking: Arc<SessionRelatedRanking>,
    /// The session list's feed.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The questions card's service.
    pub(crate) questions: Arc<QuestionsService>,
    /// The sessions whose history is damaged.
    pub(crate) damaged_history: Arc<DamagedHistory>,
    /// The session search index.
    pub(crate) search_index: Arc<LiveIndex>,
    /// The code highlighter.
    pub(crate) highlighter: Arc<CodeHighlighter>,
    /// Finds the shell a terminal write goes to.
    pub(crate) shell_inputs: ShellInputLookup,
    /// Lists a repository's branches.
    pub(crate) branches: Arc<BranchListReader>,
    /// Follows a session's working folder.
    pub(crate) working_folders: Arc<WorkingFolderWatcher>,
}

/// Registers every method table on `builder`, each once, grouped by owner: the daemon's own, its
/// data, the drivers, the approvals, the runs and their agents' commands and turns, the sessions,
/// the repositories. The handshake, the subscriptions' cancel and the artifact store's table are
/// registered by the start beside them. Fails when a method is registered twice.
#[expect(
    dead_code,
    reason = "the daemon's start registers the tables through it"
)]
pub(crate) fn register_method_tables(
    builder: &mut MethodRegistryBuilder,
    services: MethodTableServices,
) -> Result<(), RegistrationError> {
    register_status_methods(builder, services.status)?;
    register_lifecycle_methods(builder, &services.lifecycle)?;
    register_app_diagnostic_methods(builder)?;
    register_crash_methods(builder, services.data_folder)?;
    register_config_methods(builder, services.config)?;
    register_machine_settings_methods(builder, services.machine_settings)?;
    register_backup_methods(builder, services.backups)?;
    register_retention_methods(builder, services.retention)?;
    register_data_methods(builder, services.data)?;
    register_driver_methods(builder, &services.driver_methods)?;
    register_approval_methods(builder, &services.approval_methods)?;
    register_run_control(builder, &services.run_control)?;
    register_run_queue(builder, &services.run_queue)?;
    register_command_methods(builder, &services.command_methods)?;
    register_turn_methods(builder, &services.turn_readings)?;
    register_run_state_subscribe(
        builder,
        Arc::clone(&services.event_log),
        services.run_safety_holds,
    )?;
    register_session_read(
        builder,
        Arc::clone(&services.sessions),
        Arc::clone(&services.drafts),
        services.staged_attachments,
        services.inbox_addresses,
    )?;
    register_transcript_reads(builder, services.sessions, services.search_index)?;
    register_session_list(builder, services.list_feed)?;
    register_session_event_subscribe(builder, services.event_log, Arc::clone(&services.providers))?;
    register_session_draft_update(builder, services.drafts)?;
    register_session_tags(builder, services.tags)?;
    register_session_links(builder, services.links, services.related_ranking)?;
    register_context_subscribe(builder, services.context_readings)?;
    register_session_restart(
        builder,
        services.providers,
        services.restart_targets,
        services.restart_state_pool,
        services.session_transition_lock,
    )?;
    register_session_recovery_methods(builder, services.damaged_history)?;
    register_question_resolve(builder, services.questions)?;
    register_highlight_read(builder, services.highlighter)?;
    register_terminal_write(builder, services.shell_inputs)?;
    register_repo_branches(builder, services.branches)?;
    register_working_folder(builder, services.working_folders)
}

/// The chain a call on the serving socket passes through, and its gate that records mutating calls,
/// which the flush and the stop wait on.
pub(crate) struct GateChain {
    /// The outermost gate, which the gateway dispatches every call to.
    pub(crate) dispatch: Arc<dyn Dispatch>,
    /// The gate that records every mutating call while it runs.
    pub(crate) in_flight: Arc<InFlightMutations>,
}

/// Builds, over the frozen `registry`, the chain a call passes: the handshake's gate, then the
/// recovery's write gate, then the record of mutating calls, then the damage report, then the
/// registry, so a refused call is never recorded, every failure a handler answers reaches
/// `damage`, and `idle_memory` waits while any call runs.
pub(crate) fn gate_chain(
    negotiator: &Arc<ProtocolNegotiator>,
    registry: &Arc<MethodRegistry>,
    status: Arc<RecoveryStatusTracker>,
    damage: DispatchDamageWatch,
    idle_memory: &Arc<IdleMemoryCollect>,
) -> GateChain {
    let damage_reports: Arc<dyn Dispatch> = Arc::new(DamageReportGate::new(
        Arc::clone(registry) as Arc<dyn Dispatch>,
        damage,
        Arc::clone(idle_memory),
    ));
    let in_flight = Arc::new(InFlightMutations::new(damage_reports, Arc::clone(registry)));
    let write_gate: Arc<dyn Dispatch> = Arc::new(RecoveryWriteGate::new(
        Arc::clone(&in_flight) as Arc<dyn Dispatch>,
        Arc::clone(registry),
        status,
    ));
    GateChain {
        dispatch: Arc::new(negotiator.gate(write_gate, Arc::clone(registry))),
        in_flight,
    }
}
