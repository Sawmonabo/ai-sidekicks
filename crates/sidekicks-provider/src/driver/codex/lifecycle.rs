//! The Codex driver as the daemon holds it: the services, homes and session slots it builds at
//! once, so a probe reaches a service before any session; and the pieces its sessions share,
//! composed once the run engine and the other handles the daemon registers after the drivers are
//! built, on the first call that needs a session.

pub(super) mod account_move;
mod controls;
mod effects;
pub(super) mod intake;
pub(crate) mod kept_turns;
pub(super) mod naming;
mod runs;
mod service_events;
pub(super) mod sessions;
#[cfg(test)]
mod tests;
mod views;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::data_folder::{program_link_folder, service_log_folder};
use tokio_util::task::TaskTracker;

use crate::background_work::BackgroundWorkForms;
use crate::command::askpass::command_askpass_program_path;
use crate::command::channel::command_channel_root;
use crate::command::wrapper::command_wrapper_program_path;
use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account_home_logs::AccountHomeLogExpiry;
use crate::driver::codex::calibration::CodexCompactionLimits;
use crate::driver::codex::commands::{CodexCommandSource, CodexProviderCommandCache};
use crate::driver::codex::delivery::asks::attribution::CodexAskIntake;
use crate::driver::codex::delivery::asks::{
    CodexAskHandOff, CodexAskHandOffDependencies, CodexAskOwners,
};
use crate::driver::codex::delivery::frames::{CodexFrameDelivery, CodexFrameDeliveryDependencies};
use crate::driver::codex::exec_relay::CodexExecRelayDependencies;
use crate::driver::codex::goals::CodexSessionGoals;
use crate::driver::codex::intervention::CodexInterventionDispatcher;
use crate::driver::codex::lifecycle::effects::{CodexDriverEffects, CodexDriverLink};
use crate::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::driver::codex::lifecycle::service_events::CodexDriverServiceEvents;
use crate::driver::codex::lifecycle::views::CodexSessionViews;
use crate::driver::codex::model_windows::CodexModelWindowCache;
use crate::driver::codex::pricing::CodexRequestPricer;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::rules::CodexProjectRuleFiles;
use crate::driver::codex::run::control::{CodexRunControl, CodexRunControlDependencies};
use crate::driver::codex::run::faster_model_retry::{
    CodexFasterModelRetries, CodexFasterModelRetryDependencies,
};
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::run::self_started_turns::CodexSelfStartedTurnDependencies;
use crate::driver::codex::run::start::record::{CodexBindingAdoptions, CodexRunCallDependencies};
use crate::driver::codex::run::start::{CodexRunStart, CodexRunStartDependencies};
use crate::driver::codex::run::stopped_helpers::CodexStoppedHelpers;
use crate::driver::codex::service::home::CodexHomes;
use crate::driver::codex::service::program::CodexInstalledProgram;
use crate::driver::codex::service::registry::{CodexHomeResolver, CodexServiceRegistry};
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::{CodexServiceDependencies, CodexServiceId};
use crate::driver::codex::service::switching::CodexSwitchingAccount;
use crate::driver::codex::session::calls::CodexSessionCallDependencies;
use crate::driver::codex::session::controls::CodexSessionControls;
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::establishment::answer_steer::{
    CodexAnswerSteerDependencies, CodexAnswerSteers,
};
use crate::driver::codex::session::establishment::{
    CodexOpenedSession, CodexSessionEstablishment, CodexSessionEstablishmentDependencies,
};
use crate::driver::codex::session::fork::CodexForkDependencies;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::recovery::{
    CodexServiceRecovery, CodexServiceRecoveryDependencies,
};
use crate::driver::codex::session::rewind::CodexConversationRewind;
use crate::driver::codex::session::side_questions::CodexSideQuestions;
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::shells::read_codex_shells;
use crate::driver::codex::telemetry::exports::CodexExports;
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::driver::{DriverServices, attachments::AttachmentResolver};
use crate::driver::{ProviderAccountReader, SessionSpawnContextResolver};
use crate::port::run_host::RunHost;
use crate::pricing::live::LivePricing;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::ReservedEnvironmentNames;

