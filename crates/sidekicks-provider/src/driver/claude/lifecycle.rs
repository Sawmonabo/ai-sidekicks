//! The Claude Code driver as the daemon holds it: the handles it stores when it is built, and the
//! pieces its sessions share, composed once the run engine and the other handles the daemon builds
//! after the drivers are registered, on the first call that needs a session.

mod controls;
mod runs;
mod sessions;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandListResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_platforms::PathRules;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_store::data_folder::program_link_folder;
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;

use crate::command::askpass::command_askpass_program_path;
use crate::command::wrapper::command_wrapper_program_path;
use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::DriverServices;
use crate::driver::attachments::AttachmentResolver;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account_credentials::ClaudeSignInReader;
use crate::driver::claude::delivery::commands::{ClaudeCommandChannels, ClaudeCommandPrograms};
use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::requests::answers::{
    ClaudeAnswerRules, read_claude_repository,
};
use crate::driver::claude::delivery::requests::{
    ClaudeInboundRequests, ClaudeInboundRequestsDependencies,
};
use crate::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::delivery::stream::{
    ClaudeDeliveryStream, ClaudeSessionStreams, ClaudeStreamDependencies,
};
use crate::driver::claude::frame_routing::ClaudeFrameRouting;
use crate::driver::claude::goals::ClaudeGoalCommands;
use crate::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::inbox::address::ClaudeRegisteredPlacesAddresser;
use crate::driver::claude::inbox::listener::ClaudeSessionInboxes;
use crate::driver::claude::intervention::ClaudeInterventions;
use crate::driver::claude::mcp::connectors::organization_mark::ClaudeOrganizationMarks;
use crate::driver::claude::rate_limit_windows::ClaudeUsageProbeModels;
use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::driver::claude::run::start::ClaudeRunStart;
use crate::driver::claude::session::account_servers::ClaudeAccountServerReads;
use crate::driver::claude::session::arrivals::task::ClaudeSessionTaskServices;
use crate::driver::claude::session::context_reading::ClaudeContextReadings;
use crate::driver::claude::session::controls::{ClaudeCommandListReader, ClaudeSessionControls};
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::session::establishment::figures::ClaudeHeldFigures;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::permission_level::ClaudeCommandSandboxCheck;
use crate::driver::claude::session::permission_level::check_claude_command_sandbox;
use crate::driver::claude::session::restart::ClaudeSessionRestarts;
use crate::driver::claude::session::slots::ClaudeSessionSlots;
use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
use crate::driver::claude::spawn::launch::installed_build::{
    ClaudeInstalledBuild, ClaudeProcessStarts,
};
use crate::driver::contract::error::DriverError;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::repository_reader::RepositoryReading;
use crate::port::run_host::RunHost;
use crate::port::session_inbox_address::SessionInboxAddresser;

/// The Claude Code driver: what it stores when built, and the session pieces it composes once.
pub(crate) struct ClaudeDriver {
    /// Every process the driver starts.
    pub(crate) starts: Arc<dyn ClaudeProcessStarts>,
    figures: Arc<ClaudeHeldFigures>,
    /// Each account's read of its connectors and organization servers.
    pub(crate) account_servers: Arc<ClaudeAccountServerReads>,
    /// The daemon's services every session's process is started from.
    pub(crate) sources: Arc<ClaudeSpawnSources>,
    attachments: Arc<dyn AttachmentResolver>,
    staged_changes: StagedChangesWorktrees,
    pending_compactions: PendingCompactionRegistry,
    shell_lines: Arc<ShellLineReadingBound>,
    usage_probe_models: Arc<ClaudeUsageProbeModels>,
    inbox_addresser: Arc<ClaudeRegisteredPlacesAddresser>,
    // One capability read at a time, since each makes and removes the same folder.
    capability_read: tokio::sync::Mutex<()>,
    parts: OnceLock<Arc<ClaudeSessionParts>>,
}

