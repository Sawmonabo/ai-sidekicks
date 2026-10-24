//! The Codex driver as the daemon holds it: the services, homes and session slots it builds at
//! once, so a probe reaches a service before any session; and the pieces its sessions share,
//! composed once the run engine and the other handles the daemon registers after the drivers are
//! built, on the first call that needs a session.

mod controls;
mod effects;
pub(super) mod intake;
mod naming;
mod runs;
mod service_events;
mod sessions;
#[cfg(test)]
mod tests;
mod views;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use tokio_util::task::TaskTracker;

use crate::daemon::service_log::service_log_folder;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::SessionSpawnContextResolver;
use crate::provider::driver::codex::account_home_logs::AccountHomeLogExpiry;
use crate::provider::driver::codex::commands::{CodexCommandSource, CodexProviderCommandCache};
use crate::provider::driver::codex::delivery::asks::attribution::CodexAskIntake;
use crate::provider::driver::codex::delivery::asks::{
    CodexAskHandOff, CodexAskHandOffDependencies, CodexAskOwners,
};
use crate::provider::driver::codex::delivery::frames::{
    CodexFrameDelivery, CodexFrameDeliveryDependencies,
};
use crate::provider::driver::codex::goals::CodexSessionGoals;
use crate::provider::driver::codex::intervention::CodexInterventionDispatcher;
use crate::provider::driver::codex::lifecycle::effects::{CodexDriverEffects, CodexDriverLink};
use crate::provider::driver::codex::lifecycle::intake::CodexSessionIntake;
use crate::provider::driver::codex::lifecycle::service_events::CodexDriverServiceEvents;
use crate::provider::driver::codex::lifecycle::views::CodexSessionViews;
use crate::provider::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::provider::driver::codex::rules::CodexProjectRuleFiles;
use crate::provider::driver::codex::run::control::{CodexRunControl, CodexRunControlDependencies};
use crate::provider::driver::codex::run::faster_model_retry::{
    CodexFasterModelRetries, CodexFasterModelRetryDependencies,
};
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::self_started_turns::CodexSelfStartedTurnDependencies;
use crate::provider::driver::codex::run::start::record::{
    CodexBindingAdoptions, CodexRunCallDependencies,
};
use crate::provider::driver::codex::run::start::{CodexRunStart, CodexRunStartDependencies};
use crate::provider::driver::codex::service::home::CodexHomes;
use crate::provider::driver::codex::service::program::CodexInstalledProgram;
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::provider::driver::codex::service::supervisor::{
    CodexServiceDependencies, CodexServiceId,
};
use crate::provider::driver::codex::session::calls::CodexSessionCallDependencies;
use crate::provider::driver::codex::session::controls::CodexSessionControls;
use crate::provider::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::provider::driver::codex::session::establishment::{
    CodexOpenedSession, CodexSessionEstablishment, CodexSessionEstablishmentDependencies,
};
use crate::provider::driver::codex::session::fork::CodexForkDependencies;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::recovery::{
    CodexServiceRecovery, CodexServiceRecoveryDependencies,
};
use crate::provider::driver::codex::session::rewind::CodexConversationRewind;
use crate::provider::driver::codex::session::side_questions::CodexSideQuestions;
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::driver::{DriverServices, attachments::AttachmentResolver};
use crate::provider::port::registration::PortRegistration;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::session::run::engine::RunEngine;

/// The folder under the daemon's data folder that holds each session's helper role files.
const CODEX_HELPER_ROLES_FOLDER_NAME: &str = "codex-helper-roles";

/// How long a service's start or redial has to dial and complete its handshake.
const CODEX_SERVICE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The Codex driver: what it builds at once, and the session pieces it composes once.
pub(crate) struct CodexDriver {
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
    spawn_contexts: Arc<dyn SessionSpawnContextResolver>,
    execution_postures: Arc<ExecutionPostureService>,
    attachments: Arc<dyn AttachmentResolver>,
    runtime_bindings: Arc<dyn RuntimeBindingRebinder>,
    shell_lines: Arc<crate::policy::shell_commands::reading_bound::ShellLineReadingBound>,
    pending_compactions: PendingCompactionRegistry,
    processes: Arc<ProviderProcessRegistry>,
    reads: Arc<DatabaseReadPool>,
    ports: Arc<DriverPorts>,
    helper_roles_folder: PathBuf,
    is_terminal_reach_on: Arc<AtomicBool>,
    log_expiry: AccountHomeLogExpiry,
    registry: Arc<CodexServiceRegistry>,
    release: Arc<CodexConversationRelease>,
    slots: Arc<CodexSessionSlots>,
    run_routes: Arc<CodexRunRoutes>,
    config_forks: Arc<CodexConfigForks>,
    provider_commands: Arc<CodexProviderCommandCache>,
    project_rules: Arc<CodexProjectRuleFiles>,
    views: Arc<CodexSessionViews>,
    // The services whose rate limits were read since they first started.
    rate_limits_read: Mutex<HashSet<CodexServiceId>>,
    tasks: TaskTracker,
    link: Arc<CodexDriverLink>,
    parts: OnceLock<Arc<CodexDriverParts>>,
}

