//! A person's answer to a step waiting on them: the engine's door that sends it to the tick, and
//! the tick's intake, which checks it against the wait the step holds in the tick's live record,
//! then makes it the step's resume and its settlement, which the step's turn writes in one write.

use sidekicks_contracts::question::QuestionWaitOutcome;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
use tokio::sync::{mpsc, oneshot};

use super::{PersonWaitAnswer, PersonWaitRefusal, WaitingPersonStep, settle_person_wait};
use crate::engine::tick::commit::RunTurnCommit;
use crate::engine::tick::{EngineTickInput, StepReport, StepReportKind, StepSettlement};
use crate::runs::gate_resolution::{WorkflowGateAnswer, gate_resolution_statement};

/// The engine's door for a person's answer to a step waiting on them, from the session's question
/// card or the run's step panel: the tick settles the wait in one write and replies once it
/// commits, so the first answer through either door settles it.
#[derive(Clone)]
pub struct EngineAnswers {
    inbox: mpsc::Sender<EngineTickInput>,
}

/// Why an answer did not settle its wait; nothing was written.
#[derive(Debug, thiserror::Error)]
pub enum WaitAnswerError {
    /// The step no longer waits on this answer.
    #[error(transparent)]
    Refused(#[from] PersonWaitRefusal),
    /// The engine did not take the answer: its tick has stopped, or dropped the reply when the
    /// answer's write failed.
    #[error("the workflow engine did not take the answer")]
    Closed,
}

impl EngineAnswers {
    /// The door over the tick's `inbox`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(inbox: mpsc::Sender<EngineTickInput>) -> Self {
        Self { inbox }
    }

    /// Answers the form or reply wait `wait_id` with `answer`, given now, and returns once the
    /// write that settles it commits. Refused [`PersonWaitRefusal::NotWaiting`] when no live step
    /// waits on it as this answer's kind, and [`WaitAnswerError::Closed`] when the tick did not
    /// take it.
    pub async fn answer_wait(
        &self,
        wait_id: UuidTextForm,
        answer: PersonWaitAnswer,
    ) -> Result<(), WaitAnswerError> {
        let (reply, replied) = oneshot::channel();
        self.inbox
            .send(EngineTickInput::Answer(PersonWaitIntake {
                wait_id,
                answer,
                gate: None,
                at: WireInstant::now(),
                reply,
            }))
            .await
            .map_err(|_closed| WaitAnswerError::Closed)?;
        replied
            .await
            .map_err(|_dropped| WaitAnswerError::Closed)??;
        Ok(())
    }
}

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
    /// `workflow.gate.resolved`, then the step's resume keyed on its wait id, then for a form or a
    /// reply its question settled `answered`; answers the step's settlement as its report, which
    /// the tick hands to the commit's `report` in the same turn.
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
        match waiting.cause {
            WorkflowWaitCause::Form | WorkflowWaitCause::Reply => {
                commit.settle_wait_question(&waiting.wait_id, QuestionWaitOutcome::Answered, &at);
            }
            // An approval's card is the gate card; nothing else is answered here.
            WorkflowWaitCause::Approval | WorkflowWaitCause::Account | WorkflowWaitCause::Chain => {
            }
        }
        StepReport {
            step: waiting.step,
            at,
            kind: StepReportKind::Settled(settlement),
        }
    }
}