/// What every session shares once the daemon's run engine is registered.
pub(crate) struct ClaudeSessionParts {
    /// Brings sessions up and holds what their tasks share.
    pub(crate) establishment: Arc<ClaudeSessionEstablishment>,
    /// Relaunches, sleeps and wakes a session's process.
    pub(crate) restarts: Arc<ClaudeSessionRestarts>,
    /// Starts runs on live sessions.
    pub(crate) run_start: ClaudeRunStart,
    /// Interrupts, pauses and answers live runs.
    pub(crate) run_controls: ClaudeRunControls,
    /// Applies steers and interruptions.
    pub(crate) interventions: Arc<ClaudeInterventions>,
    cuts: Arc<ClaudeConversationCuts>,
    session_controls: Arc<ClaudeSessionControls>,
    goals: Arc<ClaudeGoalCommands>,
    reviewer: Arc<ClaudeReviewerCapture>,
}

impl ClaudeDriver {
    /// The driver over the shared services, starting every process from the installed build the
    /// command names. Stores handles and does no I/O.
    pub(crate) fn new(services: &DriverServices) -> Self {
        let launcher = Arc::new(ClaudeProcessLauncher::new(
            services.spawner.clone(),
            Arc::clone(&services.child_records),
            Arc::clone(&services.processes),
            &services.data_folder,
        ));
        let starts = Arc::new(ClaudeInstalledBuild::new(
            launcher,
            Arc::clone(&services.command_search),
            services.home_folder.clone(),
        ));
        Self::with_sign_in(
            services,
            starts,
            ClaudeSignInReader::system(),
            check_claude_command_sandbox,
        )
    }

    /// The driver over the shared services, starting every process through `starts` and reading
    /// sign-ins from a keychain of the test's own, never the system's.
    #[cfg(test)]
    pub(crate) fn with_starts(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
    ) -> Self {
        Self::with_test_sign_in(services, starts, check_claude_command_sandbox)
    }

    // The driver over the shared services, starting every process through `starts`, reading
    // sign-ins from a keychain of the test's own and checking the command sandbox with
    // `command_sandbox_check`.
    #[cfg(test)]
    fn with_test_sign_in(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
        command_sandbox_check: ClaudeCommandSandboxCheck,
    ) -> Self {
        Self::with_sign_in(
            services,
            starts,
            ClaudeSignInReader::with_keychain(sidekicks_platforms::CredentialStore::in_memory()),
            command_sandbox_check,
        )
    }

    // The driver over the shared services, starting every process through `starts`, reading each
    // account's claude.ai sign-in through `sign_in` and checking the command sandbox with
    // `command_sandbox_check`.
    fn with_sign_in(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
        sign_in: ClaudeSignInReader,
        command_sandbox_check: ClaudeCommandSandboxCheck,
    ) -> Self {
        let link_folder = program_link_folder(&services.data_folder);
        let sources = Arc::new(ClaudeSpawnSources {
            spawner: services.spawner.clone(),
            command_sandbox_check,
            runtime_bindings: Arc::clone(&services.runtime_bindings),
            pool: Arc::clone(&services.pool),
            execution_postures: Arc::clone(&services.execution_postures),
            base_environment: Arc::clone(&services.base_environment),
            reserved_names: Arc::clone(&services.reserved_names),
            background_work: Arc::clone(&services.background_work),
            data_folder: services.data_folder.clone(),
            home_folder: services.home_folder.clone(),
            processes: Arc::clone(&services.processes),
            command_channels: Arc::new(ClaudeCommandChannels::new(
                &services.data_folder,
                ClaudeCommandPrograms {
                    wrapper_program: command_wrapper_program_path(&link_folder),
                    askpass_program: command_askpass_program_path(&link_folder),
                },
                Arc::clone(&services.caller_processes),
                Arc::clone(&services.input_waits),
                Arc::clone(&services.ports.command_output),
            )),
            ports: Arc::clone(&services.ports),
        });
        Self {
            figures: Arc::new(ClaudeHeldFigures::new(
                Arc::clone(&starts),
                PathRules::NATIVE,
            )),
            account_servers: Arc::new(ClaudeAccountServerReads::new(
                Arc::clone(&starts),
                Arc::clone(&sources),
                ClaudeOrganizationMarks::new(sign_in),
            )),
            starts,
            sources,
            attachments: Arc::clone(&services.attachments),
            staged_changes: services.staged_changes.clone(),
            pending_compactions: services.pending_compactions.clone(),
            shell_lines: Arc::clone(&services.shell_lines),
            usage_probe_models: Arc::default(),
            inbox_addresser: Arc::new(ClaudeRegisteredPlacesAddresser::new(Arc::clone(
                &services.ports.session_places,
            ))),
            capability_read: tokio::sync::Mutex::default(),
            parts: OnceLock::new(),
        }
    }

