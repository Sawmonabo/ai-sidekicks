//! The restart's take-back of a waiting step's wait: an account wait's agent run with the records
//! it kept, a form's or a reply's open question, asked again where it is gone, and an approval's
//! pause point taken again before its card is raised again.

use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::replay::ReplayedAsk;
use crate::engine::event_record::EngineFault;
use crate::engine::ports::PortError;
use crate::engine::start::ReloadedStep;
use crate::engine::tick::ParkedAgentRun;
use crate::engine::tick::live_runs::{LiveRun, LiveStep, TurnAsk};
use crate::engine::tick::turns::EngineTick;
use crate::engine::waits::OpenedPersonWait;
use crate::kinds::step_context::StepRecords;

impl EngineTick {
    /// Takes the wait of `live_step`, a waiting step of `live`, back from `row` and what its
    /// suspension stored: an account wait's agent run with the records it kept and its resume
    /// where it reads, a wait whose resume does not read kept off the clock; a form's or a reply's
    /// open question, asked again where it is no longer open; an approval asked again. Answers
    /// `false` where the agent run is not there to take back, which the sweep fails as crashed.
    pub(super) async fn take_wait_back(
        &mut self,
        live: &mut LiveRun,
        live_step: &mut LiveStep,
        row: &ReloadedStep,
        (records, asked): (Option<StepRecords>, Option<ReplayedAsk>),
    ) -> bool {
        let step = live_step.step.clone();
        match row.wait_cause {
            Some(WorkflowWaitCause::Account) => {
                match &row.resume_at {
                    Some(Ok(resume_at)) => live_step.resume_at = Some(resume_at.clone()),
                    Some(Err(unreadable)) => {
                        live.record
                            .fault(Some(&step), EngineFault::ResumeUnreadable, unreadable)
                            .await;
                        self.deadlines.skip_run(live.scope.run_id);
                    }
                    None => {}
                }
                let reattached = self.dispatch.reattach_agent_run(&step).await;
                let error = match reattached {
                    Ok(Some(run)) => {
                        live_step.parked_agent_run = Some(ParkedAgentRun {
                            run,
                            records: records.unwrap_or_default(),
                        });
                        return true;
                    }
                    Ok(None) => PortError::from("no agent run is stored for the step"),
                    Err(error) => error,
                };
                live.record
                    .fault(Some(&step), EngineFault::WaitNotReattached, error.as_ref())
                    .await;
                false
            }
            Some(WorkflowWaitCause::Form | WorkflowWaitCause::Reply) => {
                let wait_id = row
                    .wait_id
                    .expect("the reload checked that a person's wait names its wait");
                let reattached = self
                    .person_waits
                    .questions
                    .reattach(live.scope.session_id, wait_id)
                    .await;
                match reattached {
                    Ok(Some(_)) => {}
                    Ok(None) => self.ask_again(live, step, row, asked),
                    Err(error) => {
                        live.record
                            .fault(Some(&step), EngineFault::WaitNotReattached, error.as_ref())
                            .await;
                    }
                }
                true
            }
            Some(WorkflowWaitCause::Approval) => {
                self.ask_again(live, step, row, asked);
                true
            }
            Some(WorkflowWaitCause::Chain) | None => true,
        }
    }

    /// Asks the person again what `step`'s wait asks, `asked` as its suspension stored it, under
    /// the wait id and deadline `row` stores, once the run's next turn writes, as a live turn asks:
    /// an approval takes its pause point again first, which a point already taken keeps, then
    /// raises its card, which a card still standing ignores, and a failed ask fails the step.
    fn ask_again(
        &mut self,
        live: &mut LiveRun,
        step: WorkflowStepKey,
        row: &ReloadedStep,
        asked: Option<ReplayedAsk>,
    ) {
        let ReplayedAsk {
            ask,
            started_at,
            pause_number,
        } = asked.expect("the reload checked that a person's wait has its ask");
        let turn_ask = TurnAsk {
            step,
            opened: OpenedPersonWait {
                wait_id: row
                    .wait_id
                    .expect("the reload checked that a person's wait names its wait"),
                cause: row.wait_cause.expect("a person's wait names its cause"),
                started_at,
                deadline_at: row.wait_deadline_at.clone(),
            },
            ask,
            admission: None,
            is_point_taken: pause_number.is_none(),
        };
        match pause_number {
            Some(pause_number) => self.spawn_pause_point(live, turn_ask, pause_number),
            None => live.pausing.push(turn_ask),
        }
    }
}
