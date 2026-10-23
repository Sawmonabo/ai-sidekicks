//! How a Claude Code turn ended, read from its settling `result` frame into the run's move and
//! the turn's end: the driver's interrupt and a step-limit stop end it interrupted, a pause that
//! took effect leaves the run paused, a refusal no other model took fails it refused, a declared
//! failure or `is_error` fails it with Claude Code's own words, and a turn too long for the window
//! even after compaction fails naming the message that goes back to the person.

use std::str::FromStr;

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::failure_cause::{ProviderFailureOrigin, RunFailureCause};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::wire::{BoolLiteral, True};
use strum::EnumString;

use crate::provider::driver::claude::event_normalizer::{
    ClaudeWireFrameKind, compose_claude_wire_frame_kind,
};
use crate::provider::driver::claude::turn_evidence::classify_claude_turn_evidence;
use crate::provider::driver::contract::bound_failure_detail;
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::provider::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::provider::record_readers::read_non_empty_string;
use crate::provider::turn_evidence::TurnEvidenceClass;
use crate::session::run::engine::turns::TurnOutcome;
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

/// Why Claude Code's loop ended a turn, the whole union its `result` frame's `terminal_reason`
/// takes; a reason a newer build adds reads as none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, EnumString)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum ClaudeTerminalReason {
    /// The context was blocked at its limit.
    BlockingLimit,
    /// The refill breaker stopped a tight loop.
    RapidRefillBreaker,
    /// The prompt was too long for the window.
    PromptTooLong,
    /// An image could not be read.
    ImageError,
    /// The model failed.
    ModelError,
    /// The API failed.
    ApiError,
    /// Malformed tool calls were retried until spent.
    MalformedToolUseExhausted,
    /// An interrupt stopped the response mid-stream.
    AbortedStreaming,
    /// An interrupt stopped the tool calls.
    AbortedTools,
    /// A stop hook prevented the end.
    StopHookPrevented,
    /// A hook stopped the turn.
    HookStopped,
    /// A tool call was deferred.
    ToolDeferred,
    /// The turn bound was reached.
    MaxTurns,
    /// The work moved to the background.
    BackgroundRequested,
    /// The turn completed.
    Completed,
    /// The spend budget ran out.
    BudgetExhausted,
    /// Structured output was retried until spent.
    StructuredOutputRetryExhausted,
    /// A deferred tool was unavailable.
    ToolDeferredUnavailable,
    /// The turn's setup failed.
    TurnSetupFailed,
}

impl ClaudeTerminalReason {
    /// A turn too long to fit even after compaction, which Claude Code keeps until it is cut.
    pub(crate) const fn is_too_long(self) -> bool {
        matches!(self, Self::PromptTooLong | Self::BlockingLimit)
    }

    /// An interrupt stopped the turn's response or its tool calls.
    pub(crate) const fn is_interrupt(self) -> bool {
        matches!(self, Self::AbortedStreaming | Self::AbortedTools)
    }
}

// The members of a `result` frame the reader reads before the frame is queued.
#[derive(Deserialize)]
struct ResultNaming {
    #[serde(default, deserialize_with = "read_lenient")]
    user_message_uuids: Option<LenientList<String>>,
}

lenient_object!(ResultNaming);

/// The messages a lead `result` names as taken into the turn it ends, by uuid; none when the frame
/// names none or is no object.
pub(crate) fn read_claude_result_message_uuids(text: &str) -> Vec<String> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    <ResultNaming as Lenient>::read(&mut deserializer)
        .ok()
        .flatten()
        .and_then(|naming| naming.user_message_uuids)
        .map(|uuids| uuids.0)
        .unwrap_or_default()
}

/// What decided a turn's end besides its `result` frame.
#[derive(Clone, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each mark is its own fact about the turn, read alone"
)]
pub(crate) struct ClaudeTurnEndMarks {
    /// The driver's own interrupt is stopping the run's turn.
    pub(crate) is_interrupted: bool,
    /// The daemon sent an interrupt on this turn whose end it writes from the interrupt's answer.
    pub(crate) is_held_for_interrupt: bool,
    /// The terminal gate said the turn's end closes a run the person meant to close.
    pub(crate) is_intended_close: bool,
    /// The run's pause took effect as this turn ended.
    pub(crate) is_pause_effect: bool,
    /// The run already rests paused: Claude Code started this turn by itself.
    pub(crate) is_resting_paused: bool,
    /// The refusal no other model took, which ends the turn refused.
    pub(crate) refusal: Option<RunFailureCause>,
    /// Claude Code spent its own retries on the turn.
    pub(crate) is_retries_spent: bool,
    /// The newest message the session was sent, which a turn too long to fit hands back.
    pub(crate) newest_message_id: Option<String>,
}

