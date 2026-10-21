//! The plan table as a rebuild writes it from the session's log: each plan from its
//! `plan.proposed`, each verdict from its `plan.accepted`, `plan.kept` or `plan.handedOff`, and
//! each lost hold from its `plan.hold.ended`. Every row is written at the event's own instant
//! through the live write's own statements and guards, so the rows a rebuild writes are the rows
//! the live writes wrote.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::PlanState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::database::statement::{StatementBindings, WriteStatement};
use crate::plans::store::{end_hold_statement, insert_plan_statement, settle_verdict_statement};
use crate::recovery::projection_rebuild::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
const CLEAR_PLANS_SQL: &str = "DELETE FROM plans WHERE session_id = ?";

// Every type the fold reads: a plan, its three verdicts and its lost hold.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
const PLAN_EVENT_TYPES: [SessionEventType; 5] = [
    SessionEventType::PlanProposed,
    SessionEventType::PlanAccepted,
    SessionEventType::PlanKept,
    SessionEventType::PlanHandedOff,
    SessionEventType::PlanHoldEnded,
];

/// The `plans` rows as a rebuild replaces them. Its fold keeps no state, so the projection is its
/// own fold.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
pub(crate) struct PlansProjection;

impl SessionProjection for PlansProjection {
    fn name(&self) -> &'static str {
        "plans"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &PLAN_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_PLANS_SQL),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for PlansProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let occurred_at =
            WireInstant::try_from(envelope.occurred_at.as_str().to_owned()).map_err(|refusal| {
                ProjectionContradiction(format!("the event's instant does not read: {refusal}"))
            })?;
        if let SessionEvent::PlanProposed(proposed) = event {
            statements.push(insert_plan_statement(proposed, &occurred_at));
        } else if let SessionEvent::PlanAccepted(accepted) = event {
            statements.push(settle_verdict_statement(
                &accepted.plan_id,
                PlanState::Accepted,
                None,
                &accepted.device_id,
                &occurred_at,
            ));
        } else if let SessionEvent::PlanKept(kept) = event {
            statements.push(settle_verdict_statement(
                &kept.plan_id,
                PlanState::Open,
                None,
                &kept.device_id,
                &occurred_at,
            ));
        } else if let SessionEvent::PlanHandedOff(handed_off) = event {
            statements.push(settle_verdict_statement(
                &handed_off.plan_id,
                PlanState::HandedOff,
                Some(&handed_off.fresh_session_id),
                &handed_off.device_id,
                &occurred_at,
            ));
        } else if let SessionEvent::PlanHoldEnded(hold_ended) = event {
            statements.push(end_hold_statement(&hold_ended.plan_id));
        }
        Ok(())
    }
}
