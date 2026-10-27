use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::pause_point::ArmedPause;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use tokio::sync::oneshot;

use crate::questions::schema::schema_parts;
use crate::run::engine::limits::LimitStop;
use crate::run::engine::test_fixture::{
    SETTLE_WAIT, append, arm_step_count, hand_limit_interrupter, insert_running_run, stored_events,
    test_engine, token_limit, turn, turn_completed_at, turn_started_at,
};
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::limit_interrupter::HandedCut;

// A limit stop of `run_id` the test runs beside others: once `goes_first` reports that the stop
// before it reached its hand, the stop goes, and its end is reported on `ended`.
async fn stop_after(
    engine: &Arc<RunEngine>,
    run_id: RunId,
    stop: LimitStop,
    goes_first: Option<oneshot::Receiver<()>>,
    ended: oneshot::Sender<()>,
) -> Result<(), RunEngineError> {
    if let Some(goes_first) = goes_first {
        goes_first
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
    let database = TestDatabase::new(schema_parts());
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
    let ArmedPause {
        reached: spend_handed,
        release: spend_answer,
    } = interventions.held_hands.arm();
    let ArmedPause {
        reached: token_handed,
        release: token_answer,
    } = interventions.held_hands.arm();
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
    let database = TestDatabase::new(schema_parts());
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
    let ArmedPause {
        reached: spend_handed,
        release: spend_answer,
    } = interventions.held_hands.arm();
    let ArmedPause {
        reached: first_token_handed,
        release: first_token_answer,
    } = interventions.held_hands.arm();
    let ArmedPause {
        reached: second_token_handed,
        release: second_token_answer,
    } = interventions.held_hands.arm();
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

// Killed by a stop whose turn ends as its cut goes in still naming that turn in its row, though
// it cut none, and by one that leaves its cut in place, which no later turn end clears.
#[tokio::test]
async fn a_stop_whose_turn_ends_as_its_cut_goes_in_names_no_turn() {
    let database = TestDatabase::new(schema_parts());
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
    let ArmedPause { reached, release } = engine.cut_pause.arm();
    // Turn 1's end lands while the stop is held with its cut in, appended to the log beside the
    // engine's turn ends so that no end reads the cut.
    let turn_ends = async {
        reached.await.expect("the stop holds its cut");
        append(
            &engine,
            session_id,
            &turn_completed_at(session_id, run_id, 1, 1),
        )
        .await;
        release.send(()).expect("the stop waits at its cut");
    };

    let (stopped, ()) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(engine.stop_at_spend_limit(run_id), turn_ends)
    })
    .await
    .expect("the stop settles");

    stopped.expect("the spend limit's interrupt is accepted");
    assert_eq!(
        *interventions
            .cut_turns
            .lock()
            .expect("the stand-in's turns are not poisoned"),
        vec![None]
    );
    assert!(lock(&engine.live).cut_turns.is_empty());
}

// The run's limit rows: each row's state and the turn it names.
fn limit_rows(database: &TestDatabase, run_id: &RunId) -> Vec<(String, Option<i64>)> {
    database
        .reader()
        .prepare(
            "SELECT state, json_extract(payload, '$.turnNumber') FROM interventions
              WHERE target_run_id = ?1",
        )
        .expect("the test reads the run's limit rows")
        .query_map([run_id.text().as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("the run's limit rows read")
        .collect::<Result<_, _>>()
        .expect("each limit row reads")
}

// Killed by a stop that runs on its caller's future instead of a task of its own: the caller's
// drop mid-hand drops the hand with it, so the test's answer finds no hand waiting, no row is
// written and the cut is withdrawn; and for a step stop by a finished stop clearing its turn's
// reach, which writes the turn's reached event again at its next step.
#[rstest]
#[case::spend(false)]
#[case::step(true)]
#[tokio::test]
async fn a_stop_its_caller_drops_mid_hand_keeps_the_cut_its_row_names(#[case] is_step: bool) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    interventions.record_rows_in(&database);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    if is_step {
        arm_step_count(&engine, run_id, 1, 1);
    }
    let ArmedPause { reached, release } = interventions.held_hands.arm();
    let mut stopping = if is_step {
        engine.count_step(run_id).boxed()
    } else {
        engine.stop_at_spend_limit(run_id).boxed()
    };

    let held = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::select! {
            stopped = &mut stopping => Err(stopped),
            handed = reached => Ok(handed),
        }
    })
    .await
    .expect("the stop reaches its hand or ends");
    assert!(matches!(held, Ok(Ok(()))), "the stop answers {held:?}");
    drop(stopping);
    release
        .send(false)
        .expect("the stop's hand outlives its caller");
    // The asserts below hold on either runtime flavor once this wait ends: the cut has been held
    // since the stop put it in and keeping it leaves it there, the row is written before the hand
    // returns, and no step hand is in flight once the step stop's hand has returned, while a
    // spend stop's hand never enters that set. The step case's one reached event follows: the
    // turn's reach was marked when its step was counted and a hand that keeps its cut leaves it
    // marked, and the hand forgets the limit before it leaves the in-flight set, so the next step
    // hands nothing again.
    tokio::time::timeout(SETTLE_WAIT, async {
        while limit_rows(&database, &run_id).is_empty()
            || (is_step && !lock(&engine.live).step_interrupts_in_flight.is_empty())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the stop's hand records its row, and a step hand returns");

    assert_eq!(
        limit_rows(&database, &run_id),
        vec![("accepted".to_owned(), Some(1))]
    );
    {
        let live = lock(&engine.live);
        assert!(live.cut_turns.contains_key(&(run_id, turn(1))));
        assert!(live.step_interrupts_in_flight.is_empty());
    }
    if is_step {
        engine
            .count_step(run_id)
            .await
            .expect("a step past the turn's reached bound stops nothing");
        let reached_events = stored_events(&database, &run_id)
            .into_iter()
            .filter(|(event_type, _, _)| event_type == "agent.run.stepLimit.reached")
            .count();
        assert_eq!(reached_events, 1);
    }
}

// Two hands of the token limit cut one turn and the first fails past its bound. Killed by its late
// failure withdrawing the cuts of its limit rather than its own, which takes the second hand's
// cut too while that hand's row names the turn.
#[tokio::test]
async fn a_late_failed_hand_withdraws_its_own_cut_and_leaves_another_of_its_limit() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, test_session_id(), run_id);
    let engine = test_engine(&database, log.service, home.path());
    let key = (run_id, turn(3));
    let (late, standing) = {
        let mut live = lock(&engine.live);
        let late = live.new_cut(RunLimit::TokenLimit);
        let standing = live.new_cut(RunLimit::TokenLimit);
        live.cut_turns.insert(key, vec![late, standing]);
        (late, standing)
    };

    engine
        .forget_late_limit_hand(
            run_id,
            RunLimit::TokenLimit,
            Some(HandedCut {
                turn_number: turn(3),
                stop_id: late.stop_id,
            }),
        )
        .await
        .expect("the run reads");

    let live = lock(&engine.live);
    assert_eq!(live.cut_turns.get(&key), Some(&vec![standing]));
    assert!(
        live.reached_limits
            .contains(&(run_id, RunLimit::TokenLimit))
    );
}
