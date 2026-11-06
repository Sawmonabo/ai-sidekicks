//! The inbox path of the tick's loop: a person's answer routed to the run whose live step waits
//! under the wait it names, then made that step's resume and settlement in the run's turn, and
//! replied to once the turn's write commits.

use std::collections::HashMap;

use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{EngineTick, RunTurn};
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::node_settings::main_inputs;
use crate::engine::waits::answers::{PersonWaitIntake, answered_step};
use crate::engine::waits::{PersonWaitRefusal, WaitingPersonStep};

impl EngineTick {
    /// Routes `intake` to the run whose live step waits under the wait it names, the run added
    /// to `order` where it is not there yet, by one scan of the live steps. An answer to a dropped
    /// run's wait is dropped unreplied, which its sender reads as not taken, since the wait may
    /// still hold after the restart; any other wait is answered not waiting at once.
    pub(super) fn route_answer(
        &self,
        intake: PersonWaitIntake,
        order: &mut Vec<WorkflowRunId>,
        answers: &mut HashMap<WorkflowRunId, Vec<PersonWaitIntake>>,
    ) {
        let waiting_run = self.runs.iter().find_map(|(run_id, live)| {
            live.steps
                .values()
                .any(|live_step| live_step.wait_id == Some(intake.wait_id))
                .then_some(*run_id)
        });
        match waiting_run {
            Some(run_id) => {
                if !order.contains(&run_id) {
                    order.push(run_id);
                }
                answers.entry(run_id).or_default().push(intake);
            }
            None if self.dropped_waits.contains(&intake.wait_id) => drop(intake),
            None => {
                let _unheard = intake.reply.send(Err(PersonWaitRefusal::NotWaiting));
            }
        }
    }

    /// Applies `intake` to the run of `live` in `turn`: the step still waiting under its wait
    /// resumes, and the answer's settlement settles it in the same pass, its reply kept for the
    /// write's commit. A refused answer, or one whose step an earlier report settled, is answered
    /// not waiting at once; a refused answer to a wait with a deadline has the clock read again,
    /// so a deadline it came after fires.
    pub(super) async fn apply_answer(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        intake: PersonWaitIntake,
    ) {
        let Some(live_step) = live
            .steps
            .values()
            .find(|live_step| live_step.wait_id == Some(intake.wait_id))
        else {
            let _unheard = intake.reply.send(Err(PersonWaitRefusal::NotWaiting));
            return;
        };
        let waiting = WaitingPersonStep {
            step: live_step.step.clone(),
            wait_id: intake.wait_id,
            cause: live_step
                .wait_cause
                .expect("a step under a person wait waits on its cause"),
            deadline_at: live_step.wait_deadline_at.clone(),
        };
        let node = live
            .scope
            .nodes
            .get(&waiting.step.node_id)
            .expect("a step's node is the run's");
        // The one copy an answer makes: the items it settles the step with.
        let input = main_inputs(self.spec(node), &live_step.inputs)
            .next()
            .cloned()
            .unwrap_or_default();
        match answered_step(&waiting, &intake, input) {
            Ok(answered) => {
                let report = answered.resume(&mut turn.commit);
                live.move_step(
                    waiting.step.execution_index.get(),
                    WorkflowStepStatus::Running,
                    None,
                );
                self.apply_report(live, turn, report).await;
                turn.replies.push(intake.reply);
            }
            Err(refusal) => {
                let _unheard = intake.reply.send(Err(refusal));
                if waiting.deadline_at.is_some() {
                    live.needs_deadline_read = true;
                }
            }
        }
    }
}