/// What every session shares once the daemon's run engine is registered; each session's task
/// holds it.
pub(crate) struct CodexDriverParts {
    pub(crate) engine: Arc<RunEngine>,
    pub(crate) ports: Arc<DriverPorts>,
    pub(crate) registry: Arc<CodexServiceRegistry>,
    pub(crate) release: Arc<CodexConversationRelease>,
    pub(crate) slots: Arc<CodexSessionSlots>,
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    pub(crate) config_forks: Arc<CodexConfigForks>,
    pub(crate) provider_commands: Arc<CodexProviderCommandCache>,
    pub(crate) views: Arc<CodexSessionViews>,
    pub(crate) pending_compactions: PendingCompactionRegistry,
    pub(crate) delivery: Arc<CodexFrameDelivery>,
    pub(crate) hand_off: Arc<CodexAskHandOff>,
    pub(crate) ask_intake: CodexAskIntake,
    pub(crate) side_questions: CodexSideQuestions,
    pub(crate) establishment: Arc<CodexSessionEstablishment>,
    pub(crate) recovery: Arc<CodexServiceRecovery>,
    pub(crate) run_start: Arc<CodexRunStart>,
    pub(crate) run_control: Arc<CodexRunControl>,
    pub(crate) retries: Arc<CodexFasterModelRetries>,
    pub(crate) interventions: CodexInterventionDispatcher,
    pub(crate) goals: CodexSessionGoals,
    pub(crate) controls: CodexSessionControls,
    pub(crate) rewind: CodexConversationRewind,
    pub(crate) calls: CodexSessionCallDependencies,
    pub(crate) self_started: CodexSelfStartedTurnDependencies,
    pub(crate) adoptions: Arc<CodexBindingAdoptions>,
    pub(crate) rate_limits: CodexRateLimitFiling,
    pub(crate) tasks: TaskTracker,
}

impl CodexDriver {
    /// The driver over the shared services: its homes, services and slots are built now, with no
    /// I/O and no process started; must be called within the daemon's runtime.
    pub(crate) fn new(services: &DriverServices) -> Self {
        let tasks = TaskTracker::new();
        let is_terminal_reach_on = Arc::new(AtomicBool::new(false));
        let homes = Arc::new(CodexHomes::new(
            Arc::clone(&services.spawn_contexts),
            &services.base_environment,
            &services.home_folder,
            Arc::clone(&is_terminal_reach_on),
        ));
        let link = Arc::new(CodexDriverLink::default());
        let release = Arc::new(CodexConversationRelease::default());
        let registry = Arc::new(CodexServiceRegistry::new(
            Arc::clone(&homes) as _,
            Arc::new(CodexServiceDependencies {
                spawner: services.spawner.clone(),
                provider_services: Arc::clone(&services.provider_services),
                program: Arc::new(CodexInstalledProgram::new(
                    Arc::clone(&services.command_search),
                    services.home_folder.clone(),
                    Arc::clone(&services.base_environment),
                    Arc::clone(&services.reserved_names),
                )),
                data_folder: services.data_folder.clone(),
                logs_folder: service_log_folder(&services.data_folder),
                additional_config_overrides: Vec::new(),
                startup_timeout: CODEX_SERVICE_STARTUP_TIMEOUT,
                events: Arc::new(CodexDriverServiceEvents::new(Arc::clone(&link))),
                release: Arc::clone(&release),
                drains: LastingServiceDrains::default(),
            }),
        ));
        let slots = Arc::new(CodexSessionSlots::new());
        let views = Arc::new(CodexSessionViews::default());
        let source_views = Arc::clone(&views);
        let provider_commands = CodexProviderCommandCache::new(
            // The tool servers' prompt reader registers on no driver port yet.
            Arc::new(PortRegistration::new("server prompts")),
            Arc::new(move |session_id: SessionId| -> Option<CodexCommandSource> {
                source_views.command_source(session_id)
            }),
        );
        Self {
            base_environment: Arc::clone(&services.base_environment),
            reserved_names: Arc::clone(&services.reserved_names),
            spawn_contexts: Arc::clone(&services.spawn_contexts),
            execution_postures: Arc::clone(&services.execution_postures),
            attachments: Arc::clone(&services.attachments),
            runtime_bindings: Arc::clone(&services.runtime_bindings),
            shell_lines: Arc::clone(&services.shell_lines),
            pending_compactions: services.pending_compactions.clone(),
            processes: Arc::clone(&services.processes),
            reads: Arc::clone(&services.pool),
            ports: Arc::clone(&services.ports),
            helper_roles_folder: services.data_folder.join(CODEX_HELPER_ROLES_FOLDER_NAME),
            project_rules: Arc::new(CodexProjectRuleFiles {
                codex_home: homes.personal_home().to_owned(),
                home_folder: services.home_folder.clone(),
                repositories: Arc::clone(&services.ports.repositories),
            }),
            is_terminal_reach_on,
            log_expiry: AccountHomeLogExpiry::default(),
            registry,
            release,
            config_forks: Arc::new(CodexConfigForks::new(Arc::clone(&slots), tasks.clone())),
            slots,
            run_routes: Arc::new(CodexRunRoutes::default()),
            provider_commands,
            views,
            rate_limits_read: Mutex::default(),
            tasks,
            link,
            parts: OnceLock::new(),
        }
    }

