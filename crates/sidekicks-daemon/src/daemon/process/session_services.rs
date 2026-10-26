//! The session services the daemon's start builds once: the run engine with the approval side its
//! setup gate comes from, the pauses, the run queue and the interventions that close the engine's
//! cycles, the sessions' reads and stores, the self-naming, the questions and plans, a chat's file
//! versions, the code highlighter and the terminals. Their follows of the log begin once the
//! start's recovery pass has settled the runs.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_platforms::{Spawner, WallClock};
use sidekicks_terminal::{CommandLine, Terminals};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::admission::memory_gate::MemoryGate;
use crate::artifacts::chat_file_versions::ChatFileVersions;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::publish::ArtifactPublishService;
use crate::daemon::machine::local::LocalMachine;
use crate::daemon::process::approvals::{
    ApprovalAttachments, ApprovalStart, Approvals, build_approvals, start_approval_attachments,
};
use crate::daemon::process::stop::TaskStopFailure;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::DatabaseWriter;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::git::process::GitRunner;
use crate::git::worktree::watch::WorkingFolderWatcher;
use crate::highlight::colorer::{CodeHighlighter, CodeHighlighterOptions};
use crate::interventions::service::{InterventionService, InterventionServiceDeps};
use crate::ipc::handlers::run::safety_holds::RunSafetyHolds;
use crate::plans::service::PlansService;
use crate::policy::authorizer::Authorizer;
use crate::policy::background_work::BackgroundWorkForms;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::runtime_binding::store::RuntimeBindingStore;
use crate::pty::console::CONSOLE_MODE;
use crate::questions::service::QuestionsService;
use crate::queue::changes::QueueChangeSignals;
use crate::queue::delivery::ProviderProcessIds;
use crate::queue::provider_session::{
    ProviderSessionOpeningComposer, ProviderSessions, ProviderSessionsDeps,
};
use crate::queue::service::{RunQueue, RunQueueDeps};
use crate::session::auto_title::{SessionAutoTitle, SessionAutoTitling};
use crate::session::changes::SessionChanges;
use crate::session::directory::list_feed::SessionListFeed;
use crate::session::draft_store::SessionDraftStore;
use crate::session::links::service::SessionLinkService;
use crate::session::related::ranking::{RelatedRescoring, SessionRelatedRanking};
use crate::session::run::binding_cursors::RunBindingCursors;
use crate::session::run::engine::{RunEngine, RunEngineDeps};
use crate::session::run::epochs::ExecutionEpochs;
use crate::session::run::inbound::RunInboundDispatch;
use crate::session::run::pause::RunPauseControl;
use crate::session::run::provider_choice::ProviderChoiceResolver;
use crate::session::run::setup_gates::RunSetupGate;
use crate::session::search::files::service::FileSearchService;
use crate::session::service::SessionService;
use crate::session::tags::SessionTagService;
use crate::workspace::managed::service::ManagedWorkspaceService;
use crate::workspace::managed::write_watcher::ManagedWorkspaceWrite;

/// What the session services are built from.
pub(crate) struct SessionServiceStart {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The daemon's one event log.
    pub(crate) event_log: Arc<EventLogService>,
    /// The event log's followers, which the queue's run lifecycle follows.
    pub(crate) followers: Arc<SessionEventFollowers>,
    /// Where each damaged session's log stops being readable.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The registered drivers.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Each live run's posture, the engine's first setup gate.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The runtime binding rows, which an opening completes or removes.
    pub(crate) runtime_bindings: Arc<RuntimeBindingStore>,
    /// The one set of epoch cursors, shared with the inbound dispatch.
    pub(crate) epochs: Arc<Mutex<ExecutionEpochs>>,
    /// Composes a session's opening from its lead.
    pub(crate) compose_opening: ProviderSessionOpeningComposer,
    /// The identity of each session's provider process.
    pub(crate) processes: Arc<dyn ProviderProcessIds>,
    /// The gate every start waits its turn at.
    pub(crate) memory_gate: Arc<MemoryGate>,
    /// This machine, whose providers keep the rules made here.
    pub(crate) machine: LocalMachine,
    /// The one bound on shell-line reads.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which the permission check refuses.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The workflow actions' rules.
    pub(crate) authorizer: Arc<Authorizer>,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The working folders an answer marks stale.
    pub(crate) working_folders: Arc<WorkingFolderWatcher>,
    /// The daemon's git, which lists a working folder for the `@` file search.
    pub(crate) git: GitRunner,
    /// The session list's feed.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The artifact store's payloads, which a chat's versions are stored into.
    pub(crate) payloads: Arc<PayloadStore>,
    /// The artifact store's publisher, which a plan's record is stored through.
    pub(crate) publisher: Arc<ArtifactPublishService>,
    /// The artifact store's spool folder, on the store's volume.
    pub(crate) spool_folder: PathBuf,
    /// The folder of the chats' managed workspaces.
    pub(crate) workspaces_folder: PathBuf,
    /// The chats' writes the managed workspaces' watch reports.
    pub(crate) workspace_writes: mpsc::Receiver<ManagedWorkspaceWrite>,
    /// The daemon's wall clock.
    pub(crate) clock: Arc<dyn WallClock>,
    /// The thread every terminal child starts on.
    pub(crate) spawner: Spawner,
    /// The daemon's own program, whose `console` mode the terminals hand each console call to.
    pub(crate) daemon_program: PathBuf,
}

