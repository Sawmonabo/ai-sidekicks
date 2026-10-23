//! The Claude Code driver as the daemon holds it: the handles it stores when it is built, and the
//! pieces its sessions share, composed once the run engine and the other handles the daemon builds
//! after the drivers are registered, on the first call that needs a session.

mod controls;
mod runs;
mod sessions;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandListResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_platforms::PathRules;

use crate::git::worktree::staged_changes::StagedChangesWorktrees;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::attachments::AttachmentResolver;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::provider::driver::claude::delivery::requests::answers::{
    ClaudeAnswerRules, read_claude_repository,
};
use crate::provider::driver::claude::delivery::requests::{
    ClaudeInboundRequests, ClaudeInboundRequestsDependencies,
};
use crate::provider::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::provider::driver::claude::delivery::run_engine::{ClaudeRunEngine, RunEngineDelivery};
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::provider::driver::claude::delivery::stream::{
    ClaudeDeliveryStream, ClaudeSessionStreams, ClaudeStreamDependencies,
};
use crate::provider::driver::claude::frame_routing::ClaudeFrameRouting;
use crate::provider::driver::claude::goals::ClaudeGoalCommands;
use crate::provider::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::provider::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::provider::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::intervention::{ClaudeForegroundHelpers, ClaudeInterventions};
use crate::provider::driver::claude::rate_limit_windows::ClaudeUsageProbeModels;
use crate::provider::driver::claude::run::controls::ClaudeRunControls;
use crate::provider::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::provider::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::provider::driver::claude::run::routes::ClaudeRunRoutes;
use crate::provider::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::provider::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::provider::driver::claude::run::start::ClaudeRunStart;
use crate::provider::driver::claude::session::arrivals::task::ClaudeSessionTaskServices;
use crate::provider::driver::claude::session::controls::{
    ClaudeCommandListReader, ClaudeSessionControls,
};
use crate::provider::driver::claude::session::establishment::figures::ClaudeHeldFigures;
use crate::provider::driver::claude::session::establishment::{
    ClaudeSessionEstablishment, ClaudeSpawnSources,
};
use crate::provider::driver::claude::session::restart::ClaudeSessionRestarts;
use crate::provider::driver::claude::session::slots::ClaudeSessionSlots;
use crate::provider::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, compose_claude_process_environment,
};
use crate::provider::driver::claude::spawn::launch::ClaudeProcessLauncher;
use crate::provider::driver::claude::spawn::launch::installed_build::{
    ClaudeInstalledBuild, ClaudeProcessStarts,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::{DriverServices, ProviderAccountFolders};
use crate::provider::port::repository_reader::RepositoryReading;
use crate::provider::spawn_environment::SessionEnvironment;

/// The Claude Code driver: what it stores when built, and the session pieces it composes once.
pub(crate) struct ClaudeDriver {
    starts: Arc<dyn ClaudeProcessStarts>,
    figures: Arc<ClaudeHeldFigures>,
    sources: Arc<ClaudeSpawnSources>,
    attachments: Arc<dyn AttachmentResolver>,
    staged_changes: StagedChangesWorktrees,
    pending_compactions: PendingCompactionRegistry,
    shell_lines: Arc<ShellLineReadingBound>,
    usage_probe_models: Arc<ClaudeUsageProbeModels>,
    parts: OnceLock<Arc<ClaudeSessionParts>>,
}

/// What every session shares once the daemon's run engine is registered.
pub(crate) struct ClaudeSessionParts {
    /// Brings sessions up and holds what their tasks share.
    pub(crate) establishment: Arc<ClaudeSessionEstablishment>,
    restarts: Arc<ClaudeSessionRestarts>,
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
            Arc::clone(&services.processes),
            &services.data_folder,
        ));
        let starts = Arc::new(ClaudeInstalledBuild::new(
            launcher,
            Arc::clone(&services.command_search),
            services.home_folder.clone(),
        ));
        Self::with_starts(services, starts)
    }

    /// The driver over the shared services, starting every process through `starts`.
    pub(crate) fn with_starts(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
    ) -> Self {
        Self {
            figures: Arc::new(ClaudeHeldFigures::new(
                Arc::clone(&starts),
                PathRules::NATIVE,
            )),
            starts,
            sources: Arc::new(ClaudeSpawnSources {
                spawner: services.spawner.clone(),
                spawn_contexts: Arc::clone(&services.spawn_contexts),
                runtime_bindings: Arc::clone(&services.runtime_bindings),
                pool: Arc::clone(&services.pool),
                execution_postures: Arc::clone(&services.execution_postures),
                base_environment: Arc::clone(&services.base_environment),
                reserved_names: Arc::clone(&services.reserved_names),
                data_folder: services.data_folder.clone(),
                home_folder: services.home_folder.clone(),
                processes: Arc::clone(&services.processes),
                ports: Arc::clone(&services.ports),
            }),
            attachments: Arc::clone(&services.attachments),
            staged_changes: services.staged_changes.clone(),
            pending_compactions: services.pending_compactions.clone(),
            shell_lines: Arc::clone(&services.shell_lines),
            usage_probe_models: Arc::default(),
            parts: OnceLock::new(),
        }
    }

    /// The driver with its session pieces composed over `engine` now, for a test that records
    /// what reaches the run engine.
    #[cfg(test)]
    pub(crate) fn with_engine(
        services: &DriverServices,
        starts: Arc<dyn ClaudeProcessStarts>,
        engine: &Arc<dyn ClaudeRunEngine>,
    ) -> Result<Self, DriverError> {
        let driver = Self::with_starts(services, starts);
        let parts = driver.compose(engine)?;
        drop(driver.parts.set(Arc::new(parts)));
        Ok(driver)
    }

    /// The session pieces, composed on first use. Fails while the run engine, its dispatch or the
    /// queue's binding of the daemon's own turns is not registered yet.
    fn parts(&self) -> Result<&Arc<ClaudeSessionParts>, DriverError> {
        if let Some(parts) = self.parts.get() {
            return Ok(parts);
        }
        let ports = &self.sources.ports;
        let engine = ports.run_engine.require_port().map_err(internal)?;
        let dispatch = ports.inbound_dispatch.require_port().map_err(internal)?;
        let delivery: Arc<dyn ClaudeRunEngine> = Arc::new(RunEngineDelivery::new(
            Arc::clone(engine),
            Arc::clone(dispatch),
        ));
        let composed = Arc::new(self.compose(&delivery)?);
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

    /// The environment a process starts with on `account`'s home where the app manages it, else
    /// on the person's own sign-in, with a session's environment rows where given. Fails as the
    /// environment cannot be composed.
    fn process_environment(
        &self,
        account: Option<(ProviderAccountFolders, &ProviderAccountId)>,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        let sources = &self.sources;
        let data_folder = sources.data_folder.to_string_lossy();
        let account_folders = account
            .as_ref()
            .map(|(folders, _)| ClaudeAccountFolders::from(folders));
        compose_claude_process_environment(
            ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &sources.base_environment,
                    every_project_rows,
                    project_rows,
                    reserved_names: &sources.reserved_names,
                    rules: PathRules::NATIVE,
                },
                deny_env_vars: &[],
                account_folders: account_folders.as_ref(),
                data_folder: &data_folder,
                provider_account_id: account.map(|(_, id)| id),
            },
            &[],
        )
        .map_err(internal)
    }

    /// The environment a process that keeps nothing starts with on `provider_account_id`'s home,
    /// its folders read with no session, or on the person's own sign-in where `None`. Fails as the
    /// account's folders cannot be read or the environment cannot be composed.
    async fn account_environment(
        &self,
        provider_account_id: Option<&ProviderAccountId>,
    ) -> Result<Vec<(String, String)>, DriverError> {
        let folders = match provider_account_id {
            Some(provider_account_id) => self
                .sources
                .spawn_contexts
                .resolve_account_folders(provider_account_id.clone())
                .await
                .map_err(DriverError::Internal)?,
            None => None,
        };
        self.process_environment(folders.zip(provider_account_id), &[], &[])
    }

    // Every piece a session shares, wired over `engine`.
    fn compose(
        &self,
        engine: &Arc<dyn ClaudeRunEngine>,
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
        let foreground_helpers = Arc::new(Mutex::new(ClaudeForegroundHelpers::default()));
        let dialogs = Arc::new(ClaudeProviderDialogs::new(ClaudeStreamDialogPorts::new(
            Arc::clone(engine),
            Arc::clone(&routes),
            Arc::clone(&streams),
        )));
        let reviewer = Arc::new(ClaudeReviewerCapture::new(Arc::clone(
            &ports.reviewer_denials,
        )));
        let requests = Arc::new(ClaudeInboundRequests::new(
            ClaudeInboundRequestsDependencies {
                engine: Arc::clone(engine),
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
        let delivery = Arc::new(ClaudeDeliveryStream::new(ClaudeStreamDependencies {
            engine: Arc::clone(engine),
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
                establishment.clone(),
                Arc::clone(ports),
            );
            let slots = restarts.slots().clone();
            let run_start = ClaudeRunStart {
                slots: slots.clone(),
                routes: Arc::clone(&routes),
                streams: Arc::clone(&streams),
                handshakes: Arc::clone(&handshakes),
                prompts: Arc::clone(&prompts),
                engine: Arc::clone(engine),
                attachments: Arc::clone(&self.attachments),
                bindings,
            };
            let interventions = Arc::new(ClaudeInterventions::new(
                run_start.clone(),
                Arc::clone(&dialogs),
                Arc::clone(&requests),
                Arc::clone(&helper_steers),
                Arc::clone(&foreground_helpers),
            ));
            let session_controls = Arc::new(ClaudeSessionControls::new(
                run_start.clone(),
                Arc::clone(&self.starts),
                self.staged_changes.clone(),
                Arc::clone(&ports.session_rules),
                Arc::clone(&ports.in_process_tool_servers),
                compose_command_list_reader(slots.clone(), Arc::clone(&handshakes), &routes),
            ));
            let run_controls = ClaudeRunControls {
                start: run_start.clone(),
                dialogs: Arc::clone(&dialogs),
                requests: Arc::clone(&requests),
                pauses: Arc::clone(&pauses),
                helper_steers: Arc::clone(&helper_steers),
                interventions: Arc::clone(&interventions),
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
                foreground_helpers,
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
                tool_servers: Arc::clone(&ports.in_process_tool_servers),
                processes: Arc::clone(&self.sources.processes),
                restarts: Arc::clone(&restarts),
                controls: Arc::clone(&session_controls),
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
    fn slots(&self) -> &ClaudeSessionSlots {
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

// The home folder a person's own Claude Code settings sit under.
fn person_settings_folder(home_folder: &std::path::Path) -> PathBuf {
    home_folder.join(".claude")
}