    /// The driver with its session pieces composed over `engine` and its `dispatch` now, checking
    /// the command sandbox with `command_sandbox_check`, for a test that records what reaches the
    /// run engine.
    #[cfg(test)]
    pub(crate) fn with_engine(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
        engine: &Arc<dyn RunHost>,
        dispatch: &Arc<dyn InboundDispatch>,
        command_sandbox_check: ClaudeCommandSandboxCheck,
    ) -> Result<Self, DriverError> {
        let driver = Self::with_test_sign_in(services, starts, command_sandbox_check);
        let parts = driver.compose(engine, dispatch)?;
        drop(driver.parts.set(Arc::new(parts)));
        Ok(driver)
    }

    /// The session pieces, composed on first use. Fails while the run engine, its dispatch or the
    /// queue's binding of the daemon's own turns is not registered yet.
    pub(crate) fn parts(&self) -> Result<&Arc<ClaudeSessionParts>, DriverError> {
        if let Some(parts) = self.parts.get() {
            return Ok(parts);
        }
        let ports = &self.sources.ports;
        let engine = ports.run_engine.require_port().map_err(internal)?;
        let dispatch = ports.inbound_dispatch.require_port().map_err(internal)?;
        let composed = Arc::new(self.compose(engine, dispatch)?);
        // Two first calls may both compose; the one set first is kept, and the other, which
        // started nothing, is dropped.
        Ok(self.parts.get_or_init(|| composed))
    }