/// The session services, each built once for the daemon's life.
#[expect(
    dead_code,
    reason = "the daemon's driver ports, method tables and stop"
)]
pub(crate) struct SessionServices {
    /// The terminals; the stop drains them.
    pub(crate) terminals: Arc<Terminals>,
    /// The code highlighter; the stop stops it.
    pub(crate) highlighter: Arc<CodeHighlighter>,
    /// Records a chat's writes as versions until the workspaces' watch is gone; the stop takes it
    /// and waits for it.
    pub(crate) chat_version_recording: Option<JoinHandle<()>>,
    /// A chat's file versions.
    pub(crate) chat_versions: Arc<ChatFileVersions>,
    /// The queue; the stop waits for its work.
    pub(crate) queue: Arc<RunQueue>,
    /// The queues' change signals.
    pub(crate) signals: Arc<QueueChangeSignals>,
    /// Records, accepts and dispatches interventions.
    pub(crate) interventions: Arc<InterventionService>,
    /// Pauses and resumes runs.
    pub(crate) pauses: Arc<RunPauseControl>,
    /// Answers the choices a provider holds runs on.
    pub(crate) choices: Arc<ProviderChoiceResolver>,
    /// Each run's binding cursors, which follow the log so a run's end and a session's close
    /// drop them.
    pub(crate) binding_cursors: Arc<RunBindingCursors>,
    /// Where each provider delivery is attributed to its run and moves it.
    pub(crate) inbound_dispatch: Arc<RunInboundDispatch>,
    /// Each session's live safety holds, which the dispatch sends and the run state stream reads.
    pub(crate) run_safety_holds: Arc<RunSafetyHolds>,
    /// The `@` file search over each session's working folder; the stop waits for its listings.
    pub(crate) file_search: Arc<FileSearchService>,
    /// Starts, continues and ends runs.
    pub(crate) engine: Arc<RunEngine>,
    /// The approval side.
    pub(crate) approvals: Approvals,
    /// The sessions' reads.
    pub(crate) sessions: Arc<SessionService>,
    /// The session list's feed.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The sessions' drafts.
    pub(crate) drafts: Arc<SessionDraftStore>,
    /// The sessions' tags.
    pub(crate) tags: Arc<SessionTagService>,
    /// The links between sessions.
    pub(crate) links: Arc<SessionLinkService>,
    /// The related sessions' ranking.
    pub(crate) related_ranking: Arc<SessionRelatedRanking>,
    /// The sessions' renames and name pushes; the stop waits for the pushes.
    pub(crate) changes: Arc<SessionChanges>,
    /// The sessions' self-naming.
    pub(crate) auto_title: Arc<SessionAutoTitle>,
    /// The questions an agent asks the person.
    pub(crate) questions: Arc<QuestionsService>,
    /// The plans an agent hands over.
    pub(crate) plans: Arc<PlansService>,
}

/// Why the session services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionServiceStartError {
    /// The daemon's own program's path is not UTF-8, so the terminals cannot name it.
    #[error("the daemon's program path {} is not UTF-8", path.display())]
    ConsoleHelperProgram {
        /// The program's path.
        path: PathBuf,
    },
    /// The code highlighter's thread could not start.
    #[error("the code highlighter could not start")]
    Highlighter(#[source] std::io::Error),
}