/// The folder under the daemon's data folder that holds each session's helper role files.
const CODEX_HELPER_ROLES_FOLDER_NAME: &str = "codex-helper-roles";

/// How long a service's start or redial has to dial and complete its handshake.
pub(crate) const CODEX_SERVICE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The Codex driver: what it builds at once, and the session pieces it composes once.
pub(crate) struct CodexDriver {
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
    spawn_contexts: Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    execution_postures: Arc<ExecutionPostureService>,
    attachments: Arc<dyn AttachmentResolver>,
    runtime_bindings: Arc<dyn RuntimeBindingWriter>,
    shell_lines: Arc<sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound>,
    background_work: Arc<BackgroundWorkForms>,
    // The shells Codex may start a command's line with, found as Codex finds them.
    line_shells: Arc<[PathBuf]>,
    pending_compactions: PendingCompactionRegistry,
    /// The helpers stopped alone, whose later turns are interrupted at their start.
    pub(crate) stopped_helpers: Arc<CodexStoppedHelpers>,
    processes: Arc<ProviderProcessRegistry>,
    ports: Arc<DriverPorts>,
    helper_roles_folder: PathBuf,
    // The folder each session's command channel opens under.
    command_channel_root: PathBuf,
    log_expiry: AccountHomeLogExpiry,
    // Each account's Codex home, read without starting its service.
    homes: Arc<CodexHomes>,
    pub(super) registry: Arc<CodexServiceRegistry>,
    release: Arc<CodexConversationRelease>,
    pub(super) slots: Arc<CodexSessionSlots>,
    run_routes: Arc<CodexRunRoutes>,
    config_forks: Arc<CodexConfigForks>,
    provider_commands: Arc<CodexProviderCommandCache>,
    pub(super) project_rules: Arc<CodexProjectRuleFiles>,
    pub(super) views: Arc<CodexSessionViews>,
    compaction_limits: Arc<CodexCompactionLimits>,
    model_windows: Arc<CodexModelWindowCache>,
    // The services whose rate limits were read since they first started.
    rate_limits_read: Mutex<HashSet<CodexServiceId>>,
    // The one filing of rate limits, which the session pieces and the account legs share.
    rate_limits: CodexRateLimitFiling,
    /// Codex's own acts on one account's home, which the account plane runs.
    pub(crate) account_legs: Arc<CodexAccountLegs>,
    // Held through a capability read, so a second one never empties the scratch home the first
    // runs in.
    capability_read: tokio::sync::Mutex<()>,
    tasks: TaskTracker,
    // The export drain and its launches' work, apart from `tasks` so the shutdown stops them first.
    export_tasks: TaskTracker,
    link: Arc<CodexDriverLink>,
    /// Codex's live pricing, which every session's recorder and every copy price through and a
    /// reroute marks its model in use on.
    pricing: Arc<LivePricing>,
    /// The register of the driver's launches' exports, which the receiver hands each export to.
    pub(super) exports: Arc<CodexExports>,
    parts: OnceLock<Arc<CodexDriverParts>>,
}

