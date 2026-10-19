//! What a Codex turn's settling `turn/completed` frame proves about how the turn ended, and the
//! run's end and the turn's end it reports: the one place a Codex turn's end becomes a run state
//! change.

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::contract::bound_failure_detail;
use crate::provider::inbound_json::decode_inbound_json;
use crate::provider::terminal_emission_gate::{
    TerminalEmissionDecision, TerminalEmissionGate, TerminalRunFrame,
};
use crate::provider::thread_frame_router::ThreadFrameRoute;
use crate::provider::turn_evidence::{
    TurnEvidenceClass, TurnEvidenceClassification, UNRECOGNIZED_TURN_EVIDENCE,
    observed_turn_evidence,
};
use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

/// The item type that is the model's output; the `userMessage` echo is not.
const CODEX_MODEL_OUTPUT_ITEM_TYPE: &str = "agentMessage";

/// What every item notification's method starts with.
const CODEX_ITEM_METHOD_PREFIX: &str = "item/";

/// The detail of a failed turn whose error message is blank and for which Codex said nothing else.
static BLANK_TURN_ERROR_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("Codex failed the turn without saying why".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// The turn statuses Codex sends, read from its open string; any other word reads as none.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CodexTurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

impl CodexTurnStatus {
    fn read(status: &str) -> Option<Self> {
        match status {
            "completed" => Some(Self::Completed),
            "interrupted" => Some(Self::Interrupted),
            "failed" => Some(Self::Failed),
            "inProgress" => Some(Self::InProgress),
            _ => None,
        }
    }
}

/// The members of `turn/completed`'s params the reading uses.
#[derive(Deserialize)]
struct TurnCompletedParams {
    turn: CompletedTurn,
}

/// The settled turn: its status, its items where loaded, and its error where it failed.
#[derive(Deserialize)]
struct CompletedTurn {
    status: String,
    #[serde(default)]
    items: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

impl CompletedTurn {
    // The error's message where it carries one as text: only its presence is evidence, since the
    // words are the provider's prose.
    fn error_message(&self) -> Option<&str> {
        self.error.as_ref()?.get("message")?.as_str()
    }

    fn has_model_output(&self) -> bool {
        self.items
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some(CODEX_MODEL_OUTPUT_ITEM_TYPE)
                })
            })
    }
}

/// The members of an item notification's params the reading uses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemNotificationParams {
    turn_id: String,
    item: ItemHead,
}

/// The one member of an item the reading uses.
#[derive(Deserialize)]
struct ItemHead {
    #[serde(rename = "type")]
    item_type: String,
}

// The settled turn in `turn/completed`'s params text; `None` when the params cannot be read.
fn read_completed_turn(params: &str) -> Option<CompletedTurn> {
    serde_json::from_str::<TurnCompletedParams>(&decode_inbound_json(params.as_bytes()))
        .ok()
        .map(|params| params.turn)
}

/// One in-flight reading that a turn is producing model output, keyed by the turn it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexTurnEvidenceObservation {
    /// The turn the item belongs to.
    pub(crate) turn_id: String,
    /// What the item proves.
    pub(crate) observation: TurnEvidenceClass,
}

/// Reads one in-flight notification's `params` JSON text for evidence that its turn produces model
/// output: an `agentMessage` item, never the `userMessage` echo. `None` for any other frame, or
/// params that cannot be read; the evidence accrues mid-turn because `turn/completed` can carry no
/// items at all.
#[expect(
    dead_code,
    reason = "the Codex event reader accrues each turn's output evidence before it settles"
)]
pub(crate) fn classify_codex_turn_evidence_observation(
    method: &str,
    params: &str,
) -> Option<CodexTurnEvidenceObservation> {
    if !method.starts_with(CODEX_ITEM_METHOD_PREFIX) {
        return None;
    }
    let ItemNotificationParams { turn_id, item } =
        serde_json::from_str::<ItemNotificationParams>(&decode_inbound_json(params.as_bytes()))
            .ok()?;
    (!turn_id.is_empty() && item.item_type == CODEX_MODEL_OUTPUT_ITEM_TYPE).then_some(
        CodexTurnEvidenceObservation {
            turn_id,
            observation: TurnEvidenceClass::ModelOutput,
        },
    )
}

/// Reads a settling `turn/completed`'s `params` JSON text for typed evidence that a model turn
/// happened; unrecognized when the params cannot be read or the status is not one Codex sends.
/// No message text is read, and the turn's duration is no evidence: a quota-spent turn has one.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex event reader classifies each settled turn"
    )
)]
pub(crate) fn classify_codex_turn_evidence(params: &str) -> TurnEvidenceClassification {
    read_completed_turn(params).map_or(UNRECOGNIZED_TURN_EVIDENCE, |turn| {
        classify_completed_turn(&turn)
    })
}

