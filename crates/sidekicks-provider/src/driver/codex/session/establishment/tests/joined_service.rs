//! A cut lead run on a service the daemon only joined, where Codex continued the cut turn itself:
//! its continuation held as the run's turn, running or ended, and none read outside the cut chain.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::state::RunState;

use super::adoption::{
    AdoptionScript, CONTINUATION_TURN, CUT_TURN, OTHER_ROOT_TURN, ROOT_TURN, adopt, cut_turn_end,
    cut_turn_listed, lead_run, page_turn, turn_ends,
};
use crate::driver::codex::service::supervisor::test_service::start_scripted_joined_service;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::ProviderTurnAnswer;
use crate::driver::test_registry::new_run_id;
use crate::port::run_host::test_host::EngineCall;

// On a service the daemon only joined, Codex continued the cut turn itself before the daemon came
// back, and sends it no start of that turn: the resume asks for the newest turn, which shows the
// continuation running in the cut turn's chain, so the cut turn ends in the log, the continuation
// is held as the run's turn and opened after that end, no turn is sent, and the run answers still
// running, whether it runs, pauses, waits on the person, or stops; a pausing lead's continuation is
// marked to pause at its next step end. Killed by the page not asked (no continuation found; the
// run answers ended), by the continuation not opened (no turn opens), by the cut turn left bound,
// by the cut turn not ended, by the continuation opened before the cut turn's end, by a pausing
// lead left out (no continuation opens), and by the pausing lead's continuation left unmarked.
#[rstest]
#[case::running(RunState::Running, false)]
#[case::pausing(RunState::Pausing, false)]
#[case::waiting_for_approval(RunState::WaitingForApproval, false)]
#[case::stopping(RunState::Running, true)]
#[tokio::test(start_paused = true)]
async fn a_joined_services_running_continuation_is_held_and_opened_as_the_runs_turn(
    #[case] run_state: RunState,
    #[case] is_stopping: bool,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, run_state);
    lead.is_stopping = is_stopping;

    let adoption = adopt(
        &mut session,
        vec![lead],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;

    let [resume] = adoption.resumes.as_slice() else {
        panic!("one resume is sent: {:?}", adoption.resumes);
    };
    assert_eq!(resume["params"]["excludeTurns"], true);
    assert_eq!(
        resume["params"]["initialTurnsPage"],
        json!({"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"})
    );
    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    let calls = session.engine.calls();
    let ended_at = calls
        .iter()
        .position(|call| *call == cut_turn_end(run_id))
        .expect("the cut turn is ended in the log");
    let opened_at = calls
        .iter()
        .position(|call| *call == EngineCall::StartTurn(run_id, None))
        .expect("the continuation is opened, with no message opening it");
    assert!(
        ended_at < opened_at,
        "the continuation opened first: {calls:?}"
    );
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    assert_eq!(adoption.session_position(), 2);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
    assert_eq!(established.record.active_turn_run(CUT_TURN), None);
    assert_eq!(
        established
            .record
            .pause_run_id_by_turn_id
            .get(CONTINUATION_TURN),
        (run_state == RunState::Pausing).then_some(&run_id)
    );
}

// A continuation Codex already ended on a joined service is held for a running lead with no stop
// pending, unopened, so its listed end, routed as the session opens, opens it and ends the run:
// the cut turn ends in the log and the run answers ended. A pausing lead's is held the same way,
// opened as the pause's turn, so its listed end pauses the run. A stopping lead's is left to its
// stop: nothing is ended or held, and the cut turn stays bound as before. Every lead keeps its
// deliveries' binding. Killed by the continuation not held (the run never ends), by the cut turn
// left bound (its listed end is routed), by a pausing lead's ended continuation left out or held
// unmarked (its listed end would end the run), and by the pause's turn opened twice or on a
// message.
#[rstest]
#[case::running(RunState::Running, false)]
#[case::stopping(RunState::Running, true)]
#[case::pausing(RunState::Pausing, false)]
#[tokio::test(start_paused = true)]
async fn a_joined_services_ended_continuation_is_held_unless_a_stop_settles_its_run(
    #[case] run_state: RunState,
    #[case] is_stopping: bool,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, run_state);
    lead.is_stopping = is_stopping;

    let adoption = adopt(
        &mut session,
        vec![lead],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "completed", ROOT_TURN),
        ),
    )
    .await;

    assert_eq!(
        adoption.answer_of(run_id),
        ProviderTurnAnswer::EndedByProvider
    );
    let calls = session.engine.calls();
    let is_pausing = run_state == RunState::Pausing;
    let run_turn_starts: Vec<EngineCall> = calls
        .iter()
        .filter(|call| matches!(call, EngineCall::StartTurn(opened, _) if *opened == run_id))
        .cloned()
        .collect();
    let expected_turn_starts = if is_pausing {
        vec![EngineCall::StartTurn(run_id, None)]
    } else {
        Vec::new()
    };
    assert_eq!(run_turn_starts, expected_turn_starts);
    assert!(session.task.run_routes.binding_for(run_id).is_some());
    let established = adoption.established.expect("the session is established");
    let record = &established.record;
    assert_eq!(
        record
            .paused_run_id_by_interrupted_turn_id
            .get(CONTINUATION_TURN),
        is_pausing.then_some(&run_id)
    );
    if is_stopping {
        assert_eq!(turn_ends(&calls), (Vec::new(), Vec::new()));
        assert_eq!(record.active_turn_run(CONTINUATION_TURN), None);
        assert_eq!(record.active_turn_run(CUT_TURN), Some(run_id));
    } else {
        assert_eq!(turn_ends(&calls), (vec![cut_turn_end(run_id)], Vec::new()));
        assert_eq!(record.active_turn_run(CONTINUATION_TURN), Some(run_id));
        assert_eq!(record.active_turn_run(CUT_TURN), None);
        assert!(
            established
                .listed_turns
                .iter()
                .any(|listed| listed.id == CONTINUATION_TURN)
        );
    }
}

// No continuation is read where the joined service's newest turn is the cut turn itself, or a turn
// of another chain: the run answers as Codex's listing has it, its cut turn bound, with no end
// written. Killed by a continuation told apart without its root, and by the cut turn ended with
// no continuation.
#[rstest]
#[case::the_cut_turn(cut_turn_listed())]
#[case::another_chain(page_turn(CONTINUATION_TURN, "inProgress", OTHER_ROOT_TURN))]
#[tokio::test(start_paused = true)]
async fn a_joined_services_newest_turn_outside_the_cut_chain_continues_nothing(
    #[case] newest_turn: Value,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::loaded_active(json!([cut_turn_listed()]), newest_turn),
    )
    .await;

    assert_eq!(
        adoption.answer_of(run_id),
        ProviderTurnAnswer::EndedByProvider
    );
    assert_eq!(turn_ends(&session.engine.calls()), (Vec::new(), Vec::new()));
    let established = adoption.established.expect("the session is established");
    assert_eq!(established.record.active_turn_run(CUT_TURN), Some(run_id));
    assert_eq!(established.record.active_turn_run(CONTINUATION_TURN), None);
}