    /// The session pieces, composed on first use. Fails while the run engine, its dispatch or the
    /// queue's binding of the daemon's own turns is not registered yet.
    fn parts(&self) -> Result<&Arc<CodexDriverParts>, DriverError> {
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
            // The running-commands stream registers on no driver port yet.
            command_output: Arc::new(PortRegistration::new("command output")),
            pending_compactions: self.pending_compactions.clone(),
            effects,
        }));
        let hand_off = Arc::new(CodexAskHandOff::new(CodexAskHandOffDependencies {
            delivery: Arc::clone(&delivery),
            owners: CodexAskOwners {
                permission_asks: Arc::clone(&ports.permission_asks),
                questions: Arc::clone(&ports.questions),
            },
            shell_lines: Arc::clone(&self.shell_lines),
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
                pending_compactions: self.pending_compactions.clone(),
                provider_commands: Arc::clone(&self.provider_commands),
                processes: Arc::clone(&self.processes),
            },
        ));
        let rate_limits = || CodexRateLimitFiling {
            dispatch: Arc::clone(&dispatch),
            spawn_contexts: Arc::clone(&self.spawn_contexts),
        };
        let recovery = Arc::new(CodexServiceRecovery::new(
            CodexServiceRecoveryDependencies {
                slots: Arc::clone(&self.slots),
                establishment: Arc::clone(&establishment),
                services: Arc::clone(&self.registry),
                release: Arc::clone(&self.release),
                run_ends: Arc::clone(&engine) as _,
                dispatch: Arc::clone(&dispatch),
                reviewer_denials: Arc::clone(&ports.reviewer_denials),
                process_gone: Arc::clone(&ports.process_gone),
                session_relaunched: Arc::clone(&ports.session_relaunched),
                rate_limits: rate_limits(),
                tasks: self.tasks.clone(),
            },
        ));
        let run_start = Arc::new(CodexRunStart::new(CodexRunStartDependencies {
            slots: Arc::clone(&self.slots),
            config_forks: Arc::clone(&self.config_forks),
            run_routes: Arc::clone(&self.run_routes),
            engine: Arc::clone(&engine),
            daemon_turn_bindings: Arc::clone(&daemon_turn_bindings),
            attachments: Arc::clone(&self.attachments),
            reads: Arc::clone(&self.reads),
        }));
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
            ),
            controls: CodexSessionControls::new(
                Arc::clone(&self.slots),
                Arc::clone(&run_start),
                Arc::clone(&dispatch),
            ),
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
                    tool_server_route: Arc::clone(&ports.tool_server_route),
                    pending_compactions: self.pending_compactions.clone(),
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
                reads: Arc::clone(&self.reads),
            },
            rate_limits: rate_limits(),
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
            run_control,
            retries,
            adoptions,
            tasks: self.tasks.clone(),
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
        } = opened;
        let service = Arc::clone(&record.service);
        let intake = CodexSessionIntake::new(record, routing, Arc::clone(parts));
        self.tasks.spawn(intake.run(receiver, routed));
        self.read_rate_limits_once(parts, service);
    }

    // Reads the account's rate limits after its service's first start; recovery reads them again
    // after each restart and reconnect.
    fn read_rate_limits_once(
        &self,
        parts: &Arc<CodexDriverParts>,
        service: Arc<crate::provider::driver::codex::service::supervisor::CodexService>,
    ) {
        let is_first = self
            .rate_limits_read
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(service.id());
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
