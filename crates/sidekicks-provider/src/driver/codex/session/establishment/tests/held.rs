//! The continuation a joined service started for a lead held on the person before the daemon came
//! back: its end, listed at the rejoin or live after it, is written as the daemon's and leaves the
//! run waiting for the person's answer, until a steer of the person's words reaches it. A helper
//! held on the person whose newest turn is listed over has that end written the same way; one
//! whose turn still runs ends as its own.

use std::path::Path;

use serde_json::value::to_raw_value;
use serde_json::{Value, json};
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;

use super::adopted_helpers::{HELPER_TURN, adopt_with_helpers, helper_run, loaded, unloaded};
use super::continuation::{
    ADOPTED_THREAD, AdoptionScript, CONTINUATION_TURN, ROOT_TURN, adopt, cut_turn_end,
    cut_turn_listed, lead_run, page_turn, turn_ends,
};
use crate::driver::codex::run::steer::register_codex_steer;
use crate::driver::codex::service::supervisor::test_service::start_scripted_joined_service;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_completed};
use crate::driver::session_control::ProviderTurnAnswer;
use crate::driver::test_registry::{new_message_id, new_run_id};
use crate::port::run_host::test_host::EngineCall;
use crate::run::delivery::LateAppendableRow;
use crate::run::state_entry::RunStateEntry;
use crate::run::turn_end::TurnOutcome;
use crate::usage_delta_accountant::UsageAxisCounts;

// The held turn's end the daemon writes for `run_id`: the first turn the test's engine opened on
// the run, interrupted by the restart.
fn continuation_end(run_id: RunId) -> EngineCall {
    EngineCall::RecordDaemonTurnEnd(
        run_id,
        SafeInt::<1>::new(1).expect("one is a turn number"),
        TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
    )
}

// How many `subagent.completed` rows name the child run `run_id`.
fn subagent_completed_rows(session: &TestCodexSession, run_id: RunId) -> usize {
    session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| {
            matches!(
                &delivery.row,
                Some(LateAppendableRow::AgentSubagentCompleted(row))
                    if row.child_run_id == Some(run_id)
            )
        })
        .count()
}

// `frame` as the session's queue hands it to the session's task.
fn queued(frame: &Value) -> CodexSessionInbound {
    CodexSessionInbound::Frame {
        method: frame["method"]
            .as_str()
            .expect("a frame names its method")
            .to_owned(),
        params: to_raw_value(&frame["params"]).expect("the params are JSON"),
    }
}

// The `userMessage` echo of the steer `message_id` on the continuation, as Codex writes it.
fn echo(message_id: QueueItemId) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": ADOPTED_THREAD,
            "turnId": CONTINUATION_TURN,
            "item": {
                "type": "userMessage",
                "id": format!("item-{message_id}"),
                "clientId": message_id.to_string(),
                "content": [],
            },
        },
    })
}

// Adopts the joined conversation for a lead waiting on its approval whose continuation still runs,
// which answers still running with the continuation marked held, then opens it, its record and
// routing becoming the test task's, so a frame handed to the task reaches the adopted conversation.
// Answers the lead's run.
async fn open_held_running_continuation(session: &mut TestCodexSession, folder: &Path) -> RunId {
    let run_id = new_run_id();
    let adoption = adopt(
        session,
        vec![lead_run(run_id, RunState::WaitingForApproval)],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    assert!(
        established
            .record
            .held_continuation_turn_ids
            .contains(CONTINUATION_TURN)
    );
    let opened = session
        .establishment(folder)
        .open(established, UsageAxisCounts::default())
        .await;
    session.task.record = opened.record;
    session.task.routing = opened.routing;
    run_id
}

// A lead waiting on its approval whose continuation Codex already ended on a joined service waits
// on: it answers waiting, and the continuation's listed end, routed as the session opens, is
// written as the daemon's after the cut turn's, with no move of the run, the run's deliveries'
// binding gone and the mark let go. Killed by the ended arm left as it was (the answer reads
// ended), and by the mark never set (the listed end completes the run).
#[tokio::test(start_paused = true)]
async fn a_held_leads_ended_continuation_leaves_the_run_waiting() {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::WaitingForApproval)],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "completed", ROOT_TURN),
        ),
    )
    .await;
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Waiting);
    let established = adoption.established.expect("the session is established");
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let opened = session
        .establishment(folder.path())
        .open(established, UsageAxisCounts::default())
        .await;

    assert_eq!(session.engine.moves_of_run(run_id), Vec::new());
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (
            vec![cut_turn_end(run_id), continuation_end(run_id)],
            Vec::new()
        )
    );
    assert!(session.task.run_routes.binding_for(run_id).is_none());
    assert!(opened.record.held_continuation_turn_ids.is_empty());
}

