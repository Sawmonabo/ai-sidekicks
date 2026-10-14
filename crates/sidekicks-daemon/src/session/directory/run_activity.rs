//! A session's activity: `waiting` while any of its runs in `runs` waits on the person, else
//! `running` while any of them works, else how its last run ended, which each run's end event
//! writes to `sessions.last_run_outcome`. A run reads as it does until its state changes.

use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::SessionActivity;

use crate::database::sql_list::sql_list_of;

// The run states a session reads as waiting on the person, and those it reads as working.
const WAITING_RUN_STATES: [RunState; 2] = [RunState::WaitingForApproval, RunState::WaitingForInput];
const WORKING_RUN_STATES: [RunState; 3] =
    [RunState::Starting, RunState::Running, RunState::Pausing];

/// How a run event that ends a run's working time leaves its session, read from the event's
/// payload; `None` for every other event type. A paused run can go on, but its session reads idle
/// until it does.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "only the five run events that end a run's working time set an outcome"
)]
pub(crate) fn run_outcome_of(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Option<SessionActivity> {
    match event_type {
        SessionEventType::RunCompleted => Some(SessionActivity::Done),
        // A terminal the daemon's own close produced is never read as a crash.
        SessionEventType::RunFailed => Some(
            if payload.get("intendedClose") == Some(&Value::Bool(true)) {
                SessionActivity::Idle
            } else {
                SessionActivity::Failed
            },
        ),
        SessionEventType::RunInterrupted
        | SessionEventType::RunStopped
        | SessionEventType::RunPaused => Some(SessionActivity::Idle),
        _ => None,
    }
}

/// The SQL of a session's activity, from the session id's SQL and its `last_run_outcome`'s. Each
/// read is an indexed lookup of the session's runs.
pub(crate) fn session_activity_sql(session_id_sql: &str, last_run_outcome_sql: &str) -> String {
    let is_any_run_in = |states: &[RunState]| {
        format!(
            "EXISTS (SELECT 1 FROM runs WHERE runs.session_id = {session_id_sql}
                AND runs.state IN ({}))",
            sql_list_of(states.iter().map(<&'static str>::from))
        )
    };
    format!(
        "CASE WHEN {} THEN 'waiting'
               WHEN {} THEN 'running'
               ELSE {last_run_outcome_sql} END",
        is_any_run_in(&WAITING_RUN_STATES),
        is_any_run_in(&WORKING_RUN_STATES),
    )
}