/// A turn's end as its `result` and marks compose it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeTurnEnd {
    /// The run's move; `None` for a turn Claude Code started by itself on a paused run, whose end
    /// moves no run.
    pub(crate) change: Option<RunStateChange>,
    /// The turn's own end.
    pub(crate) outcome: TurnOutcome,
    /// Whether it is the end of the daemon's own interrupt, which the daemon may have written.
    pub(crate) is_daemon_interrupt_end: bool,
    /// The turn did not fit even after compaction, so Claude Code keeps a message turns fail on.
    pub(crate) is_too_long: bool,
}

/// Composes the end one settling `result` frame of `run_id` asks for under `marks`.
pub(crate) fn compose_claude_turn_end(
    frame: &Value,
    run_id: RunId,
    marks: ClaudeTurnEndMarks,
) -> ClaudeTurnEnd {
    let members = frame.as_object();
    let subtype = members.and_then(|frame| read_non_empty_string(frame, "subtype"));
    let terminal_reason = members
        .and_then(|frame| read_non_empty_string(frame, "terminal_reason"))
        .and_then(|reason| ClaudeTerminalReason::from_str(reason).ok());
    let intended_close = marks.is_intended_close.then_some(BoolLiteral);
    let interrupted = |trigger, outcome, is_daemon_interrupt_end| ClaudeTurnEnd {
        change: Some(RunStateChange::new(
            run_id,
            RunStateEntry::Interrupted {
                intended_close,
                trigger,
            },
        )),
        outcome,
        is_daemon_interrupt_end,
        is_too_long: false,
    };
    if marks.is_interrupted {
        return interrupted(None, TurnOutcome::Interrupted(None), true);
    }
    if subtype == Some("error_max_turns") {
        return interrupted(
            Some(InterruptReason::StepLimit),
            TurnOutcome::Interrupted(Some(TurnEndCause::StepLimit)),
            false,
        );
    }
    if subtype == Some("error_during_execution")
        && marks.is_held_for_interrupt
        && terminal_reason.is_some_and(ClaudeTerminalReason::is_interrupt)
    {
        return interrupted(None, TurnOutcome::Interrupted(None), true);
    }
    // A `result` of a subtype the census does not list still ends its turn, as a failure that
    // names the subtype, so a turn's end never vanishes.
    let unlisted_subtype =
        match ClaudeWireFrameKind::read(&compose_claude_wire_frame_kind("result", subtype)) {
            Some(ClaudeWireFrameKind::ResultUnlisted { subtype }) => Some(subtype),
            _ => None,
        };
    let is_too_long = terminal_reason.is_some_and(ClaudeTerminalReason::is_too_long);
    let (mut change, outcome, is_failed) = match marks.refusal {
        Some(refusal) => (
            RunStateChange {
                failure_category: Some(RunFailureCategory::Refused),
                ..RunStateChange::new(run_id, failed_entry(Some(refusal), None))
            },
            TurnOutcome::Failed(None),
            true,
        ),
        None if unlisted_subtype.is_some() || is_declared_failure(frame) => {
            let cause = if is_too_long {
                marks
                    .newest_message_id
                    .and_then(|message_id| FreeFormText::new(message_id).ok())
                    .map(
                        |returned_message_id| RunFailureCause::ContextWindowExceeded {
                            origin: ProviderFailureOrigin::Value,
                            returned_message_id,
                        },
                    )
            } else {
                marks
                    .is_retries_spent
                    .then_some(RunFailureCause::RetriesExhausted {
                        origin: ProviderFailureOrigin::Value,
                    })
            };
            let words = describe_turn_failure(members);
            let detail = bound_failure_detail(
                &match unlisted_subtype {
                    Some(subtype) if words != subtype => format!("{subtype}: {words}"),
                    Some(_) | None => words,
                },
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            );
            (
                RunStateChange {
                    failure_category: Some(RunFailureCategory::ProviderFailure),
                    ..RunStateChange::new(run_id, failed_entry(cause, Some(detail)))
                },
                TurnOutcome::Failed(None),
                true,
            )
        }
        None => (
            RunStateChange::new(
                run_id,
                RunStateEntry::Completed {
                    intended_close: None,
                },
            ),
            TurnOutcome::Completed,
            false,
        ),
    };
    set_intended_close(&mut change.entry, intended_close);
    if marks.is_pause_effect && !is_failed {
        change = RunStateChange {
            expected_state: Some(RunState::Pausing),
            ..RunStateChange::new(run_id, RunStateEntry::Paused)
        };
    } else if marks.is_resting_paused && !marks.is_pause_effect {
        return ClaudeTurnEnd {
            change: None,
            outcome,
            is_daemon_interrupt_end: false,
            is_too_long: false,
        };
    }
    ClaudeTurnEnd {
        change: Some(change),
        outcome,
        is_daemon_interrupt_end: false,
        is_too_long: is_too_long && is_failed,
    }
}

// The turn evidence's declared failure, or `is_error`: the refill breaker's `result` reads
// `success` with `is_error`.
fn is_declared_failure(frame: &Value) -> bool {
    classify_claude_turn_evidence(frame)
        .observations
        .contains(&TurnEvidenceClass::DeclaredTurnFailure)
        || frame.get("is_error").and_then(Value::as_bool) == Some(true)
}