/// What every session shares once the daemon's run engine is registered; each session's task
/// holds it.
pub(crate) struct CodexDriverParts {
    /// The run engine each session's runs open and end in.
    pub(crate) engine: Arc<dyn RunHost>,
    /// The ports the daemon registers on the driver.
    pub(crate) ports: Arc<DriverPorts>,
    /// The Codex service of each credential home.
    pub(crate) registry: Arc<CodexServiceRegistry>,
    /// Lets go of each conversation a session moved off once no command of it runs.
    pub(crate) release: Arc<CodexConversationRelease>,
    /// Every session's slot.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// Which run each session's frames deliver to.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The forks each session's conversation owes onto its changed config.
    pub(crate) config_forks: Arc<CodexConfigForks>,
    /// Each session's listing of Codex's commands.
    pub(crate) provider_commands: Arc<CodexProviderCommandCache>,
    /// Every live session's view.
    pub(crate) views: Arc<CodexSessionViews>,
    /// The waits on compactions the sessions started.
    pub(crate) pending_compactions: PendingCompactionRegistry,
    /// Delivers each session's frames to its runs.
    pub(crate) delivery: Arc<CodexFrameDelivery>,
    /// Hands Codex's approvals and questions to the run engine and carries the answers back.
    pub(crate) hand_off: Arc<CodexAskHandOff>,
    /// What each routed approval or question is attributed and held by.
    pub(crate) ask_intake: CodexAskIntake,
    /// The side questions asked on the sessions' conversations.
    pub(crate) side_questions: CodexSideQuestions,
    /// Opens and resumes sessions' conversations.
    pub(crate) establishment: Arc<CodexSessionEstablishment>,
    /// Keeps each service's conversations through its exits and restarts.
    pub(crate) recovery: Arc<CodexServiceRecovery>,
    /// Starts each run's turn.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// Sends each held lead's answers once its session's task runs.
    pub(crate) answer_steers: Arc<CodexAnswerSteers>,
    /// Pauses, continues and stops the sessions' runs.
    pub(crate) run_control: Arc<CodexRunControl>,
    /// Retries held turns on a faster model.
    pub(crate) retries: Arc<CodexFasterModelRetries>,
    /// Routes interventions onto Codex's own operations.
    pub(crate) interventions: CodexInterventionDispatcher,
    /// Sets and clears each session's goal.
    pub(crate) goals: CodexSessionGoals,
    /// Sends `Allow once` on the blocks Codex's reviewer made.
    pub(crate) controls: CodexSessionControls,
    /// Cuts sessions' conversations back in place.
    pub(crate) rewind: CodexConversationRewind,
    /// What the calls on a session's record act through.
    pub(crate) calls: CodexSessionCallDependencies,
    /// What opening the run of a turn Codex started by itself acts through.
    pub(crate) self_started: CodexSelfStartedTurnDependencies,
    /// Each session's latest binding adoption, so a failed start undoes only its own.
    pub(crate) adoptions: Arc<CodexBindingAdoptions>,
    /// Files the rate-limit windows Codex reports.
    pub(crate) rate_limits: CodexRateLimitFiling,
    /// Tracks the work the sessions run off their tasks.
    pub(crate) tasks: TaskTracker,
    /// The compaction limit each Codex version, model and window was measured at.
    pub(crate) compaction_limits: Arc<CodexCompactionLimits>,
    /// Each home's model windows as its catalog last gave them.
    pub(crate) model_windows: Arc<CodexModelWindowCache>,
    /// The binding store, which keeps each binding's recovery data.
    pub(crate) runtime_bindings: Arc<dyn RuntimeBindingWriter>,
    /// Codex's live pricing, which every session's recorder and every copy price through and a
    /// reroute marks its model in use on.
    pub(crate) pricing: Arc<LivePricing>,
}

