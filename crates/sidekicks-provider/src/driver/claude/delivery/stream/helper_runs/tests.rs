use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;

use super::super::tests::{helper_started, init, result};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::LateAppendableRow;

// A helper's `task_started`, launched by the helper `parent` where one is named, started as
// `role` where one is named.
fn nested_start(task_id: &str, call_id: &str, parent: Option<&str>, role: Option<&str>) -> Value {
    let mut frame = helper_started(task_id, "local_agent", call_id);
    if let Some(parent) = parent {
        frame["parent_task_id"] = json!(parent);
    }
    if let Some(role) = role {
        frame["subagent_type"] = json!(role);
    }
    frame
}

// One child run delivery as a test reads it.
#[derive(Debug, PartialEq)]
struct ChildRunRead {
    helper: String,
    parent_run_id: Option<RunId>,
    launcher: Option<String>,
    role: Option<String>,
    start_call: Option<String>,
}

// Each child run delivery, in order.
fn child_runs(deliveries: &[RecordedDelivery]) -> Vec<ChildRunRead> {
    deliveries
        .iter()
        .filter(|delivery| delivery.kind == "childRun")
        .map(|delivery| {
            let subagent = delivery
                .subagent
                .clone()
                .expect("a child run delivery names its helper");
            ChildRunRead {
                helper: subagent.subagent_id.as_str().to_owned(),
                parent_run_id: delivery.parent_run_id,
                launcher: subagent
                    .parent_subagent_id
                    .map(|parent| parent.as_str().to_owned()),
                role: subagent.role.map(|role| role.as_str().to_owned()),
                start_call: subagent.start_call_id.map(|call| call.as_str().to_owned()),
            }
        })
        .collect()
}

// Each lifecycle row of the helper `agent_id` as (is a start, the run it sits on, its child run).
fn lifecycle_rows(
    deliveries: &[RecordedDelivery],
    agent_id: &str,
) -> Vec<(bool, RunId, Option<RunId>)> {
    deliveries
        .iter()
        .filter_map(|delivery| {
            if let Some(LateAppendableRow::AgentSubagentStarted(payload)) = &delivery.row {
                Some((true, payload))
            } else if let Some(LateAppendableRow::AgentSubagentCompleted(payload)) = &delivery.row {
                Some((false, payload))
            } else {
                None
            }
        })
        .filter(|(_, payload)| payload.subagent_id.as_str() == agent_id)
        .map(|(is_start, payload)| (is_start, payload.run_id, payload.child_run_id))
        .collect()
}

// A nested helper hangs under its launcher's run, a helper whose launcher no route knows under the
// lead with that launcher's id kept, and both of the nested helper's rows sit on its start's run.
// Killed by every start hanging under the lead, by dropping the launcher's id, by taking the
// router's filtered parent (the unknown launcher's id reads as none), by dropping the role, by
// leaving the nested helper's start or end row on the lead (the end tried on the turn's lead
// first), and by an unknown launcher not falling back to the lead.
#[tokio::test(start_paused = true)]
async fn a_nested_helper_hangs_under_its_launchers_run_and_an_unknown_one_under_the_lead() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&nested_start("p", "call-p", None, Some("Explore")));
    session.frame(&nested_start("c", "call-c", Some("p"), Some("Plan")));
    session.frame(&nested_start("g", "call-g", Some("ghost"), None));
    settle().await;
    let routes = &session.start.routes;
    let parent_run = routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    let nested_run = routes
        .child_run_for(session.session_id, "c")
        .expect("the nested helper has its child run");
    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "c",
        "tool_use_id": "call-c",
        "status": "completed",
        "summary": "Planned",
    }));
    settle().await;

    let deliveries = session.engine.deliveries();
    assert_eq!(
        child_runs(&deliveries),
        [
            ChildRunRead {
                helper: "p".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: None,
                role: Some("Explore".to_owned()),
                start_call: Some("call-p".to_owned()),
            },
            ChildRunRead {
                helper: "c".to_owned(),
                parent_run_id: Some(parent_run),
                launcher: Some("p".to_owned()),
                role: Some("Plan".to_owned()),
                start_call: Some("call-c".to_owned()),
            },
            ChildRunRead {
                helper: "g".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: Some("ghost".to_owned()),
                role: None,
                start_call: Some("call-g".to_owned()),
            },
        ]
    );
    assert_eq!(
        lifecycle_rows(&deliveries, "c"),
        [
            (true, parent_run, Some(nested_run)),
            (false, parent_run, Some(nested_run)),
        ]
    );
}

// A background helper that launches a helper after the lead's turn ended still carries it: the
// nested start hangs under the launcher's run on the lead's binding, and opens no turn. Killed by
// dropping the start as unmapped once no lead holds the turn, by opening the turn on the run the
// start hangs under, and by trying the launcher only while a lead holds the turn.
#[tokio::test(start_paused = true)]
async fn a_background_helpers_nested_start_after_the_turn_ended_hangs_under_it() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&helper_started("p", "local_agent", "call-p"));
    settle().await;
    let parent_run = session
        .start
        .routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    session.frame(&result(&json!({})));
    settle().await;
    let before_nested_start = session.engine.deliveries().len();
    session.frame(&nested_start("c2", "call-c2", Some("p"), None));
    settle().await;

    let deliveries = session.engine.deliveries();
    let after_turn = &deliveries[before_nested_start..];
    let nested_child_run = after_turn
        .iter()
        .find(|delivery| delivery.kind == "childRun")
        .expect("the nested start gets its child run");
    assert_eq!(nested_child_run.parent_run_id, Some(parent_run));
    assert_eq!(nested_child_run.binding_id, Some(binding_id("lead")));
    assert!(
        lifecycle_rows(after_turn, "c2")
            .iter()
            .any(|&(is_start, run_id, _)| is_start && run_id == parent_run),
        "the nested start's row sits on its launcher's run"
    );
    assert!(
        after_turn
            .iter()
            .all(|delivery| delivery.kind != "turnBoundary"),
        "a start after the turn ended opens no turn"
    );
}