    /// Keeps the model display name `account`'s latest `get_usage` read named in its
    /// `model_scoped`, which a later event's weekly window over one model on that account is named
    /// for.
    #[expect(
        dead_code,
        reason = "the account's limits read names the model its scoped weekly window covers"
    )]
    pub(crate) fn note_usage_probe_model(&self, account: ProviderAccountId, display_name: String) {
        self.usage_probe_models.note(account, display_name);
    }

    /// The session pieces once composed; `None` before any session call composed them, when no
    /// session is live either.
    pub(crate) fn composed_parts(&self) -> Option<&Arc<ClaudeSessionParts>> {
        self.parts.get()
    }

    /// The repository of `working_folder` as Claude Code places its project settings; `None`
    /// outside git, and before the daemon registers its repository reader.
    async fn read_repository(&self, working_folder: &Path) -> Option<(RepositoryReading, bool)> {
        let repositories = self.sources.ports.repositories.port()?;
        read_claude_repository(&**repositories, working_folder).await
    }

    // Every piece a session shares, wired over `engine` and its `dispatch`.
    fn compose(
        &self,
        engine: &Arc<dyn RunHost>,
        dispatch: &Arc<dyn InboundDispatch>,
    ) -> Result<ClaudeSessionParts, DriverError> {
        let ports = &self.sources.ports;
        let bindings = Arc::clone(
            ports
                .daemon_turn_bindings
                .require_port()
                .map_err(internal)?,
        );
        let routes = Arc::new(ClaudeRunRoutes::default());
        let streams = Arc::new(ClaudeSessionStreams::default());
        let handshakes = Arc::new(ClaudeHandshakeRegister::default());
        let prompts = Arc::new(Mutex::new(ClaudeSentPrompts::default()));
        let pauses = Arc::new(Mutex::new(ClaudeRunPauses::default()));
        let helpers = Arc::new(Mutex::new(ClaudeHelperLimit::default()));
        let helper_steers = Arc::new(Mutex::new(ClaudeHelperSteers::default()));
        let dialogs = Arc::new(ClaudeProviderDialogs::new(ClaudeStreamDialogPorts::new(
            Arc::clone(dispatch),
            Arc::clone(&routes),
            Arc::clone(&streams),
        )));
        let reviewer = Arc::new(ClaudeReviewerCapture::new(Arc::clone(
            &ports.reviewer_denials,
        )));
        let requests = Arc::new(ClaudeInboundRequests::new(
            ClaudeInboundRequestsDependencies {
                dispatch: Arc::clone(dispatch),
                routes: Arc::clone(&routes),
                permission_asks: Arc::clone(&ports.permission_asks),
                questions: Arc::clone(&ports.questions),
                plans: Arc::clone(&ports.plans),
                dialogs: Arc::clone(&dialogs),
                reviewer: Arc::clone(&reviewer),
                answer_rules: ClaudeAnswerRules {
                    session_rules: Arc::clone(&ports.session_rules),
                    repositories: Arc::clone(&ports.repositories),
                    home_folder: self.sources.home_folder.clone(),
                    path_rules: PathRules::NATIVE,
                },
            },
        ));
        let message_taken = Arc::clone(&ports.message_taken);
        let context_readings = Arc::new(ClaudeContextReadings::new(
            Arc::clone(&ports.context_readings),
            Arc::clone(dispatch),
            Arc::clone(&streams),
        ));
        let delivery = Arc::new(ClaudeDeliveryStream::new(ClaudeStreamDependencies {
            engine: Arc::clone(engine),
            dispatch: Arc::clone(dispatch),
            routes: Arc::clone(&routes),
            dialogs: Arc::clone(&dialogs),
            pauses: Arc::clone(&pauses),
            reviewer: Arc::clone(&reviewer),
            // Before the queue registers its intake there is no queue to tell.
            message_taken: Arc::new(move |session_id, message_id: &str, run_id| {
                if let Some(listener) = message_taken.port() {
                    listener.message_taken(session_id, message_id, run_id);
                }
            }),
            usage: Arc::clone(&ports.usage),
            usage_probe_models: Arc::clone(&self.usage_probe_models),
            command_output: Arc::clone(&ports.command_output),
            turn_readings: Arc::clone(&ports.turn_readings),
            context: Arc::clone(&context_readings),
        }));
        let goals = Arc::new(ClaudeGoalCommands::default());
        let cuts = Arc::new(ClaudeConversationCuts {
            routes: Arc::clone(&routes),
            prompts: Arc::clone(&prompts),
            dialogs: Arc::clone(&dialogs),
            streams: Arc::clone(&streams),
        });
        let routing = Arc::new(ClaudeFrameRouting::new(
            Arc::clone(&handshakes),
            self.pending_compactions.clone(),
            Arc::clone(&ports.usage),
        ));
        let mut composed = None;
        let establishment = Arc::new_cyclic(|establishment: &Weak<ClaudeSessionEstablishment>| {
            let restarts = ClaudeSessionRestarts::new(
                Arc::clone(&routes),
                Arc::clone(engine),
                Arc::clone(dispatch),
                establishment.clone(),
                Arc::clone(ports),
            );
            let slots = restarts.slots().clone();
            let idle_sleep = Arc::new(ClaudeIdleSleep::default());
            let inboxes = Arc::new(ClaudeSessionInboxes::new(
                Arc::clone(&self.inbox_addresser) as Arc<dyn SessionInboxAddresser>,
                Arc::clone(&ports.session_wakes),
                slots.clone(),
                Arc::clone(&idle_sleep),
            ));
            let run_start = ClaudeRunStart {
                slots: slots.clone(),
                routes: Arc::clone(&routes),
                streams: Arc::clone(&streams),
                handshakes: Arc::clone(&handshakes),
                prompts: Arc::clone(&prompts),
                engine: Arc::clone(engine),
                dispatch: Arc::clone(dispatch),
                attachments: Arc::clone(&self.attachments),
                bindings,
                idle_sleep: Arc::clone(&idle_sleep),
                session_wakes: Arc::clone(&ports.session_wakes),
            };
            let interventions = Arc::new(ClaudeInterventions::new(
                run_start.clone(),
                Arc::clone(&dialogs),
                Arc::clone(&requests),
                Arc::clone(&helper_steers),
            ));
            let session_controls = Arc::new(ClaudeSessionControls::new(
                run_start.clone(),
                Arc::clone(&self.starts),
                self.staged_changes.clone(),
                Arc::clone(&ports.session_rules),
                Arc::clone(&ports.in_process_tool_servers),
                compose_command_list_reader(slots.clone(), Arc::clone(&handshakes), &routes),
                Arc::clone(&self.sources.command_channels),
            ));
            let run_controls = ClaudeRunControls {
                start: run_start.clone(),
                dialogs: Arc::clone(&dialogs),
                requests: Arc::clone(&requests),
                pauses: Arc::clone(&pauses),
                helper_steers: Arc::clone(&helper_steers),
                interventions: Arc::clone(&interventions),
                command_channels: Arc::clone(&self.sources.command_channels),
            };
            let task_services = Arc::new(ClaudeSessionTaskServices {
                delivery,
                streams: Arc::clone(&streams),
                requests: Arc::clone(&requests),
                dialogs: Arc::clone(&dialogs),
                reviewer: Arc::clone(&reviewer),
                prompts: Arc::clone(&prompts),
                pauses: Arc::clone(&pauses),
                helpers: Arc::clone(&helpers),
                helper_steers,
                interventions: Arc::clone(&interventions),
                goals: Arc::clone(&goals),
                self_started: ClaudeSelfStartedTurns {
                    start: run_start.clone(),
                    pauses,
                },
                settlement: ClaudeTurnSettlement {
                    handshakes: Arc::clone(&handshakes),
                    engine: Arc::clone(engine),
                    routes: Arc::clone(&routes),
                    helpers: Arc::clone(&helpers),
                    pending_compactions: self.pending_compactions.clone(),
                },
                cuts: Arc::clone(&cuts),
                shell_lines: Arc::clone(&self.shell_lines),
                background_work: Arc::clone(&self.sources.background_work),
                tool_servers: Arc::clone(&ports.in_process_tool_servers),
                processes: Arc::clone(&self.sources.processes),
                restarts: Arc::clone(&restarts),
                controls: Arc::clone(&session_controls),
                idle_sleep,
                inboxes,
                context_readings,
            });
            composed = Some((
                restarts,
                run_start,
                run_controls,
                interventions,
                session_controls,
            ));
            ClaudeSessionEstablishment {
                starts: Arc::clone(&self.starts),
                figures: Arc::clone(&self.figures),
                slots,
                routes: Arc::clone(&routes),
                streams: Arc::clone(&streams),
                prompts: Arc::clone(&prompts),
                handshakes: Arc::clone(&handshakes),
                routing,
                helpers,
                task_services,
                sources: Arc::clone(&self.sources),
                account_servers: Arc::clone(&self.account_servers),
            }
        });
        let (restarts, run_start, run_controls, interventions, session_controls) =
            composed.expect("the establishment's composition ran");
        Ok(ClaudeSessionParts {
            establishment,
            restarts,
            run_start,
            run_controls,
            interventions,
            cuts,
            session_controls,
            goals,
            reviewer,
        })
    }
}