impl CodexDriver {
    /// The driver over the shared services: its homes, services and slots are built now, with no
    /// I/O and no process started, and its export drain spawned on its own tasks; must be called
    /// within the daemon's runtime.
    pub(crate) fn new(services: &DriverServices) -> Self {
        let tasks = TaskTracker::new();
        let homes = Arc::new(CodexHomes::new(
            Arc::clone(&services.ports.provider_accounts),
            &services.base_environment,
            &services.home_folder,
        ));
        let link = Arc::new(CodexDriverLink::default());
        let shells = read_codex_shells(&services.base_environment);
        let release = Arc::new(CodexConversationRelease::default());
        let command_channel_root = command_channel_root(&services.data_folder);
        let link_folder = program_link_folder(&services.data_folder);
        let exec_relay = Arc::new(CodexExecRelayDependencies {
            spawner: services.spawner.clone(),
            command_channel_root: command_channel_root.clone(),
            caller_processes: Arc::clone(&services.caller_processes),
            input_waits: Arc::clone(&services.input_waits),
            command_output: Arc::clone(&services.ports.command_output),
            command_capture: Arc::clone(&services.ports.command_capture),
            wrapper_program: command_wrapper_program_path(&link_folder),
            askpass_program: command_askpass_program_path(&link_folder),
            tasks: tasks.clone(),
        });
        let exports = Arc::new(CodexExports::new(Arc::clone(&services.scheduler)));
        // One drain takes every service's exported responses to their sessions.
        let drain = exports
            .take_drain()
            .expect("a new register's drain is untaken");
        let export_tasks = TaskTracker::new();
        export_tasks.spawn(drain.run(export_tasks.clone()));
        let dependencies = Arc::new(CodexServiceDependencies {
            spawner: services.spawner.clone(),
            provider_services: Arc::clone(&services.provider_services),
            processes: Arc::clone(&services.processes),
            child_records: Arc::clone(&services.child_records),
            program: Arc::new(CodexInstalledProgram::new(
                Arc::clone(&services.command_search),
                services.home_folder.clone(),
                Arc::clone(&services.base_environment),
                Arc::clone(&services.reserved_names),
            )),
            data_folder: services.data_folder.clone(),
            logs_folder: service_log_folder(&services.data_folder),
            personal_home: homes.terminal_reach_home().codex_home,
            additional_config_overrides: Vec::new(),
            startup_timeout: CODEX_SERVICE_STARTUP_TIMEOUT,
            dispatches_hook_mode: services.dispatches_hook_mode,
            session_shell_kind: shells.session_kind,
            events: Arc::new(CodexDriverServiceEvents::new(Arc::clone(&link))),
            release: Arc::clone(&release),
            drains: LastingServiceDrains::default(),
            tasks: tasks.clone(),
            exec_relay,
            switching: Arc::new(CodexSwitchingAccount::new(Arc::clone(
                &services.ports.provider_accounts,
            ))),
            provider_accounts: Arc::clone(&services.ports.provider_accounts),
            telemetry_target: Arc::clone(&services.ports.telemetry_target),
            exports: Arc::clone(&exports),
            raw_messages: Arc::clone(&services.ports.raw_provider_messages),
        });
        let registry = Arc::new(CodexServiceRegistry::new(
            Arc::clone(&homes) as _,
            Arc::clone(&dependencies),
        ));
        // One filing, so the account legs' reads and the services' pushes share what was filed.
        let rate_limits = CodexRateLimitFiling::new(Arc::clone(&services.ports.usage));
        let account_legs = CodexAccountLegs::new(
            Arc::clone(&registry),
            dependencies,
            rate_limits.clone(),
            Arc::clone(&services.ports.provider_account_registry),
            Arc::clone(&services.runtime_bindings),
            Arc::clone(&services.ports.account_home_lock),
        );
        let slots = Arc::new(CodexSessionSlots::new());
        let views = Arc::new(CodexSessionViews::default());
        let source_views = Arc::clone(&views);
        let provider_commands = CodexProviderCommandCache::new(
            Arc::clone(&services.ports.server_prompts),
            Arc::new(move |session_id: SessionId| -> Option<CodexCommandSource> {
                source_views.command_source(session_id)
            }),
        );
        let compaction_limits = Arc::new(CodexCompactionLimits::new(
            Arc::clone(&services.pool),
            Arc::clone(&services.ports.database_writer),
            tasks.clone(),
        ));
        Self {
            base_environment: Arc::clone(&services.base_environment),
            reserved_names: Arc::clone(&services.reserved_names),
            spawn_contexts: Arc::clone(&services.ports.spawn_contexts),
            provider_accounts: Arc::clone(&services.ports.provider_accounts),
            execution_postures: Arc::clone(&services.execution_postures),
            attachments: Arc::clone(&services.attachments),
            runtime_bindings: Arc::clone(&services.runtime_bindings),
            shell_lines: Arc::clone(&services.shell_lines),
            background_work: Arc::clone(&services.background_work),
            line_shells: shells.line_shells,
            pending_compactions: services.pending_compactions.clone(),
            stopped_helpers: Arc::new(CodexStoppedHelpers::new(tasks.clone())),
            processes: Arc::clone(&services.processes),
            ports: Arc::clone(&services.ports),
            helper_roles_folder: services.data_folder.join(CODEX_HELPER_ROLES_FOLDER_NAME),
            command_channel_root,
            project_rules: Arc::new(CodexProjectRuleFiles {
                home_folder: services.home_folder.clone(),
                repositories: Arc::clone(&services.ports.repositories),
            }),
            log_expiry: AccountHomeLogExpiry::default(),
            homes,
            registry,
            release,
            config_forks: Arc::new(CodexConfigForks::new(Arc::clone(&slots), tasks.clone())),
            slots,
            run_routes: Arc::new(CodexRunRoutes::default()),
            provider_commands,
            views,
            model_windows: Arc::new(CodexModelWindowCache::new(Arc::clone(&compaction_limits))),
            compaction_limits,
            rate_limits_read: Mutex::default(),
            rate_limits,
            account_legs,
            capability_read: tokio::sync::Mutex::default(),
            tasks,
            export_tasks,
            link,
            pricing: Arc::new(LivePricing::new(
                DESCRIPTOR.provider_id(),
                Arc::new(CodexRequestPricer),
                &services.ports,
            )),
            exports,
            parts: OnceLock::new(),
        }
    }

