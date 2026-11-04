//! A continuation whose turn start went unanswered, held as the run's turn where a second resume
//! shows it started.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::state::RunState;

use super::adoption::{
    AdoptionScript, CONTINUATION_TURN, ROOT_TURN, adopt, cut_turn_listed, lead_run, page_turn,
};
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::ProviderTurnAnswer;
use crate::driver::test_registry::new_run_id;

// A continuation whose `turn/start` goes unanswered past its deadline may still have started:
// a second bare resume asks for the newest turn, and one no turn listed before the start names is
// held as the run's, which answers still running; a page holding only a listed turn answers the
// run gone. `turn/start` is sent once either way. Killed by `Gone` kept on a started turn, by a
// second `turn/start`, and by a listed turn taken as the new one.
#[rstest]
#[case::a_new_turn(page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN), true)]
#[case::a_listed_turn(cut_turn_listed(), false)]
#[tokio::test(start_paused = true)]
async fn a_continuation_start_left_unanswered_is_held_where_a_second_resume_shows_it(
    #[case] newest_turn: Value,
    #[case] is_started: bool,
) {
    let mut session = TestCodexSession::start_on(start_scripted_codex_service()).await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript {
            is_loaded: false,
            status: "idle",
            resume_pages: vec![None, Some(json!([newest_turn]))],
            listed_turns: json!([cut_turn_listed()]),
            turn_start_answer: None,
            helpers: Vec::new(),
        },
    )
    .await;

    assert_eq!(adoption.turn_starts.len(), 1);
    let [_, check] = adoption.resumes.as_slice() else {
        panic!("a second resume is sent: {:?}", adoption.resumes);
    };
    assert_eq!(
        check["params"]["initialTurnsPage"],
        json!({"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"})
    );
    let established = adoption
        .established
        .as_ref()
        .expect("the session is established");
    if is_started {
        assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
        assert_eq!(
            established.record.active_turn_run(CONTINUATION_TURN),
            Some(run_id)
        );
    } else {
        assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Gone);
        assert_eq!(established.record.newest_active_turn_for_run(run_id), None);
    }
}
