//! Lead runs whose turn the end of the daemon's own service cut, continued in one turn of Codex's
//! continuation words as the conversation is adopted by its handle: the turn bound, a pausing
//! lead's marked to pause, and a continuation Codex refuses answering the run gone.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::state::RunState;

use super::adoption::{
    ADOPTED_THREAD, AdoptionScript, CONTINUATION_TURN, CUT_TURN, ROOT_TURN, adopt, cut_turn_end,
    cut_turn_listed, lead_run, page_turn, turn_ends,
};
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::ProviderTurnAnswer;
use crate::driver::test_registry::new_run_id;

// A running lead whose turn the end of the daemon's own service cut, listed interrupted with no end
// time or not listed at all, continues in one turn carrying Codex's own continuation words: the
// cut turn ends in the log as the daemon's restart interrupted it, the new turn is the run's and
// the cut one is not, and the run answers still running. Killed by `Gone` kept (no turn sent), by
// the cut turn left bound (its listed end would end the run), by the cut turn left open in the log
// (a later restart binds it), by its end written as Codex's (the run ends), by a message id sent,
// and by the cut turn's own id sent as the root.
#[rstest]
#[case::listed_interrupted(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "rootTurnId": ROOT_TURN}]),
    Some(ROOT_TURN)
)]
#[case::not_listed(json!([]), None)]
#[tokio::test(start_paused = true)]
async fn a_lead_run_its_services_end_cut_continues_in_one_turn_of_codexs_words(
    #[case] listed_turns: Value,
    #[case] root_turn_id: Option<&str>,
) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::unloaded(
            listed_turns,
            json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
        ),
    )
    .await;

    let [turn_start] = adoption.turn_starts.as_slice() else {
        panic!("one turn is sent: {:?}", adoption.turn_starts);
    };
    let params = &turn_start["params"];
    assert_eq!(params["threadId"], ADOPTED_THREAD);
    assert_eq!(
        params["input"][0]["text"],
        "The server restarted and interrupted the previous turn. Continue the unfinished work \
         from the saved conversation. Check the current state before repeating actions that may \
         already have completed."
    );
    assert_eq!(params["turnTrigger"], "daemon_recovery");
    assert_eq!(
        params.get("rootTurnId").and_then(Value::as_str),
        root_turn_id
    );
    assert!(params["collaborationMode"].is_object());
    assert!(params["environments"].is_array());
    assert_eq!(params.get("clientUserMessageId"), None);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
    assert_eq!(established.record.active_turn_run(CUT_TURN), None);
    assert!(session.task.run_routes.binding_for(run_id).is_some());
}

// A pausing lead whose turn still runs on the daemon's own service has that turn bound and marked
// to pause at its next step end, since a restart loses the mark its pause set; a running lead's
// turn is bound unmarked. Killed by the mark not set, and by every bound turn marked.
#[rstest]
#[case::pausing(RunState::Pausing)]
#[case::running(RunState::Running)]
#[tokio::test(start_paused = true)]
async fn a_pausing_leads_running_turn_is_marked_to_pause_at_its_next_step_end(
    #[case] run_state: RunState,
) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, run_state)],
        AdoptionScript::loaded_active(
            json!([page_turn(CUT_TURN, "inProgress", ROOT_TURN)]),
            page_turn(CUT_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;

    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    let record = &established.record;
    assert_eq!(record.active_turn_run(CUT_TURN), Some(run_id));
    assert_eq!(
        record.pause_run_id_by_turn_id.get(CUT_TURN),
        (run_state == RunState::Pausing).then_some(&run_id)
    );
}

// A continuation Codex refuses answers the run gone, its cut turn already ended in the log, and
// holds no turn for the run. Killed by `StillRunning` kept on a refusal.
#[tokio::test(start_paused = true)]
async fn a_refused_continuation_answers_the_run_gone() {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::unloaded(
            json!([cut_turn_listed()]),
            json!({"error": {"code": -32600, "message": "the turn is refused"}}),
        ),
    )
    .await;

    assert_eq!(adoption.turn_starts.len(), 1);
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Gone);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    let established = adoption.established.expect("the session is established");
    assert_eq!(established.record.newest_active_turn_for_run(run_id), None);
    assert!(session.task.run_routes.binding_for(run_id).is_none());
}
