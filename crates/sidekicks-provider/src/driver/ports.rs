//! The handles every driver reaches that the daemon's start builds after the drivers, most from the
//! provider registry or from what reads it: each a port the start registers once it is built, read
//! by a driver when it needs one. Also the listeners a driver tells of its sessions' processes, and
//! the places the daemon runs sessions in.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::ProviderAccountRegistry;
use crate::account::usage_turns::unpriced::UnpricedUsageKey;
use crate::callback_tools::host::CallbackToolHost;
use crate::command::running_set::RunningCommandSets;
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::DaemonTurnBindingResolver;
use crate::driver::session_control::DriverResumeResult;
use crate::driver::{ProviderAccountReader, SessionSpawnContextResolver};
use crate::port::agent_tree_lookup::AgentTreeLookup;
use crate::port::bun_program::BunProgram;
use crate::port::command_capture::CommandCapture;
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::port::edit_checkpoint::EditCheckpoint;
use crate::port::file_tool_write::FileToolWritePort;
use crate::port::held_tool_calls::HeldToolCallReads;
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::permission_ask::PermissionAskPort;
use crate::port::plan::PlanPort;
use crate::port::question::QuestionPort;
use crate::port::raw_provider_messages::RawProviderMessages;
use crate::port::repository_reader::RepositoryReader;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::run_host::RunHost;
use crate::port::run_pause::{ContinuedMessages, RunPauses};
use crate::port::server_prompts::ServerPromptPort;
use crate::port::session_account_move::SessionAccountMoveRecorder;
use crate::port::session_advisor_store::SessionAdvisorStore;
use crate::port::session_level_follower::SessionLevelFollower;
use crate::port::session_message_reading_publisher::SessionMessageReadingPublisher;
use crate::port::session_resume_reader::SessionResumeReader;
use crate::port::session_rules::SessionRulePort;
use crate::port::session_wake::SessionWaker;
use crate::port::tool_call_status_publisher::ToolCallStatusPublisher;
use crate::port::tool_server_route::ToolServerRoute;
use crate::port::tool_traces::ToolTraces;
use crate::port::turn_reading_publisher::TurnReadingPublisher;
use crate::port::usage_sink::UsageSink;
use crate::pricing::receiver::TelemetryTarget;
use crate::pricing::store::HeldPriceList;
use crate::runtime_binding::resume::ResumeFunctionLegs;

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

/// The run queue's intake of a held lead's continue its provider did not carry: the steer that
/// held the person's answers went unechoed to its turn's end, or the turn meant to carry them
/// failed, so each answer's continue mark is given back for the next relaunch.
pub trait ContinueGivenBackListener: Send + Sync {
    /// The continue a relaunch handed `session_id`'s lead `lead_run_id` did not reach it.
    fn continue_given_back(&self, session_id: SessionId, lead_run_id: RunId);
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
    /// the resume runs, so the resumed process can deliver at once, and answers the binding's
    /// function legs, which the driver hands the resumed process; a session with no binding yet
    /// has no cursor to carry on, and nothing opens. Fails when the cursor cannot be opened, and
    /// the driver then does not resume and reports the relaunch failed.
    fn open_relaunch_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<ResumeFunctionLegs, Box<dyn Error + Send + Sync>>>;

