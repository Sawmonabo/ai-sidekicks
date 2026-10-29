//! What a Claude Code process declares about itself, as the stream reader reads it: the
//! `initialize` reply's models, the one match of a model against them, styles and fast mode, the
//! `system/init` handshake's commands and capabilities, and the routing facts of each inbound
//! frame.

use std::collections::HashSet;

use crate::driver::claude::event_normalizer::ClaudeSubagentLifecycleSignal;
use crate::usage_delta_accountant::UsageAxisCounts;

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
    /// The effort levels it takes; `None` for a model with no effort axis.
    pub(crate) effort_levels: Option<Vec<String>>,
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

impl ClaudeInitializeDeclaration {
    /// The offered model `model` names: compared lowercase, with a window suffix such as `-1m`
    /// read as `[1m]` and never dropped, first against each `value`, then against each full id.
    pub(crate) fn offered_model(&self, model: &str) -> Option<&ClaudeOfferedModel> {
        let model = canonical_model_id(model);
        self.models
            .iter()
            .find(|offered| canonical_model_id(&offered.value) == model)
            .or_else(|| {
                self.models.iter().find(|offered| {
                    offered
                        .resolved_model
                        .as_deref()
                        .is_some_and(|resolved| canonical_model_id(resolved) == model)
                })
            })
    }
}

// `model` trimmed and lowercased, a window suffix such as `-1m` spelled `[1m]` as Claude Code's
// own ids spell it.
fn canonical_model_id(model: &str) -> String {
    let model = model.trim().to_lowercase();
    let window = model.rsplit_once('-').filter(|(_, suffix)| {
        suffix.strip_suffix('m').is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
    });
    match window {
        Some((base, suffix)) => format!("{base}[{suffix}]"),
        None => model,
    }
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

/// One assistant message's usage: its id and its counts so far, which a later reading of the
/// same message raises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeMessageUsageObservation {
    /// The message's id.
    pub(crate) message_id: String,
    /// Its counts so far.
    pub(crate) counts: UsageAxisCounts,
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
    /// An assistant message's usage.
    pub(crate) message_usage: Option<ClaudeMessageUsageObservation>,
    /// The whole `/` list a `system/commands_changed` frame carries again.
    pub(crate) commands_changed: Option<Vec<String>>,
    /// The helper lifecycle signal it carries.
    pub(crate) subagent_lifecycle: Option<ClaudeSubagentLifecycleSignal>,
    /// The helper a `task_updated` frame moves to the background.
    pub(crate) backgrounded_helper_id: Option<String>,
    /// The tool calls a `user` frame's tool results answer.
    pub(crate) answered_call_ids: Vec<String>,

    /// The `system/init` declaration, which rides the observation so routing always sees it.
    pub(crate) handshake: Option<ClaudeHandshakeDeclaration>,
    /// The compaction boundary it carries.
    pub(crate) compaction_boundary: Option<ClaudeCompactionBoundaryObservation>,
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{ClaudeInitializeDeclaration, ClaudeOfferedModel};

    fn offered(value: &str, resolved_model: Option<&str>) -> ClaudeOfferedModel {
        ClaudeOfferedModel {
            value: value.to_owned(),
            resolved_model: resolved_model.map(str::to_owned),
            display_name: None,
            effort_levels: None,
        }
    }

    #[rstest]
    #[case::window_suffix(
        "claude-opus-4-6-1m",
        vec![offered("claude-opus-4-6", None), offered("claude-opus-4-6[1m]", None)],
        Some("claude-opus-4-6[1m]")
    )]
    #[case::full_id(
        "Claude-Sonnet-4-5-20250929",
        vec![offered("sonnet", Some("claude-sonnet-4-5-20250929"))],
        Some("sonnet")
    )]
    #[case::larger_window_unlisted(
        "claude-opus-4-6[1m]",
        vec![offered("claude-opus-4-6", None)],
        None
    )]
    fn a_model_matches_the_offered_row_that_names_it(
        #[case] model: &str,
        #[case] models: Vec<ClaudeOfferedModel>,
        #[case] matched: Option<&str>,
    ) {
        let initialize = ClaudeInitializeDeclaration {
            models,
            ..ClaudeInitializeDeclaration::default()
        };
        assert_eq!(
            initialize
                .offered_model(model)
                .map(|offered| offered.value.as_str()),
            matched
        );
    }
}