/// Builds the session services from `start`: the run engine inside its own allocation, so the
/// approval side's run holds reach it, then the services that close its cycles before any run can
/// end. Fails when the console helper cannot be named or the highlighter cannot start. Runs inside
/// the daemon's runtime.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) fn build_session_services(
    start: SessionServiceStart,
) -> Result<SessionServices, SessionServiceStartError> {
    let SessionServiceStart {
        reads,
        writer,
        event_log,
        followers,
        read_damaged_from_sequence,
        providers,
        execution_postures,
        runtime_bindings,
        epochs,
        compose_opening,
        processes,
        memory_gate,
        machine,
        shell_lines,
        background_work,
        authorizer,
        data_folder,
        working_folders,
        git,
        list_feed,
        payloads,
        publisher,
        spool_folder,
        workspaces_folder,
        workspace_writes,
        clock,
        spawner,
        daemon_program,
    } = start;
    // The fallible steps first, so a failure leaves no follow or task begun.
    let terminals = Arc::new(Terminals::new(spawner, console_helper(daemon_program)?));
    let highlighter = Arc::new(
        CodeHighlighter::start(CodeHighlighterOptions::for_this_machine())
            .map_err(SessionServiceStartError::Highlighter)?,
    );
    let appender = Arc::new(SessionEventAppender::new(
        Arc::clone(&event_log),
        SESSION_EVENT_VERSION.clone(),
    ));
    let approval_start = ApprovalStart {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        events: Arc::clone(&appender),
        working_folders,
        providers: Arc::clone(&providers),
        machine,
        shell_lines,
        background_work,
        postures: Arc::clone(&execution_postures),
        authorizer,
        data_folder,
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
    };
    // The run holds take the engine's `Weak`, and the engine takes the run-end gate as it is
    // built, so the approval side is built inside the engine's allocation and leaves it here.
    let mut built_approvals = None;
    let engine = Arc::new_cyclic(|engine: &Weak<RunEngine>| {
        let approvals = build_approvals(engine.clone(), &approval_start);
        let mut built = RunEngine::new(RunEngineDeps {
            pool: Arc::clone(&reads),
            event_log: Arc::clone(&event_log),
            execution_postures,
            providers: Arc::clone(&providers),
        });
        built.register_setup_gate(Arc::clone(&approvals.run_end) as Arc<dyn RunSetupGate>);
        built_approvals = Some(approvals);
        built
    });
    let approvals = built_approvals.expect("the engine's build built the approval side");
    let pauses = Arc::new(RunPauseControl::new(
        Arc::clone(&reads),
        Arc::clone(&engine),
        Arc::clone(&providers),
    ));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&reads),
        Arc::clone(&runtime_bindings),
        Arc::clone(&epochs),
    ));
    let provider_sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
        pool: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        runtime_bindings,
        binding_cursors: Arc::clone(&binding_cursors),
        providers: Arc::clone(&providers),
        compose_opening,
    }));
    let signals = Arc::new(QueueChangeSignals::new());
    let queue = RunQueue::new(RunQueueDeps {
        pool: Arc::clone(&reads),
        event_log: Arc::clone(&event_log),
        writer: Arc::clone(&writer),
        signals: Arc::clone(&signals),
        engine: Arc::clone(&engine),
        providers: Arc::clone(&providers),
        provider_sessions,
        memory_gate,
        processes,
        pauses: Arc::clone(&pauses),
        followers,
        read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
    });
    engine
        .set_interrupt_queue(Arc::downgrade(&queue) as Weak<_>)
        .expect("a new engine holds no run queue yet");
    let interventions = Arc::new(InterventionService::new(InterventionServiceDeps {
        pool: Arc::clone(&reads),
        event_log: Arc::clone(&event_log),
        engine: Arc::clone(&engine),
        providers: Arc::clone(&providers),
        queue: Arc::clone(&queue) as Arc<_>,
    }));
    engine
        .set_limit_interrupter(Arc::downgrade(&interventions) as Weak<_>)
        .expect("a new engine holds no interventions service yet");
    let run_safety_holds = RunSafetyHolds::new();
    let inbound_dispatch = Arc::new(RunInboundDispatch::new(
        Arc::clone(&engine),
        epochs,
        Arc::clone(&run_safety_holds) as Arc<_>,
        Arc::clone(&event_log),
    ));
    let choices = Arc::new(ProviderChoiceResolver::new(
        Arc::clone(&reads),
        Arc::clone(&engine),
        Arc::clone(&providers),
    ));
    let related_ranking = Arc::new(SessionRelatedRanking::new(
        Arc::clone(&reads),
        Arc::clone(&writer),
    ));
    let changes = Arc::new(SessionChanges::new(
        Arc::clone(&reads),
        Arc::clone(&event_log),
        Arc::clone(&providers),
    ));
    let chat_versions = Arc::new(ChatFileVersions::new(
        Arc::clone(&appender),
        Arc::clone(&reads),
        payloads,
        spool_folder,
        workspaces_folder,
        clock,
    ));
    let chat_version_recording = {
        let chat_versions = Arc::clone(&chat_versions);
        tokio::spawn(async move {
            chat_versions.record_reported_writes(workspace_writes).await;
        })
    };
    Ok(SessionServices {
        terminals,
        highlighter,
        chat_version_recording: Some(chat_version_recording),
        chat_versions,
        queue,
        signals,
        interventions,
        pauses,
        choices,
        binding_cursors,
        inbound_dispatch,
        run_safety_holds,
        file_search: Arc::new(FileSearchService::new(Arc::clone(&reads), git)),
        sessions: Arc::new(SessionService::new(
            Arc::clone(&reads),
            read_damaged_from_sequence,
        )),
        list_feed,
        drafts: Arc::new(SessionDraftStore::new(
            Arc::clone(&reads),
            Arc::clone(&writer),
        )),
        tags: Arc::new(SessionTagService::new(
            Arc::clone(&reads),
            Arc::clone(&writer),
        )),
        links: Arc::new(SessionLinkService::new(
            Arc::clone(&reads),
            writer,
            Arc::clone(&related_ranking),
        )),
        related_ranking,
        auto_title: Arc::new(SessionAutoTitle::new(
            Arc::clone(&reads),
            Arc::clone(&changes),
            Arc::clone(&providers),
        )),
        changes,
        questions: Arc::new(QuestionsService::new(
            Arc::clone(&appender),
            Arc::clone(&reads),
            Arc::clone(&engine),
            providers,
        )),
        plans: Arc::new(PlansService::new(publisher, appender, reads)),
        engine,
        approvals,
    })
}

