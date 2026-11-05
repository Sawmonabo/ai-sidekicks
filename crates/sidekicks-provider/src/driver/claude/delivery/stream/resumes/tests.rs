use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;

use super::super::helper_runs::tests::{child_runs, helper_ended, lifecycle_rows, nested_start};
use super::super::tests::tool_call;
use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};

// An assistant frame of the helper `agent_id`'s own, holding only text.
fn helper_text(message_id: &str, agent_id: &str) -> Value {
    json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "agent_id": agent_id,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": "Working"}],
        },
    })
}

// Each parent correction as (the child run it moves, the run it moves it beneath), in order.
fn corrections(session: &ScriptedSession) -> Vec<(Option<RunId>, Option<RunId>)> {
    session
        .engine
        .deliveries()
        .iter()
        .filter(|delivery| delivery.kind == "childRunParentCorrected")
        .map(|delivery| (delivery.run_id, delivery.parent_run_id))
        .collect()
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

    session.frame(&tool_call("message-1", "send-lead", "SendMessage", None));
    session.frame(&helper_started("worker", "local_agent", "send-lead"));
    session.frame(&helper_ended("worker", "completed", "Reported again"));
    session.frame(&tool_call(
        "message-2",
        "send-caller",
        "SendMessage",
        Some("caller"),
    ));
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
    session.frame(&tool_call("message-1", "send-lead", "SendMessage", None));
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
// continuing every interrupted helper (the moved helper continues), by always starting a new run
// (the kept helper starts one), and by continuing a run other than the kept helper's own.
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
    session.frame(&tool_call("message-1", "send-kept", "SendMessage", None));
    session.frame(&helper_started("kept", "local_agent", "send-kept"));
    session.frame(&tool_call(
        "message-2",
        "send-moved",
        "SendMessage",
        Some("caller"),
    ));
    session.frame(&helper_started("moved", "local_agent", "send-moved"));
    settle().await;

    let deliveries = session.engine.deliveries();
    let continued: Vec<_> = deliveries
        .iter()
        .filter(|delivery| delivery.kind == "runContinued")
        .map(|delivery| delivery.run_id)
        .collect();
    assert_eq!(continued, [Some(kept_run)]);
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

// A resume read before the `SendMessage` call it names waits: the call, landing first, hangs it
// under the calling helper's run with no correction; the helper's own frame, landing first, hangs
// it under the lead, and the call then moves its child run under the caller's run exactly once,
// so its end row goes there. Killed by never parking (the early resume starts under the lead
// before its call), by parking forever (either resume never starts), by sending no correction, by
// a correction per frame or call read (more than one), and by a correction that leaves the route
// beneath the lead (the late helper's end row sits on the lead's run).
#[tokio::test(start_paused = true)]
async fn a_resume_before_its_call_waits_for_the_call_or_the_helpers_next_frame() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("caller", "local_agent", "call-caller"));
    session.frame(&helper_started("early", "local_agent", "call-early"));
    session.frame(&helper_started("late", "local_agent", "call-late"));
    session.frame(&helper_ended("early", "completed", "Reported"));
    session.frame(&helper_ended("late", "completed", "Reported"));
    settle().await;
    let caller_run = session
        .start
        .routes
        .child_run_for(session.session_id, "caller")
        .expect("the calling helper has its child run");

    session.frame(&helper_started("early", "local_agent", "send-early"));
    settle().await;
    assert_eq!(starts_of(&session, "early").len(), 1, "the resume waits");
    session.frame(&tool_call(
        "message-1",
        "send-early",
        "SendMessage",
        Some("caller"),
    ));
    session.frame(&helper_started("late", "local_agent", "send-late"));
    session.frame(&helper_text("message-2", "late"));
    session.frame(&helper_text("message-3", "late"));
    session.frame(&tool_call(
        "message-4",
        "send-late",
        "SendMessage",
        Some("caller"),
    ));
    session.frame(&helper_text("message-5", "late"));
    session.frame(&helper_ended("late", "completed", "Reported again"));
    settle().await;

    let (lead, caller) = (Some(lead_run), Some(caller_run));
    assert_eq!(
        starts_of(&session, "early"),
        [
            (lead, Some("call-early".to_owned())),
            (caller, Some("send-early".to_owned())),
        ]
    );
    assert_eq!(
        starts_of(&session, "late"),
        [
            (lead, Some("call-late".to_owned())),
            (lead, Some("send-late".to_owned())),
        ]
    );
    let rows = lifecycle_rows(&session.engine.deliveries(), "late");
    let resumed_run = rows
        .get(2)
        .and_then(|&(_, _, child_run_id)| child_run_id)
        .expect("the late resume's start row names its child run");
    assert_eq!(corrections(&session), [(Some(resumed_run), caller)]);
    assert_eq!(
        rows.get(2..),
        Some(
            &[
                (true, lead_run, Some(resumed_run)),
                (false, caller_run, Some(resumed_run)),
            ][..]
        )
    );
}

// A call read on the run the resume already hangs under moves nothing, and a first start, whose
// call is never read, starts at once. Killed by correcting onto the same run (a correction is
// sent), and by parking a start that has no own run before (it never starts).
#[tokio::test(start_paused = true)]
async fn a_resume_under_its_callers_run_or_a_first_start_is_not_moved_or_parked() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("worker", "local_agent", "call-worker"));
    session.frame(&helper_ended("worker", "completed", "Reported"));
    session.frame(&helper_started("worker", "local_agent", "send-lead"));
    session.frame(&helper_text("message-1", "worker"));
    session.frame(&tool_call("message-2", "send-lead", "SendMessage", None));
    session.frame(&helper_ended("worker", "completed", "Reported again"));
    session.frame(&helper_started("fresh", "local_agent", "call-fresh"));
    settle().await;

    let lead = Some(lead_run);
    assert_eq!(
        starts_of(&session, "worker"),
        [
            (lead, Some("call-worker".to_owned())),
            (lead, Some("send-lead".to_owned())),
        ]
    );
    assert_eq!(
        starts_of(&session, "fresh"),
        [(lead, Some("call-fresh".to_owned()))]
    );
    assert_eq!(corrections(&session), []);
}