    /// Answers the function legs of `binding_id`, the process a relaunch of `session_id` starts
    /// while the session keeps its binding, so the daemon opens no cursor and records no binding:
    /// legs of their own, never the ended process's; a session with no binding yet gets none.
    /// Fails as the daemon's reads fail, and the driver then does not resume.
    fn open_relaunch_legs(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<ResumeFunctionLegs, Box<dyn Error + Send + Sync>>>;

    /// Records what `session_id`'s relaunch did: a `Resumed` one's binding row, under the cursor
    /// `open_relaunch_binding` opened, which it does not open again; a `Failed` or `Deferred` one
    /// forgets that cursor. Fails when its binding could not be recorded, which the driver reports
    /// as a failed relaunch.
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// A request its driver left unpriced, and the ids of its usage rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldRequest {
    /// What a price list prices the request by.
    pub key: UnpricedUsageKey,
    /// The ids of the request's usage rows not yet marked held; empty when every row was written
    /// held.
    pub row_ids: Vec<FreeFormText<EVENT_FIELD_MAX_LEN>>,
}

/// The repricing's intake of a request its driver left unpriced.
pub trait RequestHeldListener: Send + Sync {
    /// Takes `held` into the repricing, marking its listed rows held before it answers; fails as
    /// the mark's write fails.
    fn request_held(
        &self,
        held: HeldRequest,
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
    /// The account registry, which a driver's account legs read an account's row from and keep
    /// what a read observed in; a leg that reads it before it is registered fails its act.
    pub provider_account_registry: Arc<PortRegistration<Arc<ProviderAccountRegistry>>>,
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
    /// The run queue's intake of a held lead's continue its provider did not carry.
    pub continue_given_back: Arc<PortRegistration<Arc<dyn ContinueGivenBackListener>>>,
    /// The session directory's intake of a relaunch.
    pub session_relaunched: Arc<PortRegistration<Arc<dyn SessionRelaunchListener>>>,
    /// The run queue's intake of an ended process.
    pub process_gone: Arc<PortRegistration<Arc<dyn ProcessGoneListener>>>,
    /// The usage record. Until it is registered a session's readings meter from a zero base and
    /// each metered change and quota window is dropped, as the command output and the readings
    /// ports drop theirs while the other ports refuse: the provider's stream never waits on it.
    pub usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The held price list each driver prices its requests from and marks its models in use on.
    /// Until it is registered a request stays unpriced, and each `mark_in_use` and
    /// `report_missing` call is dropped.
    pub price_list: Arc<PortRegistration<Arc<HeldPriceList>>>,
    /// Where a provider process exports its telemetry and the token it presents. A process started
    /// before it is registered starts with the person's telemetry settings withheld and no
    /// exporter set.
    pub telemetry_target: Arc<PortRegistration<Arc<TelemetryTarget>>>,
    /// The repricing's intake of a request a driver left unpriced. Until it is registered, a held
    /// request waits for the next start's pass.
    pub request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    /// The running commands of every session, which each driver reports its agent's commands to
    /// and follows each command's channel into; a command reported before it is registered is
    /// dropped.
    pub command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    /// The capture around each command an agent runs through the wrapper's line form; while it is
    /// unregistered a wrapper is answered `Go` at once and its command is captured by nobody, as
    /// the readings ports drop theirs.
    pub command_capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    /// The copy kept before each edit an agent's file tool makes; while it is unregistered an
    /// edit is answered at once and nothing is copied, as the command capture port drops its
    /// windows.
    pub edit_checkpoint: Arc<PortRegistration<Arc<dyn EditCheckpoint>>>,
    /// The turn readings each run's working line reads; a reading made before it is registered is
    /// dropped.
    pub turn_readings: Arc<PortRegistration<Arc<dyn TurnReadingPublisher>>>,
    /// The context reading each session's ring and `Context` section read; a reading made before
    /// it is registered is dropped.
    pub context_readings: Arc<PortRegistration<Arc<dyn ContextReadingPublisher>>>,
    /// What became of each message between sessions, as a provider tells it; a reading made before
    /// it is registered is dropped.
    pub session_message_readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
    /// The idle sleep's wake of a sleeping session for a message its inbox received; a driver that
    /// finds it unregistered refuses the message.
    pub session_wakes: Arc<PortRegistration<Arc<dyn SessionWaker>>>,
    /// The stored resume and kept schedules of a sleeping session a driver holds nothing for in
    /// memory; a driver that finds it unregistered fails the wake.
    pub session_resumes: Arc<PortRegistration<Arc<dyn SessionResumeReader>>>,
    /// The database writer the calibration stores its limits through.
    pub database_writer: Arc<PortRegistration<Arc<DatabaseWriter>>>,
    /// The approval pipeline's intake of permission asks.
    pub permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The questions card's intake.
    pub questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    /// The tool servers' prompts for the `/` list; until it is registered, the list holds none.
    pub server_prompts: Arc<PortRegistration<Arc<dyn ServerPromptPort>>>,
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
    /// The daemon's follow of a level or mode a provider reported running.
    pub session_level_followers: Arc<PortRegistration<Arc<dyn SessionLevelFollower>>>,
    /// The pause and continue of runs.
    pub run_pauses: Arc<PortRegistration<Arc<dyn RunPauses>>>,
    /// The messages waiting for paused runs, as the run queue holds them.
    pub continued_messages: Arc<PortRegistration<Arc<dyn ContinuedMessages>>>,
    /// The record of each session a driver moved onto another account with no switch waiting on
    /// the move; a move made before it is registered is logged and goes unrecorded.
    pub session_account_moves: Arc<PortRegistration<Arc<dyn SessionAccountMoveRecorder>>>,
    /// The daemon's one lock on account homes, which a driver's renewal in an account's home holds
    /// so no other act runs there meanwhile; a renewal asked for before it is registered is
    /// refused.
    pub account_home_lock: Arc<PortRegistration<Arc<AccountHomeLock>>>,
    /// The status lines under running tool calls; a status published before it is registered is
    /// dropped.
    pub tool_call_statuses: Arc<PortRegistration<Arc<dyn ToolCallStatusPublisher>>>,
    /// The session logs' held tool calls, which a resumed session follows or settles, a closed
    /// session settles, and the start after a restart settles for each resting session before any
    /// resumes; a session resumed before it is registered rebuilds none, and a session closed, or
    /// settled at the start, before it is registered settles none.
    pub held_tool_calls: Arc<PortRegistration<Arc<dyn HeldToolCallReads>>>,
    /// The session's agent tree, which a pre-tool hook looks up the helper a tool call names in.
    pub agent_tree_lookup: Arc<PortRegistration<Arc<dyn AgentTreeLookup>>>,
    /// The daemon's copy of bun, which a step that runs under bun asks its path from; a step that
    /// asks before it is registered refuses.
    pub bun_program: Arc<PortRegistration<Arc<dyn BunProgram>>>,
    /// The raw-message bucket, which each driver's reader hands every message the provider sends;
    /// a message read before it is registered is not recorded.
    pub raw_provider_messages: Arc<PortRegistration<Arc<dyn RawProviderMessages>>>,
    /// The tool-trace bucket, which each driver hands every tool call it delivers with its result;
    /// a call delivered before it is registered is not recorded.
    pub tool_traces: Arc<PortRegistration<Arc<dyn ToolTraces>>>,
    /// A chat's versions' intake of each write its agent's own file tool makes, which each driver
    /// opens a call on and settles. Until it is registered a chat's versions come from its
    /// workspace's watch alone, and a driver's open and settle are dropped.
    pub file_tool_writes: Arc<PortRegistration<Arc<dyn FileToolWritePort>>>,
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
            provider_account_registry: Arc::new(PortRegistration::new("provider account registry")),
            run_engine: Arc::new(PortRegistration::new("run engine")),
            inbound_dispatch: Arc::new(PortRegistration::new("inbound dispatch")),
            daemon_turn_bindings: Arc::new(PortRegistration::new("daemon turn bindings")),
            repositories: Arc::new(PortRegistration::new("repositories")),
            message_taken: Arc::new(PortRegistration::new("message taken")),
            message_refused: Arc::new(PortRegistration::new("message refused")),
            message_given_back: Arc::new(PortRegistration::new("message given back")),
            continue_given_back: Arc::new(PortRegistration::new("continue given back")),
            session_relaunched: Arc::new(PortRegistration::new("session relaunched")),
            process_gone: Arc::new(PortRegistration::new("process gone")),
            usage: Arc::new(PortRegistration::new("usage")),
            price_list: Arc::new(PortRegistration::new("price list")),
            telemetry_target: Arc::new(PortRegistration::new("telemetry target")),
            request_held: Arc::new(PortRegistration::new("request held")),
            command_output: Arc::new(PortRegistration::new("command output")),
            command_capture: Arc::new(PortRegistration::new("command capture")),
            edit_checkpoint: Arc::new(PortRegistration::new("edit checkpoint")),
            turn_readings: Arc::new(PortRegistration::new("turn readings")),
            context_readings: Arc::new(PortRegistration::new("context readings")),
            session_message_readings: Arc::new(PortRegistration::new("session message readings")),
            session_wakes: Arc::new(PortRegistration::new("session wakes")),
            session_resumes: Arc::new(PortRegistration::new("session resumes")),
            database_writer: Arc::new(PortRegistration::new("database writer")),
            permission_asks: Arc::new(PortRegistration::new("permission asks")),
            questions: Arc::new(PortRegistration::new("questions")),
            server_prompts: Arc::new(PortRegistration::new("server prompts")),
            plans: Arc::new(PortRegistration::new("plans")),
            reviewer_denials: Arc::new(PortRegistration::new("reviewer denials")),
            session_advisors: Arc::new(PortRegistration::new("session advisors")),
            session_rules: Arc::new(PortRegistration::new("session rules")),
            session_places: Arc::new(PortRegistration::new("session places")),
            in_process_tool_servers: Arc::new(PortRegistration::new("in-process tool servers")),
            tool_server_route: Arc::new(PortRegistration::new("tool server route")),
            callback_tool_host: Arc::new(PortRegistration::new("callback tool host")),
            session_level_followers: Arc::new(PortRegistration::new("session level followers")),
            run_pauses: Arc::new(PortRegistration::new("run pauses")),
            continued_messages: Arc::new(PortRegistration::new("continued messages")),
            session_account_moves: Arc::new(PortRegistration::new("session account moves")),
            account_home_lock: Arc::new(PortRegistration::new("account home lock")),
            tool_call_statuses: Arc::new(PortRegistration::new("tool call statuses")),
            held_tool_calls: Arc::new(PortRegistration::new("held tool calls")),
            agent_tree_lookup: Arc::new(PortRegistration::new("agent tree lookup")),
            bun_program: Arc::new(PortRegistration::new("bun program")),
            raw_provider_messages: Arc::new(PortRegistration::new("raw provider messages")),
            tool_traces: Arc::new(PortRegistration::new("tool traces")),
            file_tool_writes: Arc::new(PortRegistration::new("file tool writes")),
        }
    }
}

/// The folder `session_id`'s runs work in, read through the registered spawn contexts. Fails as
/// [`DriverError::Internal`] while the port is unregistered and as the resolution fails.
pub(crate) async fn resolve_run_folder(
    spawn_contexts: &PortRegistration<Arc<dyn SessionSpawnContextResolver>>,
    session_id: SessionId,
) -> Result<PathBuf, DriverError> {
    spawn_contexts
        .require_port()
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .resolve_run_folder(session_id)
        .await
        .map_err(DriverError::Internal)
}
