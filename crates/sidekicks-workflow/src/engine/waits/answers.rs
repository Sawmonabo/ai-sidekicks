//! A person's answer to a step waiting on them, as the tick takes it in: checked against the wait
//! the step holds in the tick's live record, then made the step's resume and its settlement, which
//! the step's turn writes in one write.

use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use tokio::sync::oneshot;

use super::{PersonWaitAnswer, PersonWaitRefusal, WaitingPersonStep, settle_person_wait};
use crate::engine::tick::commit::RunTurnCommit;
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::runs::gate_resolution::{WorkflowGateAnswer, gate_resolution_statement};

/// A person's answer as the tick's inbox takes it: the wait it names, the answer, an approval
/// card's gate answer, when it was given and where the tick replies once the answer is settled.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct PersonWaitIntake {
    /// The wait the answer names.
    pub(crate) wait_id: UuidTextForm,
    /// The answer.
    pub(crate) answer: PersonWaitAnswer,
    /// The gate answer's row an approval card's answer carries; `None` for a form or a reply.
    pub(crate) gate: Option<WorkflowGateAnswer>,
    /// When the person answered.
    pub(crate) at: WireInstant,
    /// Where the tick replies: settled, or refused because the step no longer waits on it.
    pub(crate) reply: oneshot::Sender<Result<(), PersonWaitRefusal>>,
}

/// An answer that settles its step: the step's resume, an approval's gate answer before it, and
/// the step's `Completed` settlement after.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct AnsweredStep {
    /// The waiting step the answer resumes.
    waiting: WaitingPersonStep,
    /// An approval's gate answer, whose row and event come first.
    gate: Option<WorkflowGateAnswer>,
    /// When the person answered.
    at: WireInstant,
    /// The step's settlement on the answer.
    settlement: StepSettlement,
}

/// The answer of `intake` to `waiting`, the step its wait id names, on the step's `input`, made
/// the step's resume and settlement. Refused `NotWaiting`, nothing written, as
/// [`settle_person_wait`] refuses, and also when an approval comes without its gate answer or with
/// one whose outcome differs from its decision, or a form or a reply comes with one.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn answered_step(
    waiting: &WaitingPersonStep,
    intake: &PersonWaitIntake,
    input: Vec<WorkflowItem>,
) -> Result<AnsweredStep, PersonWaitRefusal> {
    let is_gate_answer_its_own = match (&intake.answer, &intake.gate) {
        (PersonWaitAnswer::Approval(decision), Some(gate)) => gate.outcome == *decision,
        (PersonWaitAnswer::Form(_) | PersonWaitAnswer::Reply(_), None) => true,
        (PersonWaitAnswer::Approval(_), None)
        | (PersonWaitAnswer::Form(_) | PersonWaitAnswer::Reply(_), Some(_)) => false,
    };
    if !is_gate_answer_its_own {
        return Err(PersonWaitRefusal::NotWaiting);
    }
    let settlement = settle_person_wait(waiting, intake.answer.clone(), &intake.at, input)?;
    Ok(AnsweredStep {
        waiting: waiting.clone(),
        gate: intake.gate.clone(),
        at: intake.at.clone(),
        settlement,
    })
}

impl AnsweredStep {
    /// Writes the answer into `commit` in its order: an approval's gate answer row and
    /// `workflow.gate.resolved`, then the step's resume keyed on its wait id; answers the step's
    /// settlement as its report, which the tick hands to the commit's `report` in the same turn.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn resume(self, commit: &mut RunTurnCommit) -> StepReport {
        let Self {
            waiting,
            gate,
            at,
            settlement,
        } = self;
        if let Some(gate) = &gate {
            commit.answer_gate(gate, vec![gate_resolution_statement(gate)], &at);
        }
        commit.resume_step(&waiting.step, Some(&waiting.wait_id), waiting.cause, &at);
        StepReport {
            step: waiting.step,
            at,
            kind: StepReportKind::Settled(settlement),
        }
    }
}
