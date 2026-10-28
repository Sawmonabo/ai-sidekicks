//! The handles every driver reaches that the daemon's start builds after the drivers, most from the
//! provider registry or from what reads it: each a port the start registers once it is built, read
//! by a driver when it needs one. Also the listeners a driver tells of its sessions' processes, and
//! the places the daemon runs sessions in.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::callback_tools::host::CallbackToolHost;
use crate::driver::run_control::DaemonTurnBindingResolver;
use crate::driver::session_control::DriverResumeResult;
use crate::driver::{ProviderAccountReader, SessionSpawnContextResolver};
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::permission_ask::PermissionAskPort;
use crate::port::plan::PlanPort;
use crate::port::question::QuestionPort;
use crate::port::repository_reader::RepositoryReader;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::run_host::RunHost;
use crate::port::run_pause::{ContinuedMessages, RunPauses};
use crate::port::session_advisor_store::SessionAdvisorStore;
use crate::port::session_rules::SessionRulePort;
use crate::port::tool_server_route::ToolServerRoute;
use crate::port::usage_sink::UsageSink;

/// The run queue's intake of a message the provider took into a run's turn.
pub trait MessageTakenListener: Send + Sync {
    /// The provider took the message `message_id`, which the queue handed it, into `run_id`'s turn
    /// on `session_id`.
    fn message_taken(&self, session_id: SessionId, message_id: &str, run_id: RunId);
}

/// The run queue's intake of a message the provider refused after the queue handed it.
pub trait MessageRefusedListener: Send + Sync {
    /// The provider refused the message `message_id`, which the queue handed it on `session_id`,
    /// for `reason`.
    fn message_refused(
        &self,
        session_id: SessionId,
        message_id: &str,
        reason: QueueItemNotDeliveredReason,
    );
}

/// The run queue's intake of a message the provider was handed and let go unsent, so it waits
/// again.
pub trait MessageGivenBackListener: Send + Sync {
    /// The provider let go unsent the message `message_id`, which the queue handed it on
    /// `session_id`.
    fn message_given_back(&self, session_id: SessionId, message_id: &str);
}

/// The run queue's intake of a session's provider process that ended, on its own or for a move to
/// a new build, so a message it kept for a turn of its own went with it.
pub trait ProcessGoneListener: Send + Sync {
    /// `session_id`'s provider process has ended.
    fn process_gone(&self, session_id: SessionId);
}

/// The session directory's intake of a resume a driver started on its own, after a crash or for a
/// move to a new build, so the daemon opens the binding the driver minted before the resume runs
/// and records it, or the failure, once the resume answered.
pub trait SessionRelaunchListener: Send + Sync {
    /// Opens the event cursor of `binding_id`, which the driver minted for its resume of
    /// `session_id`'s conversation, where the cursor of the session's newest binding stands, before
    /// the resume runs, so the resumed process can deliver at once; a session with no binding yet
    /// has no cursor to carry on, and nothing opens. Fails when the cursor cannot be opened, and
    /// the driver then does not resume and reports the relaunch failed.
    fn open_relaunch_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Records what `session_id`'s relaunch did: a `Resumed` one's binding row, under the cursor
    /// `open_relaunch_binding` opened, which it does not open again; a `Failed` one forgets that
    /// cursor. Fails when its binding could not be recorded, which the driver reports as a failed
    /// relaunch.
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// One place the daemon runs sessions in, as its start found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPlace {
    /// The place; `None` is the computer's own system.
    pub place: Option<Place>,
    /// The place's login-shell environment captured at the daemon's start.
    pub login_shell: Vec<(String, String)>,
    /// The person's user id in that place, read on macOS, Linux and a WSL distribution; `None` on
    /// native Windows, whose inbox is a pipe that needs none.
    pub user_id: Option<u32>,
}