    /// The session pieces, composed on first use. Fails while the run engine, its dispatch or the
    /// queue's binding of the daemon's own turns is not registered yet.
    pub(super) fn parts(&self) -> Result<&Arc<CodexDriverParts>, DriverError> {
        if let Some(parts) = self.parts.get() {
            return Ok(parts);
        }
        let composed = Arc::new(self.compose()?);
        // Two first calls may both compose; the one set first is kept and linked, and the other,
        // which started nothing, is dropped.
        let parts = self.parts.get_or_init(|| composed);
        self.link.set(parts);
        Ok(parts)
    }

    // Every piece a session shares, over the registered run engine.
    fn compose(&self) -> Result<CodexDriverParts, DriverError> {
        let ports = &self.ports;
        let engine = Arc::clone(ports.run_engine.require_port().map_err(internal)?);
        let dispatch = Arc::clone(ports.inbound_dispatch.require_port().map_err(internal)?);
        let daemon_turn_bindings = Arc::clone(
            ports
                .daemon_turn_bindings
                .require_port()
                .map_err(internal)?,
        );
        let effects = Arc::new(CodexDriverEffects::new(Arc::clone(&self.link)));
        let delivery = Arc::new(CodexFrameDelivery::new(CodexFrameDeliveryDependencies {
            engine: Arc::clone(&engine),
            dispatch: Arc::clone(&dispatch),
            run_routes: Arc::clone(&self.run_routes),
            reviewer_denials: Arc::clone(&ports.reviewer_denials),
            command_output: Arc::clone(&ports.command_output),
            pending_compactions: self.pending_compactions.clone(),
            stopped_helpers: Arc::clone(&self.stopped_helpers),
            effects,
            provider_accounts: Arc::clone(&ports.provider_accounts),
            pricing: Arc::clone(&self.pricing),
            tool_traces: Arc::clone(&ports.tool_traces),
            line_shells: Arc::clone(&self.line_shells),
        }));
        let hand_off = Arc::new(CodexAskHandOff::new(CodexAskHandOffDependencies {
            delivery: Arc::clone(&delivery),
            owners: CodexAskOwners {
                permission_asks: Arc::clone(&ports.permission_asks),
                questions: Arc::clone(&ports.questions),
            },
            shell_lines: Arc::clone(&self.shell_lines),
            background_work: Arc::clone(&self.background_work),
            project_rules: Arc::clone(&self.project_rules) as _,
            tasks: self.tasks.clone(),
        }));
        let establishment = Arc::new(CodexSessionEstablishment::new(
            CodexSessionEstablishmentDependencies {
                services: Arc::clone(&self.registry),
                spawn_contexts: Arc::clone(&self.spawn_contexts),
                execution_postures: Arc::clone(&self.execution_postures),
                base_environment: Arc::clone(&self.base_environment),
                reserved_names: Arc::clone(&self.reserved_names),
                helper_roles_folder: self.helper_roles_folder.clone(),
                tool_server_route: Arc::clone(&ports.tool_server_route),
                delivery: Arc::clone(&delivery),
                run_routes: Arc::clone(&self.run_routes),
                pending_compactions: self.pending_compactions.clone(),
                provider_commands: Arc::clone(&self.provider_commands),
                processes: Arc::clone(&self.processes),
                reviewer_denials: Arc::clone(&ports.reviewer_denials),
                command_channel_root: self.command_channel_root.clone(),
            },
        ));
        let rate_limits = self.rate_limits.clone();
        let run_start = Arc::new(CodexRunStart::new(CodexRunStartDependencies {
            slots: Arc::clone(&self.slots),
            config_forks: Arc::clone(&self.config_forks),
            run_routes: Arc::clone(&self.run_routes),
            engine: Arc::clone(&engine),
            attachments: Arc::clone(&self.attachments),
            dispatch: Arc::clone(&dispatch),
        }));
        let answer_steers = Arc::new(CodexAnswerSteers::new(CodexAnswerSteerDependencies {
            run_routes: Arc::clone(&self.run_routes),
            run_start: Arc::clone(&run_start),
            dispatch: Arc::clone(&dispatch),
            continue_given_back: Arc::clone(&ports.continue_given_back),
            tasks: self.tasks.clone(),
        }));
        let recovery = Arc::new(CodexServiceRecovery::new(
            CodexServiceRecoveryDependencies {
                slots: Arc::clone(&self.slots),
                establishment: Arc::clone(&establishment),
                services: Arc::clone(&self.registry),
                release: Arc::clone(&self.release),
                run_ends: Arc::clone(&engine),
                dispatch: Arc::clone(&dispatch),
                answer_steers: Arc::clone(&answer_steers),
                reviewer_denials: Arc::clone(&ports.reviewer_denials),
                process_gone: Arc::clone(&ports.process_gone),
                session_relaunched: Arc::clone(&ports.session_relaunched),
                rate_limits: rate_limits.clone(),
                tasks: self.tasks.clone(),
            },
        ));
        let retries = Arc::new(CodexFasterModelRetries::new(
            CodexFasterModelRetryDependencies {
                slots: Arc::clone(&self.slots),
                run_routes: Arc::clone(&self.run_routes),
                run_start: Arc::clone(&run_start),
                dispatch: Arc::clone(&dispatch),
            },
        ));
        let run_control = Arc::new(CodexRunControl::new(CodexRunControlDependencies {
            slots: Arc::clone(&self.slots),
            config_forks: Arc::clone(&self.config_forks),
            run_routes: Arc::clone(&self.run_routes),
            run_start: Arc::clone(&run_start),
            retries: Arc::clone(&retries),
            attachments: Arc::clone(&self.attachments),
            dispatch: Arc::clone(&dispatch),
            run_pauses: Arc::clone(&ports.run_pauses),
            continued_messages: Arc::clone(&ports.continued_messages),
            tasks: self.tasks.clone(),
        }));
        let adoptions = Arc::new(CodexBindingAdoptions::default());
        Ok(CodexDriverParts {
            compaction_limits: Arc::clone(&self.compaction_limits),
            model_windows: Arc::clone(&self.model_windows),
            runtime_bindings: Arc::clone(&self.runtime_bindings),
            ask_intake: CodexAskIntake {
                hand_off: Arc::clone(&hand_off),
                run_routes: Arc::clone(&self.run_routes),
            },
            side_questions: CodexSideQuestions::new(Arc::clone(&dispatch), self.tasks.clone()),
            interventions: CodexInterventionDispatcher::new(Arc::clone(&run_control) as _),
            goals: CodexSessionGoals::new(
                Arc::clone(&self.slots),
                Arc::clone(&self.config_forks),
                Arc::clone(&run_start),
                Arc::clone(&self.run_routes),
                Arc::clone(&engine),
                Arc::clone(&daemon_turn_bindings),
            ),
            controls: CodexSessionControls::new(Arc::clone(&self.slots)),
            rewind: CodexConversationRewind::new(
                Arc::clone(&self.slots),
                Arc::clone(&self.config_forks),
                Arc::clone(&run_start),
                self.tasks.clone(),
            ),
            calls: CodexSessionCallDependencies {
                forks: CodexForkDependencies {
                    delivery: Arc::clone(&delivery),
                    release: Arc::clone(&self.release),
                    bindings: Arc::clone(&self.runtime_bindings),
                    services: Arc::clone(&self.registry),
                    tool_server_route: Arc::clone(&ports.tool_server_route),
                    reviewer_denials: Arc::clone(&ports.reviewer_denials),
                    pending_compactions: self.pending_compactions.clone(),
                    session_relaunched: Arc::clone(&ports.session_relaunched),
                },
                runs: CodexRunCallDependencies {
                    run_routes: Arc::clone(&self.run_routes),
                    config_forks: Arc::clone(&self.config_forks),
                    adoptions: Arc::clone(&adoptions),
                    bindings: Arc::clone(&self.runtime_bindings),
                    disposal: Arc::new(CodexDriverEffects::new(Arc::clone(&self.link))),
                },
            },
            self_started: CodexSelfStartedTurnDependencies {
                engine: Arc::clone(&engine),
                daemon_turn_bindings,
            },
            rate_limits,
            engine,
            ports: Arc::clone(ports),
            registry: Arc::clone(&self.registry),
            release: Arc::clone(&self.release),
            slots: Arc::clone(&self.slots),
            run_routes: Arc::clone(&self.run_routes),
            config_forks: Arc::clone(&self.config_forks),
            provider_commands: Arc::clone(&self.provider_commands),
            views: Arc::clone(&self.views),
            pending_compactions: self.pending_compactions.clone(),
            delivery,
            hand_off,
            establishment,
            recovery,
            run_start,
            answer_steers,
            run_control,
            retries,
            adoptions,
            tasks: self.tasks.clone(),
            pricing: Arc::clone(&self.pricing),
        })
    }

