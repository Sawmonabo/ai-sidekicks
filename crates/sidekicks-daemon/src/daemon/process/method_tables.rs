//! The serving socket's methods and the gates in front of them: every table registered once, by
//! its owner, then, over the frozen registry, the chain a call passes through, the handshake's gate
//! first and the registry last.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{Dispatch, MethodRegistry, MethodRegistryBuilder, RegistrationError};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_recovery::damaged_history::DamagedHistory;
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_recovery::write_gate::RecoveryWriteGate;
use sidekicks_session::attention::service::AttentionService;
use sidekicks_session::changes::SessionChanges;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::draft_store::SessionDraftStore;
use sidekicks_session::groups::service::SessionGroupService;
use sidekicks_session::links::service::SessionLinkService;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::review_note::store::SessionReviewNoteStore;
use sidekicks_session::service::SessionService;
use sidekicks_session::tags::SessionTagService;
use sidekicks_shell::table::ShellTable;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_workspace::clone::service::CloneService;
use sidekicks_workspace::folder::list::FolderListService;
use sidekicks_workspace::git::worktree::branch_list::BranchListReader;
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::service::ProjectService;

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
use crate::ipc::handlers::attention::register_attention_methods;
use crate::ipc::handlers::driver::{DriverMethodSources, register_driver_methods};
use crate::ipc::handlers::highlight::register_highlight_read;
use crate::ipc::handlers::machine::folder::register_machine_folders;
use crate::ipc::handlers::presence::register_presence_methods;
use crate::ipc::handlers::project::clone::register_project_clone_methods;
use crate::ipc::handlers::project::register_project_methods;
use crate::ipc::handlers::question::register_question_resolve;
use crate::ipc::handlers::repo::branches::register_repo_branches;
use crate::ipc::handlers::repo::working_folder::register_working_folder;
use crate::ipc::handlers::run::control::{RunControlServices, register_run_control};
use crate::ipc::handlers::run::queue::{RunQueueMethods, register_run_queue};
use crate::ipc::handlers::run::safety_holds::RunSafetyHolds;
use crate::ipc::handlers::run::state::register_run_state_subscribe;
use crate::ipc::handlers::session::changes::register_session_changes;
use crate::ipc::handlers::session::context::register_context_subscribe;
use crate::ipc::handlers::session::controls::{SessionControlMethods, register_session_controls};
use crate::ipc::handlers::session::draft_update::register_session_draft_update;
use crate::ipc::handlers::session::event_subscribe::register_session_event_subscribe;
use crate::ipc::handlers::session::group::register_session_groups;
use crate::ipc::handlers::session::links::register_session_links;
use crate::ipc::handlers::session::list::register_session_list;
use crate::ipc::handlers::session::recovery::register_session_recovery_methods;
use crate::ipc::handlers::session::restart::register_session_restart;
use crate::ipc::handlers::session::review_note::register_session_review_notes;
use crate::ipc::handlers::session::search::{SessionSearchMethods, register_session_search};
use crate::ipc::handlers::session::tags::register_session_tags;
use crate::ipc::handlers::terminal::{register_terminal_methods, register_terminal_write};
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
    /// Every driver, which the session event subscription reads each provider's descriptor from.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The event log, which the session and run-state subscriptions read.
    pub(crate) event_log: Arc<EventLogService>,
    /// Each session's live safety holds.
    pub(crate) run_safety_holds: Arc<RunSafetyHolds>,
    /// The sessions, which the transcript reads go through.
    pub(crate) sessions: Arc<SessionService>,
    /// Each session's draft.
    pub(crate) drafts: Arc<SessionDraftStore>,
    /// Each session's tags.
    pub(crate) tags: Arc<SessionTagService>,
    /// The project sessions' named groups.
    pub(crate) session_groups: Arc<SessionGroupService>,
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
    /// The code highlighter.
    pub(crate) highlighter: Arc<CodeHighlighter>,
    /// Each session's shells, which the terminal methods open, follow, write to and close.
    pub(crate) shells: Arc<ShellTable>,
    /// The sessions' renames and name pushes.
    pub(crate) session_changes: Arc<SessionChanges>,
    /// Each session's review notes.
    pub(crate) review_notes: Arc<SessionReviewNoteStore>,
    /// The session and file search methods' inputs.
    pub(crate) session_search: SessionSearchMethods,
    /// The session controls' inputs: the level, the mode, side questions, reviews and the
    /// command list.
    pub(crate) session_controls: SessionControlMethods,
    /// Lists a repository's branches.
    pub(crate) branches: Arc<BranchListReader>,
    /// Follows a session's working folder.
    pub(crate) working_folders: Arc<WorkingFolderWatcher>,
    /// The projects' edits.
    pub(crate) projects: Arc<ProjectService>,
    /// The live projects list.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
    /// The clones into projects, or why the clone service could not start, which each clone verb
    /// then answers.
    pub(crate) clones: Result<Arc<CloneService>, String>,
    /// Lists the machine's folders for another device's folder chooser.
    pub(crate) machine_folders: Arc<FolderListService>,
    /// The devices' heartbeats.
    pub(crate) presence: Arc<PresenceRegister>,
    /// The attention entries' projection, banner settles and seen marks.
    pub(crate) attention: Arc<AttentionService>,
}

/// Registers every method table on `builder`, each once, grouped by owner: the daemon's own, its
/// data, the drivers, the approvals, the runs and their agents' commands and turns, the sessions,
/// attention, the repositories, the projects, the machine's folders and the devices present. The handshake,
/// the subscriptions' cancel and the artifact store's table are registered by the start beside
/// them. Fails when a method is registered twice.
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
    register_transcript_reads(
        builder,
        services.sessions,
        Arc::clone(&services.session_search.index),
    )?;
    register_session_list(builder, services.list_feed)?;
    register_session_event_subscribe(builder, services.event_log, Arc::clone(&services.providers))?;
    register_session_draft_update(builder, services.drafts)?;
    register_session_changes(builder, services.session_changes)?;
    register_session_review_notes(builder, services.review_notes)?;
    register_session_search(builder, services.session_search)?;
    register_context_subscribe(builder, services.context_readings)?;
    register_session_restart(
        builder,
        Arc::clone(&services.session_controls.provider_sessions),
    )?;
    register_session_controls(builder, services.session_controls)?;
    register_session_tags(builder, services.tags)?;
    register_session_groups(builder, services.session_groups)?;
    register_session_links(builder, services.links, services.related_ranking)?;
    register_session_recovery_methods(builder, services.damaged_history)?;
    register_attention_methods(builder, services.attention)?;
    register_question_resolve(builder, services.questions)?;
    register_highlight_read(builder, services.highlighter)?;
    register_terminal_write(builder, services.shells.input_lookup())?;
    register_terminal_methods(builder, services.shells)?;
    register_repo_branches(builder, services.branches)?;
    register_working_folder(builder, services.working_folders)?;
    register_project_methods(builder, services.projects, services.project_list_feed)?;
    register_project_clone_methods(builder, services.clones)?;
    register_machine_folders(builder, services.machine_folders)?;
    register_presence_methods(builder, services.presence)
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