/// The ports every driver reads, one registration per handle the daemon builds after the drivers,
/// each registered once by the daemon's start; a driver that finds one absent refuses or waits as
/// its own call says.
pub struct DriverPorts {
    /// Where each session's provider process runs, resolved at every spawn; a driver that spawns
    /// before it is registered refuses the spawn.
    pub spawn_contexts: Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>>,
    /// The reads of the accounts a provider runs on, their folders and credential generations; a
    /// driver that reads an account before it is registered fails that read.
    pub provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    /// The run engine.
    pub run_engine: Arc<PortRegistration<Arc<dyn RunHost>>>,
    /// The run engine's dispatch of what a provider delivers.
    pub inbound_dispatch: Arc<PortRegistration<Arc<dyn InboundDispatch>>>,
    /// The run queue's opening of the binding a turn the daemon starts on a session runs on.
    pub daemon_turn_bindings: Arc<PortRegistration<Arc<dyn DaemonTurnBindingResolver>>>,
    /// The daemon's reads of the repository a working folder belongs to.
    pub(crate) repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>>,
    /// The run queue's intake of a taken message.
    pub message_taken: Arc<PortRegistration<Arc<dyn MessageTakenListener>>>,
    /// The run queue's intake of a handed message the provider refused.
    pub message_refused: Arc<PortRegistration<Arc<dyn MessageRefusedListener>>>,
    /// The run queue's intake of a handed message the provider let go unsent.
    pub message_given_back: Arc<PortRegistration<Arc<dyn MessageGivenBackListener>>>,
    /// The session directory's intake of a relaunch.
    pub session_relaunched: Arc<PortRegistration<Arc<dyn SessionRelaunchListener>>>,
    /// The run queue's intake of an ended process.
    pub process_gone: Arc<PortRegistration<Arc<dyn ProcessGoneListener>>>,
    /// The usage record.
    pub usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The approval pipeline's intake of permission asks.
    pub permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The questions card's intake.
    pub questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    /// The plan record's intake.
    pub plans: Arc<PortRegistration<Arc<dyn PlanPort>>>,
    /// The approval pipeline's intake of reviewer blocks, and its release of held presses.
    pub reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The record of the advisor Claude Code resolved for a session no one picked one for.
    pub session_advisors: Arc<PortRegistration<Arc<dyn SessionAdvisorStore>>>,
    /// The rules in force on each session.
    pub session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
    /// The places the daemon runs sessions in, which each session's inbox address is composed for.
    pub session_places: Arc<PortRegistration<Arc<[SessionPlace]>>>,
    /// The daemon's tool servers, reached in process.
    pub(crate) in_process_tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    /// The daemon's tool servers, reached at an address.
    pub(crate) tool_server_route: Arc<PortRegistration<Arc<dyn ToolServerRoute>>>,
    /// The one callback-tool dispatcher, which each spawn's callback tools are bound through.
    pub callback_tool_host: Arc<PortRegistration<Arc<CallbackToolHost>>>,
    /// The pause and continue of runs.
    pub run_pauses: Arc<PortRegistration<Arc<dyn RunPauses>>>,
    /// The messages waiting for paused runs, as the run queue holds them.
    pub continued_messages: Arc<PortRegistration<Arc<dyn ContinuedMessages>>>,
}

impl Default for DriverPorts {
    fn default() -> Self {
        Self::new()
    }
}

impl DriverPorts {
    /// Every port unregistered, for the daemon's start to register.
    pub fn new() -> Self {
        Self {
            spawn_contexts: Arc::new(PortRegistration::new("spawn contexts")),
            provider_accounts: Arc::new(PortRegistration::new("provider accounts")),
            run_engine: Arc::new(PortRegistration::new("run engine")),
            inbound_dispatch: Arc::new(PortRegistration::new("inbound dispatch")),
            daemon_turn_bindings: Arc::new(PortRegistration::new("daemon turn bindings")),
            repositories: Arc::new(PortRegistration::new("repositories")),
            message_taken: Arc::new(PortRegistration::new("message taken")),
            message_refused: Arc::new(PortRegistration::new("message refused")),
            message_given_back: Arc::new(PortRegistration::new("message given back")),
            session_relaunched: Arc::new(PortRegistration::new("session relaunched")),
            process_gone: Arc::new(PortRegistration::new("process gone")),
            usage: Arc::new(PortRegistration::new("usage")),
            permission_asks: Arc::new(PortRegistration::new("permission asks")),
            questions: Arc::new(PortRegistration::new("questions")),
            plans: Arc::new(PortRegistration::new("plans")),
            reviewer_denials: Arc::new(PortRegistration::new("reviewer denials")),
            session_advisors: Arc::new(PortRegistration::new("session advisors")),
            session_rules: Arc::new(PortRegistration::new("session rules")),
            session_places: Arc::new(PortRegistration::new("session places")),
            in_process_tool_servers: Arc::new(PortRegistration::new("in-process tool servers")),
            tool_server_route: Arc::new(PortRegistration::new("tool server route")),
            callback_tool_host: Arc::new(PortRegistration::new("callback tool host")),
            run_pauses: Arc::new(PortRegistration::new("run pauses")),
            continued_messages: Arc::new(PortRegistration::new("continued messages")),
        }
    }
}
