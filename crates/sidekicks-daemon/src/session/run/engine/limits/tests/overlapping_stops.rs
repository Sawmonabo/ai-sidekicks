use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use tokio::sync::oneshot;

use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::limits::LimitStop;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::tests::{
    HeldHand, SETTLE_WAIT, append, hand_limit_interrupter, insert_running_run, test_engine,
    token_limit, turn, turn_started_at,
};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::uuid_v7::mint_uuid_v7;

// A limit stop of `run_id` the test runs beside others: once `turn_first` answers, the stop goes,
// and its end is reported on `ended`.
async fn stop_after(
    engine: &RunEngine,
    run_id: RunId,
    stop: LimitStop,
    turn_first: Option<oneshot::Receiver<()>>,
    ended: oneshot::Sender<()>,
) -> Result<(), RunEngineError> {
    if let Some(turn_first) = turn_first {
        turn_first
            .await
            .expect("the stop before this one reaches its hand");
    }
    let stopped = engine.stop_at_limit(run_id, stop).await;
    ended.send(()).expect("the test waits for the stop's end");
    stopped
}

// Answers `hand`, then waits for its stop's end on `ended`.
async fn answer(hand: oneshot::Sender<bool>, is_refused: bool, ended: oneshot::Receiver<()>) {
    hand.send(is_refused)
        .expect("the stop waits for the test's answer");
    ended
        .await
        .expect("the stop ends once its hand is answered");
}

// Killed by a withdrawal putting back the cut the stop's own went in over, which leaves the turn
// the spend stop's cut once the token stop's hand fails, and by one that withdraws only a cut on
// top of its turn's, which leaves it the spend stop's: either way the turn ends with a limit no
// row names.
#[tokio::test]
async fn two_stops_whose_hands_fail_leave_their_turn_no_cut() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    let [
        HeldHand {
            handed: spend_handed,
            is_refused: spend_answer,
        },
        HeldHand {
            handed: token_handed,
            is_refused: token_answer,
        },
    ] = interventions.hold_hands();
    let (spend_ended, spend_end) = oneshot::channel();
    let (token_ended, token_end) = oneshot::channel();
    let spend = LimitStop::Interrupt {
        limit: RunLimit::SpendLimit,
    };
    let token = LimitStop::Token {
        token_limit: token_limit(),
    };
    // The token stop cuts the turn while the spend stop's hand is in flight; the spend stop's hand
    // fails first, then the token stop's.
    let answers = async {
        token_handed.await.expect("the token stop reaches its hand");
        answer(spend_answer, true, spend_end).await;
        answer(token_answer, true, token_end).await;
    };

    let (spent, tokened, ()) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(
            stop_after(&engine, run_id, spend, None, spend_ended),
            stop_after(&engine, run_id, token, Some(spend_handed), token_ended),
            answers,
        )
    })
    .await
    .expect("both stops settle");

    for stopped in [spent, tokened] {
        assert!(
            matches!(stopped, Err(RunEngineError::LimitInterrupt { .. })),
            "a stop answers {stopped:?}"
        );
    }
    assert!(lock(&engine.live).cut_turns.is_empty());
}

// Killed by a withdrawal that forgets the turn, which leaves it no cut, and by one that puts back
// the cut the stop's own went in over, which leaves it the first token stop's: either way the turn
// does not end with the spend limit the one stop whose hand went has a row naming it with.
#[tokio::test]
async fn a_turn_keeps_the_cut_of_its_one_handed_stop_after_two_later_stops_fail() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    let [
        HeldHand {
            handed: spend_handed,
            is_refused: spend_answer,
        },
        HeldHand {
            handed: first_token_handed,
            is_refused: first_token_answer,
        },
        HeldHand {
            handed: second_token_handed,
            is_refused: second_token_answer,
        },
    ] = interventions.hold_hands();
    let (spend_ended, spend_end) = oneshot::channel();
    let (first_token_ended, first_token_end) = oneshot::channel();
    let (second_token_ended, second_token_end) = oneshot::channel();
    let spend = LimitStop::Interrupt {
        limit: RunLimit::SpendLimit,
    };
    let token = LimitStop::Token {
        token_limit: token_limit(),
    };
    // Each token stop cuts the turn over the stops before it while their hands are in flight;
    // the two token stops' hands fail, the first first, and then the spend stop's goes.
    let answers = async {
        second_token_handed
            .await
            .expect("the second token stop reaches its hand");
        answer(first_token_answer, true, first_token_end).await;
        answer(second_token_answer, true, second_token_end).await;
        answer(spend_answer, false, spend_end).await;
    };

    let (spent, first_tokened, second_tokened, ()) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(
            stop_after(&engine, run_id, spend, None, spend_ended),
            stop_after(
                &engine,
                run_id,
                token,
                Some(spend_handed),
                first_token_ended
            ),
            stop_after(
                &engine,
                run_id,
                token,
                Some(first_token_handed),
                second_token_ended
            ),
            answers,
        )
    })
    .await
    .expect("the three stops settle");

    spent.expect("the spend stop's interrupt is accepted");
    for stopped in [first_tokened, second_tokened] {
        assert!(
            matches!(stopped, Err(RunEngineError::LimitInterrupt { .. })),
            "a token stop answers {stopped:?}"
        );
    }
    let live = lock(&engine.live);
    let key = (run_id, turn(1));
    let limits: Option<Vec<_>> = live
        .cut_turns
        .get(&key)
        .map(|cuts| cuts.iter().map(|cut| cut.limit).collect());
    assert_eq!(limits, Some(vec![RunLimit::SpendLimit]));
    assert_eq!(live.current_limit(&key), Some(RunLimit::SpendLimit));
}
