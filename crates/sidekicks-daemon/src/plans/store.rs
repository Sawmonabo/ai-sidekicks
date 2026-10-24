//! The plan row's writes, each the statement its event's live write and a rebuild's fold share,
//! with the guards the live write keeps, and the reads of the plans whose held request a run's end
//! or a restart lets go.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{
    PlanHoldEndedPayload, PlanHoldEndedReason, PlanId, PlanProposedPayload, PlanState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::database::session_scope::SessionScopedSql;
use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::text_column;
use crate::events::session::appender::SessionEventDraft;

static INSERT_PLAN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO plans
  (id, session_id, run_id, artifact_id, title, holds_request, state, created_at)
  VALUES (@id, @sessionId, @runId, @artifactId, @title, @holdsRequest, '{waiting}', @createdAt)",
        waiting = <&'static str>::from(PlanState::Waiting)
    )
});

// Reopens a plan only while it waits on a request its driver holds.
static END_HOLD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE plans SET state = '{open}'
  WHERE id = @planId AND state = '{waiting}' AND holds_request = 1",
        open = <&'static str>::from(PlanState::Open),
        waiting = <&'static str>::from(PlanState::Waiting)
    )
});

// Settles a waiting plan with a verdict.
static SETTLE_VERDICT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE plans
  SET state = @state, fresh_session_id = @freshSessionId, resolved_by = @resolvedBy,
      resolved_at = @resolvedAt
  WHERE id = @planId AND state = '{waiting}'",
        waiting = <&'static str>::from(PlanState::Waiting)
    )
});

// The plans of one run still waiting on a held request.
static HELD_PLANS_OF_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, session_id FROM plans
  WHERE run_id = @runId AND state = '{waiting}' AND holds_request = 1",
        waiting = <&'static str>::from(PlanState::Waiting)
    )
});

// The plans of every run still waiting on a held request.
static HELD_PLANS_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    SessionScopedSql::new("session_id", |session_condition| {
        format!(
            "SELECT id, session_id FROM plans
  WHERE state = '{waiting}' AND holds_request = 1 {session_condition}",
            waiting = <&'static str>::from(PlanState::Waiting)
        )
    })
});

/// A plan waiting on a request its driver holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HeldPlan {
    /// The plan.
    pub(crate) plan_id: PlanId,
    /// Its session.
    pub(crate) session_id: SessionId,
}

/// The plan's row as `proposed` writes it, waiting, at `created_at`. Refused when the plan is
/// already recorded.
pub(crate) fn insert_plan_statement(
    proposed: &PlanProposedPayload,
    created_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_PLAN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", proposed.plan_id.text().as_str()),
            text_binding("@sessionId", proposed.session_id.text().as_str()),
            text_binding("@runId", proposed.run_id.text().as_str()),
            text_binding("@artifactId", proposed.artifact_id.text().as_str()),
            text_binding("@title", &proposed.title),
            (
                Cow::Borrowed("@holdsRequest"),
                Value::Integer(i64::from(proposed.holds_request)),
            ),
            text_binding("@createdAt", created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Reopens `plan_id` as its held request ended; refused unless it waits on a request its driver
/// holds.
pub(crate) fn end_hold_statement(plan_id: &PlanId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(END_HOLD_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@planId", plan_id.text().as_str())]),
        expected_row_count: Some(1),
    }
}

/// A verdict that settled `plan_id` in `state`, from `device_id` at `resolved_at`, naming the
/// session it was handed off to when it was; refused unless the plan waits.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan verdicts' writes, and the rebuild the daemon's start registers"
    )
)]
pub(crate) fn settle_verdict_statement(
    plan_id: &PlanId,
    state: PlanState,
    fresh_session_id: Option<&SessionId>,
    device_id: &DeviceId,
    resolved_at: &WireInstant,
) -> WriteStatement {
    let fresh_session_text = fresh_session_id.map(SessionId::text);
    WriteStatement {
        sql: Cow::Borrowed(SETTLE_VERDICT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@planId", plan_id.text().as_str()),
            text_binding("@state", state.into()),
            nullable_text_binding(
                "@freshSessionId",
                fresh_session_text.as_ref().map(UuidText::as_str),
            ),
            text_binding("@resolvedBy", device_id.as_str()),
            text_binding("@resolvedAt", resolved_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// `plan.hold.ended` for `held`, for `reason`, with the statement that reopens it.
pub(crate) fn hold_end_write(
    held: HeldPlan,
    reason: PlanHoldEndedReason,
) -> (WriteStatement, SessionEventDraft) {
    let event = SessionEventDraft::of_session(
        held.session_id,
        &SessionEvent::PlanHoldEnded(PlanHoldEndedPayload {
            session_id: held.session_id,
            plan_id: held.plan_id,
            reason,
        }),
    )
    .expect("a plan.hold.ended payload names only checked ids");
    (end_hold_statement(&held.plan_id), event)
}

/// The plans of `run_id` still waiting on a request their driver holds. Fails as SQLite does, or
/// when a stored id does not read.
pub(crate) fn read_held_plans_of_run(
    connection: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<HeldPlan>> {
    connection
        .prepare_cached(&HELD_PLANS_OF_RUN_SQL)?
        .query_map(
            named_params! { "@runId": run_id.text().as_str() },
            held_plan_of_row,
        )?
        .collect()
}

/// The plans of `session_id`, or of every session when it is `None`, still waiting on a request
/// their driver holds. Fails as SQLite does, or when a stored id does not read.
pub(crate) fn read_held_plans(
    connection: &Connection,
    session_id: Option<&SessionId>,
) -> rusqlite::Result<Vec<HeldPlan>> {
    HELD_PLANS_SQL.query(connection, session_id, held_plan_of_row)
}

// A held plan's row, as both reads select it.
fn held_plan_of_row(row: &Row<'_>) -> rusqlite::Result<HeldPlan> {
    Ok(HeldPlan {
        plan_id: text_column(row, 0, |text| PlanId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
    })
}