fn classify_completed_turn(turn: &CompletedTurn) -> TurnEvidenceClassification {
    let Some(status) = CodexTurnStatus::read(&turn.status) else {
        return UNRECOGNIZED_TURN_EVIDENCE;
    };
    let mut observations = Vec::new();
    if turn.has_model_output() {
        observations.push(TurnEvidenceClass::ModelOutput);
    }
    let is_declared_failure = match status {
        // An interrupt need not carry an error, so the status alone declares it.
        CodexTurnStatus::Interrupted => true,
        CodexTurnStatus::Failed => turn.error_message().is_some(),
        // A command the client dispatches reports success too, so completion declares nothing.
        CodexTurnStatus::Completed | CodexTurnStatus::InProgress => false,
    };
    if is_declared_failure {
        observations.push(TurnEvidenceClass::DeclaredTurnFailure);
    }
    observed_turn_evidence(&observations)
}

/// What a session turn's end is composed from: the frame, its run, the turn and its epoch, the
/// router's decision for the frame, and what failed it where Codex's readings name that.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex event reader ends each session turn through it"
    )
)]
pub(crate) struct CodexTurnTerminalInput<'frame> {
    /// The `turn/completed` params' JSON text.
    pub(crate) params: &'frame str,
    /// The run the turn belongs to.
    pub(crate) run_id: RunId,
    /// The turn's epoch, the gate's run version.
    pub(crate) turn_epoch: u64,
    /// The turn's number within its run, as its start was numbered.
    pub(crate) turn_number: SafeInt<1>,
    /// The router's decision for the frame.
    pub(crate) route: ThreadFrameRoute,
    /// Why a failed turn failed where Codex's readings name it: a usage limit or spent retries.
    pub(crate) failure_cause: Option<RunFailureCause>,
    /// Codex's last error message on the turn, for a failed turn whose own error carries none.
    pub(crate) fallback_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
}

/// A session turn's end as the run engine takes it: the run's change and the turn's end.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexTurnTerminal {
    /// The run's change.
    pub(crate) change: RunStateChange,
    /// The turn's end written with it.
    pub(crate) turn_end: ProviderTurnEnd,
}

/// The run's end and the turn's end a settling `turn/completed` reports, admitted through the
/// session's terminal gate: `completed`, `interrupted`, or `failed` with the usage limit or spent
/// retries that failed it. `None` when the gate suppressed it, the params cannot be read, or the
/// status is `inProgress` or one Codex does not send.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex event reader ends each session turn through it"
    )
)]
pub(crate) fn compose_codex_turn_terminal(
    input: CodexTurnTerminalInput<'_>,
    gate: &mut TerminalEmissionGate,
) -> Option<CodexTurnTerminal> {
    let CodexTurnTerminalInput {
        params,
        run_id,
        turn_epoch,
        turn_number,
        route,
        failure_cause,
        fallback_detail,
    } = input;
    let turn = read_completed_turn(params)?;
    let status = CodexTurnStatus::read(&turn.status)?;
    if status == CodexTurnStatus::InProgress {
        return None;
    }
    let frame = TerminalRunFrame {
        run_id,
        run_version: turn_epoch,
        route,
    };
    let is_intended_close = match gate.admit_terminal_frame(&frame) {
        TerminalEmissionDecision::Emit { intended_close } => intended_close,
        TerminalEmissionDecision::Suppressed {} => return None,
    };
    let (change, outcome) = compose_run_end(
        run_id,
        Some(status),
        turn.error_message(),
        RunEnd {
            is_intended_close,
            failure_cause,
            fallback_detail,
        },
    );
    Some(CodexTurnTerminal {
        change,
        turn_end: ProviderTurnEnd {
            turn_number,
            outcome,
        },
    })
}

/// The end a helper's last turn gives its child run, from that turn's `turn/completed` params
/// JSON text: `completed`, `interrupted`, or `failed` for any other status or unreadable params.
/// A helper's turns carry no epoch of the session's runs, so no terminal gate admits it.
#[expect(
    dead_code,
    reason = "the Codex helper roles end each helper's child run through it"
)]
pub(crate) fn compose_codex_child_terminal(child_run_id: RunId, params: &str) -> RunStateChange {
    let turn = read_completed_turn(params);
    let status = turn
        .as_ref()
        .and_then(|turn| CodexTurnStatus::read(&turn.status));
    let (change, _) = compose_run_end(
        child_run_id,
        status,
        turn.as_ref().and_then(CompletedTurn::error_message),
        RunEnd {
            is_intended_close: false,
            failure_cause: None,
            fallback_detail: None,
        },
    );
    change
}

// How a run's end was reached beyond the turn's own status.
struct RunEnd {
    is_intended_close: bool,
    failure_cause: Option<RunFailureCause>,
    fallback_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
}

