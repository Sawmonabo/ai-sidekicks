//! What a Claude Code session's delivery stream delivers through and reads each session's state
//! from.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use super::daemon_ends::ClaudeStreamDialogPorts;
use crate::command::running_set::RunningCommandSets;
use crate::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::driver::claude::goals::endings::ClaudeGoalEndings;
use crate::driver::claude::hooks::command_capture::ClaudeCommandWindows;
use crate::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::driver::claude::rate_limit_windows::ClaudeUsageProbeModels;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::context_reading::ClaudeContextReadings;
use crate::port::file_tool_write::FileToolWritePort;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::port::session_message_reading_publisher::SessionMessageReadingPublisher;
use crate::port::tool_call_status_publisher::ToolCallStatusPublisher;
use crate::port::tool_traces::ToolTraces;
use crate::port::turn_reading_publisher::TurnReadingPublisher;
use crate::port::usage_sink::UsageSink;
use crate::pricing::live::LivePricing;

/// Reports that Claude Code took a message the daemon handed: the session, the message's own id
/// and the run it was taken by.
pub(crate) type ClaudeMessageTaken = Arc<dyn Fn(SessionId, &str, RunId) + Send + Sync>;

/// What the stream delivers through and reads each session's state from.
pub(crate) struct ClaudeStreamDependencies {
    /// The run engine, which opens, counts and ends each turn.
    pub(crate) engine: Arc<dyn RunHost>,
    /// The run engine's dispatch, which takes each delivery.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// Each run's pause.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
    /// The reviewer's blocks, captured at a reviewed turn's end.
    pub(crate) reviewer: Arc<ClaudeReviewerCapture>,
    /// The queue's report that a handed message was taken.
    pub(crate) message_taken: ClaudeMessageTaken,
    /// Where the account's quota windows go once the usage record is registered.
    pub(crate) usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The model each account's latest limits read named for its weekly window over one model.
    pub(crate) usage_probe_models: Arc<ClaudeUsageProbeModels>,
    /// Every session's running commands, which the task frames report to once registered.
    pub(crate) command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    /// Where the working line's readings go once registered.
    pub(crate) turn_readings: Arc<PortRegistration<Arc<dyn TurnReadingPublisher>>>,
    /// Each session's context reads, which a lead message's usage reads mid-turn on.
    pub(crate) context: Arc<ClaudeContextReadings>,
    /// Where a held tool-server call's status line goes once registered.
    pub(crate) tool_call_statuses: Arc<PortRegistration<Arc<dyn ToolCallStatusPublisher>>>,
    /// Each session's goal, which the goal lines, records and turn ends classify against.
    pub(crate) goal_endings: Arc<ClaudeGoalEndings>,
    /// Where the messages other sessions sent, and a refused one, are published once registered.
    pub(crate) session_message_readings:
        Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
    /// Where each answered tool call's trace goes once registered.
    pub(crate) tool_traces: Arc<PortRegistration<Arc<dyn ToolTraces>>>,
    /// Where each file-tool call is opened and settled once the chat versions are registered.
    pub(crate) file_tool_writes: Arc<PortRegistration<Arc<dyn FileToolWritePort>>>,
    /// The windows of the commands that run with no wrapper, which a call's tool result, refusal
    /// or background task's end closes where no post hook did.
    pub(crate) command_windows: Arc<ClaudeCommandWindows>,
    /// Claude's live pricing, which prices each turn's rows and marks a rerouted model in use.
    pub(crate) pricing: Arc<LivePricing>,
}
