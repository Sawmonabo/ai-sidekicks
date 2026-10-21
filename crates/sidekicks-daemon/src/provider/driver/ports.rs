//! The handles every driver reaches that the daemon's start builds after the drivers, most from the
//! provider registry or from what reads it: each a port the start registers once it is built, read
//! by a driver when it needs one. Also the listeners a driver tells of its sessions' processes, and
//! the places the daemon runs sessions in.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::callback_tools::host::CallbackToolHost;
use crate::provider::driver::contract::DriverResumeResult;
use crate::provider::driver::run_control::DaemonTurnBindingResolver;
use crate::provider::port::in_process_tool_servers::InProcessToolServers;
use crate::provider::port::permission_ask::PermissionAskPort;
use crate::provider::port::plan::PlanPort;
use crate::provider::port::question::QuestionPort;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::repository_reader::RepositoryReader;
use crate::provider::port::reviewer_denial::ReviewerDenialPort;
use crate::provider::port::session_rules::SessionRulePort;
use crate::provider::port::tool_server_route::ToolServerRoute;
use crate::provider::port::usage_sink::UsageSink;
use crate::provider::runtime_binding::store::RuntimeBindingStore;
use crate::session::run::engine::RunEngine;
use crate::session::run::inbound::RunInboundDispatch;
use crate::session::run::pause::RunPauseControl;

/// The run queue's intake of a message the provider took into a run's turn.
pub(crate) trait MessageTakenListener: Send + Sync {
    /// The provider took the message `message_id`, which the queue handed it, into `run_id`'s turn
    /// on `session_id`.
    fn message_taken(&self, session_id: SessionId, message_id: &str, run_id: RunId);
}

/// The run queue's intake of a session's provider process that ended, on its own or for a move to
/// a new build, so a message it kept for a turn of its own went with it.
pub(crate) trait ProcessGoneListener: Send + Sync {
    /// `session_id`'s provider process has ended.
    fn process_gone(&self, session_id: SessionId);
}

/// The session directory's intake of a resume a driver started on its own, after a crash or for a
/// move to a new build, so the daemon records the binding it minted or the failure.
pub(crate) trait SessionRelaunchListener: Send + Sync {
    /// Records what `session_id`'s relaunch did. Fails when its binding could not be recorded,
    /// which the driver reports as a failed relaunch.
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// One place the daemon runs sessions in, as its start found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionPlace {
    /// The place; `None` is the computer's own system.
    pub(crate) place: Option<Place>,
    /// The place's login-shell environment captured at the daemon's start.
    pub(crate) login_shell: Vec<(String, String)>,
    /// The person's user id in that place, read on macOS, Linux and a WSL distribution.
    pub(crate) user_id: u32,
}

/// The ports every driver reads, one registration per handle the daemon builds after the drivers,
/// each registered once by the daemon's start; a driver that finds one absent refuses or waits as
/// its own call says.
pub(crate) struct DriverPorts {
    /// The runtime bindings, which a driver records at a spawn and repoints when it moves a session
    /// onto another conversation.
    pub(crate) runtime_bindings: Arc<PortRegistration<Arc<RuntimeBindingStore>>>,
    /// The run engine.
    pub(crate) run_engine: Arc<PortRegistration<Arc<RunEngine>>>,
    /// The run engine's dispatch of what a provider delivers.
    pub(crate) inbound_dispatch: Arc<PortRegistration<Arc<RunInboundDispatch>>>,
    /// The run queue's opening of the binding a turn the daemon starts on a session runs on.
    pub(crate) daemon_turn_bindings: Arc<PortRegistration<Arc<dyn DaemonTurnBindingResolver>>>,
    /// The daemon's reads of the repository a working folder belongs to.
    pub(crate) repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>>,
    /// The run queue's intake of a taken message.
    pub(crate) message_taken: Arc<PortRegistration<Arc<dyn MessageTakenListener>>>,
    /// The session directory's intake of a relaunch.
    pub(crate) session_relaunched: Arc<PortRegistration<Arc<dyn SessionRelaunchListener>>>,
    /// The run queue's intake of an ended process.
    pub(crate) process_gone: Arc<PortRegistration<Arc<dyn ProcessGoneListener>>>,
    /// The usage record.
    pub(crate) usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The approval pipeline's intake of permission asks.
    pub(crate) permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The questions card's intake.
    pub(crate) questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    /// The plan record's intake.
    pub(crate) plans: Arc<PortRegistration<Arc<dyn PlanPort>>>,
    /// The approval pipeline's intake of reviewer blocks, and its release of held presses.
    pub(crate) reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The rules in force on each session.
    pub(crate) session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
    /// The places the daemon runs sessions in, which each session's inbox address is composed for.
    pub(crate) session_places: Arc<PortRegistration<Arc<[SessionPlace]>>>,
    /// The daemon's tool servers, reached in process.
    pub(crate) in_process_tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    /// The daemon's tool servers, reached at an address.
    #[expect(
        dead_code,
        reason = "the Codex driver's session start names each tool server at its address"
    )]
    pub(crate) tool_server_route: Arc<PortRegistration<Arc<dyn ToolServerRoute>>>,
    /// The one callback-tool dispatcher, which each spawn's callback tools are bound through.
    pub(crate) callback_tool_host: Arc<PortRegistration<Arc<CallbackToolHost>>>,
    /// The pause and continue of runs.
    #[expect(
        dead_code,
        reason = "the Codex driver settles a continued run's kept messages through it"
    )]
    pub(crate) run_pauses: Arc<PortRegistration<Arc<RunPauseControl>>>,
}

impl DriverPorts {
    /// Every port unregistered, for the daemon's start to register.
    pub(crate) fn new() -> Self {
        Self {
            runtime_bindings: Arc::new(PortRegistration::new("runtime bindings")),
            run_engine: Arc::new(PortRegistration::new("run engine")),
            inbound_dispatch: Arc::new(PortRegistration::new("inbound dispatch")),
            daemon_turn_bindings: Arc::new(PortRegistration::new("daemon turn bindings")),
            repositories: Arc::new(PortRegistration::new("repositories")),
            message_taken: Arc::new(PortRegistration::new("message taken")),
            session_relaunched: Arc::new(PortRegistration::new("session relaunched")),
            process_gone: Arc::new(PortRegistration::new("process gone")),
            usage: Arc::new(PortRegistration::new("usage")),
            permission_asks: Arc::new(PortRegistration::new("permission asks")),
            questions: Arc::new(PortRegistration::new("questions")),
            plans: Arc::new(PortRegistration::new("plans")),
            reviewer_denials: Arc::new(PortRegistration::new("reviewer denials")),
            session_rules: Arc::new(PortRegistration::new("session rules")),
            session_places: Arc::new(PortRegistration::new("session places")),
            in_process_tool_servers: Arc::new(PortRegistration::new("in-process tool servers")),
            tool_server_route: Arc::new(PortRegistration::new("tool server route")),
            callback_tool_host: Arc::new(PortRegistration::new("callback tool host")),
            run_pauses: Arc::new(PortRegistration::new("run pauses")),
        }
    }
}
