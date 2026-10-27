//! What a run's end and the session list ask of the plans a run holds: the plans still waiting on
//! a request their run's driver holds, the write that reopens one as its hold ends, and the SQL
//! condition under which a session reads as waiting on a plan's card.

use rusqlite::Connection;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraft;

/// A plan waiting on a request its driver holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HeldPlan {
    /// The plan.
    pub(crate) plan_id: PlanId,
    /// Its session.
    pub(crate) session_id: SessionId,
}

/// The plans store as a run's end and the session list read it.
pub(crate) trait PlanHolds: Send + Sync {
    /// The plans of `run_id` still waiting on a request their driver holds. Fails as SQLite does,
    /// or when a stored id does not read.
    fn read_held_plans_of_run(
        &self,
        connection: &Connection,
        run_id: &RunId,
    ) -> rusqlite::Result<Vec<HeldPlan>>;

    /// `plan.hold.ended` for `held`, for `reason`, with the statement that reopens it.
    fn hold_end_write(
        &self,
        held: HeldPlan,
        reason: PlanHoldEndedReason,
    ) -> (WriteStatement, SessionEventDraft);

    /// The SQL condition, true while the session whose id `session_id_sql` reads has a plan whose
    /// card waits on the person.
    fn waiting_plan_sql(&self, session_id_sql: &str) -> String;
}

/// A plans store that holds no plan, for tests whose runs hold none.
#[cfg(test)]
pub(crate) struct NoPlanHolds;

#[cfg(test)]
impl PlanHolds for NoPlanHolds {
    fn read_held_plans_of_run(
        &self,
        _connection: &Connection,
        _run_id: &RunId,
    ) -> rusqlite::Result<Vec<HeldPlan>> {
        Ok(Vec::new())
    }

    fn hold_end_write(
        &self,
        _held: HeldPlan,
        _reason: PlanHoldEndedReason,
    ) -> (WriteStatement, SessionEventDraft) {
        unreachable!("a store that holds no plan is never asked to end a hold")
    }

    fn waiting_plan_sql(&self, _session_id_sql: &str) -> String {
        "0".to_owned()
    }
}