// A turn's status as its run's change and its turn's end; any status but completed or
// interrupted, or none, fails the run.
fn compose_run_end(
    run_id: RunId,
    status: Option<CodexTurnStatus>,
    turn_error_message: Option<&str>,
    end: RunEnd,
) -> (RunStateChange, TurnOutcome) {
    let intended_close = end.is_intended_close.then(True::default);
    match status {
        Some(CodexTurnStatus::Completed) => (
            RunStateChange::new(run_id, RunStateEntry::Completed { intended_close }),
            TurnOutcome::Completed,
        ),
        Some(CodexTurnStatus::Interrupted) => (
            RunStateChange::new(
                run_id,
                RunStateEntry::Interrupted {
                    intended_close,
                    trigger: None,
                },
            ),
            TurnOutcome::Interrupted(None),
        ),
        Some(CodexTurnStatus::Failed | CodexTurnStatus::InProgress) | None => {
            let provider_failure_detail =
                match turn_error_message.filter(|message| !message.is_empty()) {
                    Some(message) => Some(bound_failure_detail(
                        message,
                        end.fallback_detail
                            .unwrap_or_else(|| BLANK_TURN_ERROR_FALLBACK.clone()),
                    )),
                    None => end.fallback_detail,
                };
            let mut change = RunStateChange::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close,
                    failure_cause: end.failure_cause,
                    provider_failure_detail,
                    process_exit: None,
                },
            );
            change.failure_category = Some(RunFailureCategory::ProviderFailure);
            (change, TurnOutcome::Failed(None))
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::run::control::RunFailureCategory;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{
        CodexTurnTerminal, CodexTurnTerminalInput, classify_codex_turn_evidence,
        compose_codex_turn_terminal,
    };
    use crate::provider::terminal_emission_gate::TerminalEmissionGate;
    use crate::provider::thread_frame_router::ThreadFrameRoute;
    use crate::provider::turn_evidence::TurnEvidenceClass;
    use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
    use crate::session::run::state_change::{RunStateChange, RunStateEntry};

    fn run_id() -> RunId {
        RunId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd").expect("the text is a UUID")
    }

    fn turn_number() -> SafeInt<1> {
        SafeInt::new(3).expect("3 is at least 1")
    }

    fn failed_change(detail: &str) -> RunStateChange {
        let mut change = RunStateChange::new(
            run_id(),
            RunStateEntry::Failed {
                intended_close: None,
                failure_cause: None,
                provider_failure_detail: Some(
                    FreeFormText::new(detail.to_owned()).expect("the detail is non-blank"),
                ),
                process_exit: None,
            },
        );
        change.failure_category = Some(RunFailureCategory::ProviderFailure);
        change
    }

    #[rstest]
    #[case::completed(
        r#"{"turn":{"status":"completed","items":[{"type":"agentMessage"}]}}"#,
        Some((
            RunStateChange::new(run_id(), RunStateEntry::Completed { intended_close: None }),
            TurnOutcome::Completed,
        ))
    )]
    #[case::interrupted(
        r#"{"turn":{"status":"interrupted","items":[]}}"#,
        Some((
            RunStateChange::new(
                run_id(),
                RunStateEntry::Interrupted { intended_close: None, trigger: None },
            ),
            TurnOutcome::Interrupted(None),
        ))
    )]
    #[case::failed(
        r#"{"turn":{"status":"failed","items":[],"error":{"message":"usage limit reached"}}}"#,
        Some((failed_change("usage limit reached"), TurnOutcome::Failed(None)))
    )]
    #[case::in_progress(r#"{"turn":{"status":"inProgress","items":[]}}"#, None)]
    #[case::unknown_status(r#"{"turn":{"status":"paused","items":[]}}"#, None)]
    fn each_status_ends_its_run_and_its_turn(
        #[case] params: &str,
        #[case] expected: Option<(RunStateChange, TurnOutcome)>,
    ) {
        let mut gate = TerminalEmissionGate::new();
        let terminal = compose_codex_turn_terminal(
            CodexTurnTerminalInput {
                params,
                run_id: run_id(),
                turn_epoch: 1,
                turn_number: turn_number(),
                route: ThreadFrameRoute::Project,
                failure_cause: None,
                fallback_detail: None,
            },
            &mut gate,
        );

        let expected = expected.map(|(change, outcome)| CodexTurnTerminal {
            change,
            turn_end: ProviderTurnEnd {
                turn_number: turn_number(),
                outcome,
            },
        });
        assert_eq!(terminal, expected);
    }

    #[rstest]
    #[case::interrupted_without_error(
        r#"{"turn":{"status":"interrupted"}}"#,
        &[TurnEvidenceClass::DeclaredTurnFailure]
    )]
    #[case::failed_without_error(r#"{"turn":{"status":"failed","items":[]}}"#, &[])]
    #[case::failed_with_error(
        r#"{"turn":{"status":"failed","error":{"message":""}}}"#,
        &[TurnEvidenceClass::DeclaredTurnFailure]
    )]
    #[case::completed_with_output(
        concat!(
            r#"{"turn":{"status":"completed","#,
            r#""items":[{"type":"userMessage"},{"type":"agentMessage"}]}}"#
        ),
        &[TurnEvidenceClass::ModelOutput]
    )]
    #[case::in_progress(r#"{"turn":{"status":"inProgress"}}"#, &[])]
    fn a_settled_turn_declares_its_failure_only_by_its_status_and_error(
        #[case] params: &str,
        #[case] observations: &[TurnEvidenceClass],
    ) {
        let evidence = classify_codex_turn_evidence(params);

        assert!(evidence.recognized);
        assert_eq!(evidence.observations, observations);
    }
}
