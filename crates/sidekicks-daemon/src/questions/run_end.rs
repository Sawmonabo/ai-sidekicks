//! The provider requests a run's end lets go, settled in the write that ends the run, so no daemon
//! death between the end and the settle leaves one open: each question the run holds open and its
//! agent waits on is canceled, and each plan still waiting on a request the run's driver held is
//! reopened. The reason is the end's own: `interrupted` for every interrupted end, `runEnded` for
//! any other, a restart's among them. A question its agent does not wait for stays open, since a
//! queued message answers it after the run.

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::PlanHoldEndedReason;
use sidekicks_contracts::question::{
    QuestionCanceledPayload, QuestionCanceledReason, QuestionSettledState,
};
use sidekicks_contracts::run::state::RunState;

use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::events::session::appender::SessionEventDraft;
use crate::plans::store::{hold_end_write, read_held_plans_of_run};
use crate::questions::store::{read_open_held_questions, settle_question_statement};
use crate::session::run::engine::RunEngineError;
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions};

/// Adds to `companions`, the write of `change`, a run's end, the settle of every held question
/// and holding plan of the run, each guarded on the state it was read in. Fails as the read fails
/// or an event cannot be drafted.
pub(crate) async fn settle_held_requests_at_run_end(
    pool: &DatabaseReadPool,
    change: &RunStateChange,
    companions: &mut RunStateChangeCompanions,
) -> Result<(), RunEngineError> {
    let run_id = change.run_id;
    let is_interrupted = RunState::from(change.entry.state()) == RunState::Interrupted;
    let (questions, plans) = pool
        .read(ReadLength::Short, move |reader| {
            Ok::<_, RunEngineError>((
                read_open_held_questions(reader, &run_id)?,
                read_held_plans_of_run(reader, &run_id)?,
            ))
        })
        .await?;
    let (question_reason, plan_reason) = if is_interrupted {
        (
            QuestionCanceledReason::Interrupted,
            PlanHoldEndedReason::Interrupted,
        )
    } else {
        (
            QuestionCanceledReason::RunEnded,
            PlanHoldEndedReason::RunEnded,
        )
    };
    for question in questions {
        companions.statements.push(settle_question_statement(
            &question.question_id,
            QuestionSettledState::Canceled,
        ));
        companions
            .preceding_events
            .push(SessionEventDraft::of_session(
                question.session_id,
                &SessionEvent::QuestionCanceled(QuestionCanceledPayload {
                    session_id: question.session_id,
                    question_id: question.question_id,
                    reason: question_reason,
                }),
            )?);
    }
    for plan in plans {
        let (statement, event) = hold_end_write(plan, plan_reason);
        companions.statements.push(statement);
        companions.preceding_events.push(event);
    }
    Ok(())
}