    /// Hands an opened session to a task of its own, the only reader of its queue, which applies
    /// the frames its opening released first.
    fn spawn_session_task(&self, parts: &Arc<CodexDriverParts>, opened: CodexOpenedSession) {
        let CodexOpenedSession {
            record,
            receiver,
            routing,
            routed,
            fixed_start,
        } = opened;
        let service = Arc::clone(&record.service);
        let intake = CodexSessionIntake::new(record, routing, Arc::clone(parts), fixed_start);
        self.tasks.spawn(intake.run(receiver, routed));
        self.read_rate_limits_once(parts, service);
    }

    // Closes `session_id`'s relayed command channel and forgets its relayed commands on every
    // service, once the session has closed; a channel whose folder cannot be removed is logged.
    async fn forget_relayed_commands(&self, session_id: SessionId) {
        for relay in self
            .registry
            .services()
            .iter()
            .filter_map(|service| service.exec_relay())
        {
            if let Err(error) = relay.forget_session(session_id).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    "a closed codex session's relayed command channel could not be removed"
                );
            }
        }
    }

    // Reads the account's rate limits after its service's first start; recovery reads them again
    // after each restart and reconnect.
    fn read_rate_limits_once(
        &self,
        parts: &Arc<CodexDriverParts>,
        service: Arc<crate::driver::codex::service::supervisor::CodexService>,
    ) {
        let is_first = lock(&self.rate_limits_read).insert(service.id());
        if !is_first {
            return;
        }
        let parts = Arc::clone(parts);
        self.tasks.spawn(async move {
            if let Err(error) = parts.rate_limits.read(&service).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the codex account's rate limits could not be read after its service started"
                );
            }
        });
    }
}

// A failure the caller cannot act on beyond reporting it.
fn internal(error: impl std::error::Error + Send + Sync + 'static) -> DriverError {
    DriverError::Internal(Box::new(error))
}