// A held lead's continuation that still ran at the adoption and then ends live is written as the
// daemon's, not as the run's end: no move of the run, the run's deliveries' binding gone, the turn
// retired and its mark let go. Killed by the mark never set at the adoption, and by the mark never
// read at the turn's end (either way the frame completes the run).
#[tokio::test(start_paused = true)]
async fn a_held_leads_running_continuation_ends_without_ending_the_run() {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let run_id = Box::pin(open_held_running_continuation(&mut session, folder.path())).await;

    let ended = turn_completed(ADOPTED_THREAD, CONTINUATION_TURN, "completed");
    session.task.handle(queued(&ended)).await;

    assert_eq!(session.engine.moves_of_run(run_id), Vec::new());
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (
            vec![cut_turn_end(run_id), continuation_end(run_id)],
            Vec::new()
        )
    );
    assert!(session.task.run_routes.binding_for(run_id).is_none());
    let record = &session.task.record;
    assert_eq!(record.active_turn_run(CONTINUATION_TURN), None);
    assert!(record.held_continuation_turn_ids.is_empty());
}

// A steer Codex takes into the held continuation, its echo naming it, lets the mark go, so the
// continuation's end is the run's own: the run completes, and only the cut turn's end is the
// daemon's. Killed by the mark kept on the steer's echo (the end is written as the daemon's and
// the run never moves).
#[tokio::test(start_paused = true)]
async fn a_steer_that_reaches_the_held_continuation_releases_its_end() {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let run_id = Box::pin(open_held_running_continuation(&mut session, folder.path())).await;
    let message_id = new_message_id();
    let _registered = register_codex_steer(&mut session.task.record, run_id, None, message_id)
        .expect("the continuation takes a steer");

    session.task.handle(queued(&echo(message_id))).await;
    assert!(session.task.record.held_continuation_turn_ids.is_empty());
    let ended = turn_completed(ADOPTED_THREAD, CONTINUATION_TURN, "completed");
    session.task.handle(queued(&ended)).await;

    assert_eq!(
        session.engine.moves_of_run(run_id),
        vec![RunStateEntry::Completed {
            intended_close: None
        }]
    );
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
}

// A helper waiting on its approval whose newest turn Codex lists completed answers waiting, its
// turn marked held; its listed end, routed as the session opens, is written as the daemon's on the
// helper's run, with no `subagent.completed` row, so the asks its turn held stay, no move of the
// run, its binding and route gone and the mark let go. Killed by the mark never set, and by the
// held end not taken where a helper's turn ends (either way the run completes with its row).
#[tokio::test(start_paused = true)]
async fn a_held_helpers_ended_turn_leaves_its_run_waiting() {
    let mut session = TestCodexSession::start().await;
    let lead_run_id = new_run_id();
    let helper_run_id = new_run_id();
    let mut held_helper = helper_run(helper_run_id, lead_run_id, "thread-helper-a");
    held_helper.run_state = RunState::WaitingForApproval;

    let adoption = adopt_with_helpers(
        &mut session,
        vec![lead_run(lead_run_id, RunState::Running), held_helper],
        vec![unloaded("thread-helper-a", "completed")],
    )
    .await;
    assert_eq!(
        adoption.answer_of(helper_run_id),
        ProviderTurnAnswer::Waiting
    );
    let established = adoption.established.expect("the session is established");
    assert!(
        established
            .record
            .held_continuation_turn_ids
            .contains(HELPER_TURN)
    );
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let opened = session
        .establishment(folder.path())
        .open(established, UsageAxisCounts::default())
        .await;

    assert_eq!(session.engine.moves_of_run(helper_run_id), Vec::new());
    assert_eq!(subagent_completed_rows(&session, helper_run_id), 0);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![continuation_end(helper_run_id)], Vec::new())
    );
    assert!(
        !opened
            .record
            .delivery
            .child_run_by_thread_id
            .contains_key("thread-helper-a")
    );
    assert!(!session.task.run_routes.has_helper_route(helper_run_id));
    assert!(opened.record.held_continuation_turn_ids.is_empty());
}

// A held helper whose turn still runs at the adoption is bound with its turn unmarked, so the turn
// runs on as the run's own: the person's stop of it ends the run with its `subagent.completed` row,
// never as the restart's held end.
// Killed by a running held turn marked (the end is written as the daemon's and the run never
// moves, so the stop hangs it).
#[tokio::test(start_paused = true)]
async fn a_stopped_held_helper_ends_as_its_stop() {
    let mut session = TestCodexSession::start().await;
    let lead_run_id = new_run_id();
    let helper_run_id = new_run_id();
    let mut held_helper = helper_run(helper_run_id, lead_run_id, "thread-helper-a");
    held_helper.run_state = RunState::WaitingForApproval;
    let adoption = adopt_with_helpers(
        &mut session,
        vec![lead_run(lead_run_id, RunState::Running), held_helper],
        vec![loaded("thread-helper-a", "inProgress")],
    )
    .await;
    assert_eq!(
        adoption.answer_of(helper_run_id),
        ProviderTurnAnswer::Waiting
    );
    let established = adoption.established.expect("the session is established");
    assert!(established.record.held_continuation_turn_ids.is_empty());
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let opened = session
        .establishment(folder.path())
        .open(established, UsageAxisCounts::default())
        .await;
    session.task.record = opened.record;
    session.task.routing = opened.routing;
    assert!(
        session
            .task
            .run_routes
            .begin_helper_interrupt(helper_run_id)
            .is_some()
    );

    let ended = turn_completed("thread-helper-a", HELPER_TURN, "interrupted");
    session.task.handle(queued(&ended)).await;

    assert_eq!(subagent_completed_rows(&session, helper_run_id), 1);
    assert_eq!(turn_ends(&session.engine.calls()).0, Vec::new());
}
