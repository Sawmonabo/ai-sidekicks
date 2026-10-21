//! What a Claude Code process declares about itself, as the stream reader reads it: the
//! `initialize` reply's models, styles and fast mode, the `system/init` handshake's commands and
//! capabilities, and the routing facts of each inbound frame.

use std::collections::HashSet;

use crate::provider::driver::claude::event_normalizer::ClaudeSubagentLifecycleSignal;
use crate::provider::usage_delta_accountant::UsageAxisCounts;

/// A fast-mode declaration as sent: `fast_mode_state` and `fast_mode_disabled_reason`, as the
/// `initialize` reply and each `system/init` report them; `None` where the frame carries none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeFastModeDeclaration {
    /// The state.
    pub(crate) fast_mode_state: Option<String>,
    /// Why it is off, where it is.
    pub(crate) fast_mode_disabled_reason: Option<String>,
}

/// The `system/init` declaration, as sent and whole.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeHandshakeDeclaration {
    /// The fast mode it reports.
    pub(crate) fast_mode: ClaudeFastModeDeclaration,
    /// `slash_commands`: invocable here, names without a leading `/`.
    pub(crate) slash_commands: Vec<String>,
    /// The skills.
    pub(crate) skills: Vec<String>,
    /// Commands run in the provider's own terminal screen, not invocable here.
    pub(crate) terminal_slash_commands: Vec<String>,
    /// The open `capabilities` set, each token as sent, such as `interrupt_cancel_queued_v1`.
    pub(crate) capabilities: Vec<String>,
    /// The permission mode the process runs in, which may differ from the one it was asked for.
    pub(crate) permission_mode: Option<String>,
}

/// One model the `initialize` reply offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeOfferedModel {
    /// What Claude Code takes as `--model`: a short alias or a full id.
    pub(crate) value: String,
    /// The full model id, where the reply resolves one.
    pub(crate) resolved_model: Option<String>,
    /// The name Claude Code shows for it, where the reply gives one.
    pub(crate) display_name: Option<String>,
}

/// What the `initialize` reply declared about the session's models and styles: the models it
/// offers, in its order, which of them run in auto mode, and the output styles the process offers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeInitializeDeclaration {
    /// The fast mode it reports.
    pub(crate) fast_mode: ClaudeFastModeDeclaration,
    /// The models, in its order.
    pub(crate) models: Vec<ClaudeOfferedModel>,
    /// Each name, alias and full id alike, of a model that runs in auto mode, the only ones
    /// Reviewed is offered on.
    pub(crate) auto_mode_models: HashSet<String>,
    /// The output styles.
    pub(crate) output_styles: Vec<String>,
    /// The output style the process runs with, where the reply names one.
    pub(crate) output_style: Option<String>,
}

/// One frame's cumulative token readings; the driver differences them, the reader never does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeCumulativeUsageObservation {
    /// The turn the metered frame names, or `None` where it names none.
    pub(crate) named_turn_id: Option<String>,
    /// The cumulative counts.
    pub(crate) cumulative: UsageAxisCounts,
    /// The wire's own per-turn figure where one exists; a cross-check only.
    pub(crate) declared_per_turn: Option<UsageAxisCounts>,
}

/// A compaction boundary, the only evidence that a compaction applied; `boundary_position` is
/// `None` where the frame names none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeCompactionBoundaryObservation {
    /// The position the boundary names.
    pub(crate) boundary_position: Option<u64>,
}

/// The routing facts of one inbound stream frame, not the frame itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeInboundFrameObservation {
    /// The `type/subtype` wire kind, as sent and untrusted.
    pub(crate) frame_kind: String,
    /// The helper the frame is attributed to, or `None` for the session's own thread.
    pub(crate) subagent_id: Option<String>,
    /// The frame's usage reading.
    pub(crate) cumulative_usage: Option<ClaudeCumulativeUsageObservation>,
    /// The helper lifecycle signal it carries.
    pub(crate) subagent_lifecycle: Option<ClaudeSubagentLifecycleSignal>,
    /// The `system/init` declaration, which rides the observation so routing always sees it.
    pub(crate) handshake: Option<ClaudeHandshakeDeclaration>,
    /// The compaction boundary it carries.
    pub(crate) compaction_boundary: Option<ClaudeCompactionBoundaryObservation>,
}