// The daemon's own `console` mode of `daemon_program`, which the terminals hand each console call
// to.
fn console_helper(daemon_program: PathBuf) -> Result<CommandLine, SessionServiceStartError> {
    let program = daemon_program
        .into_os_string()
        .into_string()
        .map_err(|path| SessionServiceStartError::ConsoleHelperProgram { path: path.into() })?;
    Ok(CommandLine {
        program,
        arguments: vec![CONSOLE_MODE.to_owned()],
    })
}

/// The session services' follows of the log, held for the stop.
pub(crate) struct SessionAttachments {
    // Ends by drop, after the follows below have stopped.
    binding_cursors: FollowerAttachment,
    approvals: ApprovalAttachments,
    related_rescoring: RelatedRescoring,
    auto_titling: SessionAutoTitling,
}

/// Starts the session services' follows of `followers`: the binding cursors', the approval side's,
/// the related sessions' rescoring and the self-naming. Called once the start's recovery pass has
/// settled the runs, inside the daemon's runtime.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) fn start_session_attachments(
    services: &SessionServices,
    followers: &Arc<SessionEventFollowers>,
) -> SessionAttachments {
    let binding_cursors = Arc::clone(&services.binding_cursors);
    SessionAttachments {
        // Runs on the writer's pump.
        binding_cursors: followers
            .follow_all(move |event| binding_cursors.observe(event).map_err(Into::into)),
        approvals: start_approval_attachments(&services.approvals, followers),
        related_rescoring: services.related_ranking.start(followers),
        auto_titling: services.auto_title.start(followers),
    }
}

impl SessionAttachments {
    /// Stops every follow and waits for the work under way, the file search's listings among it,
    /// and ends `workspaces`' watch, then waits for every write it already sent to be recorded;
    /// answers each task that ended abnormally, every one having stopped.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's stop"))]
    pub(crate) async fn stop(
        self,
        services: &mut SessionServices,
        workspaces: &ManagedWorkspaceService,
    ) -> Vec<TaskStopFailure> {
        let Self {
            binding_cursors,
            approvals,
            related_rescoring,
            auto_titling,
        } = self;
        let recording = services.chat_version_recording.take();
        let chat_versions = async {
            let recount = workspaces.stop().await;
            // The watch's end closes the writes' channel, so the recording ends on its own.
            let recorded = match recording {
                Some(recording) => recording.await,
                None => Ok(()),
            };
            (recount, recorded)
        };
        let (mut failures, rescoring, (), (), (recount, recorded)) = tokio::join!(
            approvals.stop(&services.approvals),
            related_rescoring.stop(),
            auto_titling.stop(),
            services.file_search.stop(),
            chat_versions,
        );
        for (task, stopped) in [
            ("related sessions' rescoring", rescoring),
            ("chats' file recount", recount),
            ("chat version recording", recorded),
        ] {
            if let Err(error) = stopped {
                failures.push(TaskStopFailure { task, error });
            }
        }
        drop(binding_cursors);
        failures
    }
}

#[cfg(test)]
mod tests;