impl ClaudeSessionParts {
    /// Every session's slot.
    pub(crate) fn slots(&self) -> &ClaudeSessionSlots {
        &self.establishment.slots
    }
}

// Reads a session's command list as its live process declared it, stamped with the account it was
// admitted on and its lead run; `None` with no live process.
fn compose_command_list_reader(
    slots: ClaudeSessionSlots,
    handshakes: Arc<ClaudeHandshakeRegister>,
    routes: &Arc<ClaudeRunRoutes>,
) -> ClaudeCommandListReader {
    let routes = Arc::clone(routes);
    Box::new(move |session_id: SessionId| {
        let live = slots.live_session(session_id)?;
        let binding = ProviderCommandBinding {
            provider_name: DESCRIPTOR.provider_id(),
            provider_account_id: live.admitted_provider_account_id.clone(),
        };
        let run_id = routes.lead_run_on(session_id).map(|lead| lead.run_id);
        let group = handshakes
            .enumerate_provider_commands(session_id, binding, run_id, &live)
            .ok()?;
        Some(ProviderCommandListResponse {
            bindings: BoundedVec::new(vec![group]).expect("one group is within the bounds"),
        })
    })
}

// A failure the caller cannot act on beyond reporting it.
fn internal(error: impl std::error::Error + Send + Sync + 'static) -> DriverError {
    DriverError::Internal(Box::new(error))
}
