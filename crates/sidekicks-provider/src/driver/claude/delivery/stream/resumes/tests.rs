use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;

use super::super::helper_runs::tests::{child_runs, helper_ended, lifecycle_rows, nested_start};
use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};

// An assistant frame calling `SendMessage` under `call_id`, the helper `agent_id`'s or, with none,
// the lead's.
fn message_call(message_id: &str, call_id: &str, agent_id: Option<&str>) -> Value {
    let mut frame = json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": call_id, "name": "SendMessage", "input": {"to": "a"}},
            ],
        },
    });
    if let Some(agent_id) = agent_id {
        frame["agent_id"] = json!(agent_id);
    }
    frame
}

// Each start of the helper `agent_id` as (the run it went beneath, the call it named), in order.
fn starts_of(session: &ScriptedSession, agent_id: &str) -> Vec<(Option<RunId>, Option<String>)> {
    child_runs(&session.engine.deliveries())
        .into_iter()
        .filter(|read| read.helper == agent_id)
        .map(|read| (read.parent_run_id, read.start_call))
        .collect()
}

// A completed helper resumed by the lead's `SendMessage` opens a new own run under the lead's run,
// and resumed by another helper's under that helper's run, each start keeping the helper's agent
// id, so it stays one node. Killed by hanging every resume under the lead (the third start), and by
// a fresh subagent id per resume (the helper's later starts are not its own).
#[tokio::test(start_paused = true)]
async fn a_resumed_helper_hangs_under_the_run_that_sent_its_message() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("worker", "local_agent", "call-worker"));
    session.frame(&helper_started("caller", "local_agent", "call-caller"));
    session.frame(&helper_ended("worker", "completed", "Reported"));
    settle().await;
    let caller_run = session
        .start
        .routes
        .child_run_for(session.session_id, "caller")
        .expect("the calling helper has its child run");

    session.frame(&message_call("message-1", "send-lead", None));
    session.frame(&helper_started("worker", "local_agent", "send-lead"));
    session.frame(&helper_ended("worker", "completed", "Reported again"));
    session.frame(&message_call("message-2", "send-caller", Some("caller")));
    session.frame(&helper_started("worker", "local_agent", "send-caller"));
    settle().await;

    let lead = Some(lead_run);
    assert_eq!(
        starts_of(&session, "worker"),
        [
            (lead, Some("call-worker".to_owned())),
            (lead, Some("send-lead".to_owned())),
            (Some(caller_run), Some("send-caller".to_owned())),
        ]
    );
}

// An automatic resume, naming the call of the helper's newest own start, hangs under that start's
// parent: after a first start beneath its launcher, and again after a resume beneath the lead.
// Killed by hanging the automatic resume under the lead (the second start), and by keeping the
// first start's record past a resume (the fourth start hangs under the launcher).
#[tokio::test(start_paused = true)]
async fn an_automatic_resume_hangs_under_its_previous_parent() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("launcher", "local_agent", "call-launcher"));
    session.frame(&nested_start(
        "worker",
        "call-worker",
        Some("launcher"),
        None,
    ));
    settle().await;
    let launcher_run = session
        .start
        .routes
        .child_run_for(session.session_id, "launcher")
        .expect("the launcher has its child run");

    session.frame(&helper_ended("worker", "completed", "Reported"));
    session.frame(&helper_started("worker", "local_agent", "call-worker"));
    session.frame(&helper_ended("worker", "completed", "Reported"));
    session.frame(&message_call("message-1", "send-lead", None));
    session.frame(&helper_started("worker", "local_agent", "send-lead"));
    session.frame(&helper_ended("worker", "completed", "Reported"));
    session.frame(&helper_started("worker", "local_agent", "send-lead"));
    settle().await;

    let launcher = Some(launcher_run);
    let lead = Some(lead_run);
    assert_eq!(
        starts_of(&session, "worker"),
        [
            (launcher, Some("call-worker".to_owned())),
            (launcher, Some("call-worker".to_owned())),
            (lead, Some("send-lead".to_owned())),
            (lead, Some("send-lead".to_owned())),
        ]
    );
}

// An interrupted helper resumed beneath the run it ran under continues its old run, its start row
// naming that run, and one resumed beneath another run takes a new own run there. Killed by
// continuing every interrupted helper (the moved helper continues), and by always starting a new
// run (the kept helper starts one).
#[tokio::test(start_paused = true)]
async fn an_interrupted_helper_continues_only_beneath_its_own_parent() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("caller", "local_agent", "call-caller"));
    session.frame(&helper_started("kept", "local_agent", "call-kept"));
    session.frame(&helper_started("moved", "local_agent", "call-moved"));
    settle().await;
    let routes = &session.start.routes;
    let run_of = |agent_id: &str| {
        routes
            .child_run_for(session.session_id, agent_id)
            .expect("the helper has its child run")
    };
    let (caller_run, kept_run) = (run_of("caller"), run_of("kept"));

    session.frame(&helper_ended("kept", "stopped", "Interrupted"));
    session.frame(&helper_ended("moved", "stopped", "Interrupted"));
    session.frame(&message_call("message-1", "send-kept", None));
    session.frame(&helper_started("kept", "local_agent", "send-kept"));
    session.frame(&message_call("message-2", "send-moved", Some("caller")));
    session.frame(&helper_started("moved", "local_agent", "send-moved"));
    settle().await;

    let deliveries = session.engine.deliveries();
    assert_eq!(
        deliveries
            .iter()
            .filter(|delivery| delivery.kind == "runContinued")
            .count(),
        1
    );
    assert_eq!(starts_of(&session, "kept").len(), 1);
    assert_eq!(run_of("kept"), kept_run);
    assert_eq!(
        lifecycle_rows(&deliveries, "kept"),
        [
            (true, lead_run, Some(kept_run)),
            (false, lead_run, Some(kept_run)),
            (true, lead_run, Some(kept_run)),
        ]
    );
    let lead = Some(lead_run);
    assert_eq!(
        starts_of(&session, "moved"),
        [
            (lead, Some("call-moved".to_owned())),
            (Some(caller_run), Some("send-moved".to_owned())),
        ]
    );
}
