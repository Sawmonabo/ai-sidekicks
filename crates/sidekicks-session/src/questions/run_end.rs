//! The provider requests a run's end lets go, settled in the write that ends the run, so no daemon
//! death between the end and the settle leaves one open: each question its agent waits on that the
//! run holds open, or that waits for the run, is canceled, each plan still waiting on a request the
//! run's driver held is reopened, and each choice its provider asked and no answer settled is
//! settled with none. The reason is the end's own: `interrupted` (`canceled` for the retry-or-edit
//! choice) for every interrupted end, `runEnded` for any other, a restart's among them. A question
//! its agent does not wait for stays open, since a queued message answers it after the run.

use std::sync::Arc;

use sidekicks_contracts::plan::PlanHoldEndedReason;
use sidekicks_contracts::question::{QuestionCanceledReason, QuestionSettledState};
use sidekicks_contracts::run::state::RunState;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use crate::plan_holds::PlanHolds;
use crate::questions::service::canceled_event;
use crate::questions::store::{read_unsettled_held_questions, settle_question_statement};
use crate::run::engine::RunEngineError;
use crate::run::provider_choice::read_open_choice_settlements;
use crate::run::read::RunStateReader;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

/// Adds to `companions`, the write of `change`, a run's end, the settle of every held question,
/// holding plan `plan_holds` reads and unsettled choice of the run but the choices the companions
/// settle, each guarded on the state it was read in. Fails as the read fails or an event cannot be
/// drafted.
pub(crate) async fn settle_held_requests_at_run_end(
    pool: &DatabaseReadPool,
    plan_holds: &Arc<dyn PlanHolds>,
    change: &RunStateChange,
    companions: &mut RunStateChangeCompanions,
) -> Result<(), RunEngineError> {
    let run_id = change.run_id;
    let end = RunState::from(change.entry.state());
    let is_interrupted = end == RunState::Interrupted;
    let settled_choices = companions.settled_choices.clone();
    let read_holds = Arc::clone(plan_holds);
    let (questions, plans, choices) = pool
        .read(ReadLength::Short, move |reader| {
            let choices = match RunStateReader::new(reader).read_run(&run_id)? {
                Some(run) => read_open_choice_settlements(
                    reader,
                    run.session_id,
                    run_id,
                    end,
                    &settled_choices,
                )?,
                None => Vec::new(),
            };
            Ok::<_, RunEngineError>((
                read_unsettled_held_questions(reader, &run_id)?,
                read_holds.read_held_plans_of_run(reader, &run_id)?,
                choices,
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
        companions.preceding_events.push(canceled_event(
            question.session_id,
            question.question_id,
            question_reason,
        )?);
    }
    for plan in plans {
        let (statement, event) = plan_holds.hold_end_write(plan, plan_reason);
        companions.statements.push(statement);
        companions.preceding_events.push(event);
    }
    for choice in choices {
        companions.statements.push(choice.guard);
        companions.preceding_events.push(choice.event);
    }
    Ok(())
}