fn failed_entry(
    failure_cause: Option<RunFailureCause>,
    provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
) -> RunStateEntry {
    RunStateEntry::Failed {
        intended_close: None,
        failure_cause,
        provider_failure_detail,
        process_exit: None,
    }
}

fn set_intended_close(entry: &mut RunStateEntry, intended: Option<True>) {
    match entry {
        RunStateEntry::Completed { intended_close }
        | RunStateEntry::Interrupted { intended_close, .. }
        | RunStateEntry::Stopped { intended_close, .. }
        | RunStateEntry::Failed { intended_close, .. } => *intended_close = intended,
        RunStateEntry::Starting
        | RunStateEntry::Running { .. }
        | RunStateEntry::WaitingForApproval
        | RunStateEntry::WaitingForInput
        | RunStateEntry::Pausing
        | RunStateEntry::Paused => {}
    }
}

// Claude Code's own words for a failed turn: the `result` text, else its `errors`, else the
// terminal reason, else the subtype.
fn describe_turn_failure(frame: Option<&Map<String, Value>>) -> String {
    let Some(frame) = frame else {
        return String::new();
    };
    let errors = frame
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|errors| !errors.is_empty());
    read_non_empty_string(frame, "result")
        .map(str::to_owned)
        .or(errors)
        .or_else(|| read_non_empty_string(frame, "terminal_reason").map(str::to_owned))
        .or_else(|| read_non_empty_string(frame, "subtype").map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::orchestration::InterruptReason;
    use sidekicks_contracts::run::control::RunFailureCategory;
    use sidekicks_contracts::run::events::TurnEndCause;

    use super::{ClaudeTurnEndMarks, compose_claude_turn_end};
    use crate::provider::driver::claude::session::scripted::mint_run_id;
    use crate::session::run::engine::turns::TurnOutcome;
    use crate::session::run::state_change::RunStateEntry;

    // Killed by ending a turn stopped at its step bound `failed`, as a declared failure would.
    #[test]
    fn a_turn_stopped_at_its_step_bound_ends_interrupted_at_the_step_limit() {
        let run_id = mint_run_id();
        let frame = json!({"type": "result", "subtype": "error_max_turns", "is_error": true});

        let end = compose_claude_turn_end(&frame, run_id, ClaudeTurnEndMarks::default());

        let change = end.change.expect("the run moves");
        assert_eq!(
            change.entry,
            RunStateEntry::Interrupted {
                intended_close: None,
                trigger: Some(InterruptReason::StepLimit),
            }
        );
        assert_eq!(
            end.outcome,
            TurnOutcome::Interrupted(Some(TurnEndCause::StepLimit))
        );
        assert!(!end.is_daemon_interrupt_end);
    }

    // Killed by reading an execution error as the daemon's interrupt without its mark, and by
    // failing the run the daemon's own interrupt stopped.
    #[test]
    fn an_execution_error_ends_interrupted_only_under_the_daemons_interrupt() {
        let run_id = mint_run_id();
        let frame = json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "terminal_reason": "aborted_streaming",
        });

        let held = compose_claude_turn_end(
            &frame,
            run_id,
            ClaudeTurnEndMarks {
                is_held_for_interrupt: true,
                ..ClaudeTurnEndMarks::default()
            },
        );
        let unmarked = compose_claude_turn_end(&frame, run_id, ClaudeTurnEndMarks::default());

        assert_eq!(held.outcome, TurnOutcome::Interrupted(None));
        assert!(held.is_daemon_interrupt_end);
        assert!(matches!(
            held.change.expect("the run moves").entry,
            RunStateEntry::Interrupted { trigger: None, .. }
        ));
        assert_eq!(unmarked.outcome, TurnOutcome::Failed(None));
        assert!(!unmarked.is_daemon_interrupt_end);
    }

    // Killed by completing a `success` that carries `is_error`, as the refill breaker's does.
    #[test]
    fn a_success_carrying_is_error_fails_the_run_with_claude_codes_words() {
        let run_id = mint_run_id();
        let frame = json!({
            "type": "result",
            "subtype": "success",
            "is_error": true,
            "result": "the request was stopped in a tight loop",
        });

        let end = compose_claude_turn_end(&frame, run_id, ClaudeTurnEndMarks::default());

        let change = end.change.expect("the run moves");
        assert_eq!(
            change.failure_category,
            Some(RunFailureCategory::ProviderFailure)
        );
        let RunStateEntry::Failed {
            provider_failure_detail,
            ..
        } = change.entry
        else {
            unreachable!("the run fails")
        };
        assert_eq!(
            provider_failure_detail.map(|detail| detail.as_str().to_owned()),
            Some("the request was stopped in a tight loop".to_owned())
        );
        assert_eq!(end.outcome, TurnOutcome::Failed(None));
    }
}
