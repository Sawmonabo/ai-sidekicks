//! The checkpoint row a turn's start or a steer's landing writes in its own write, before the
//! person's message that opened the turn or steered it, or before a start no new message opened.

use std::sync::Arc;

use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SessionRestoreTarget;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::checkpoints::schema::schema_parts;
use crate::checkpoints::store::kept::{list_checkpoints, read_checkpoint};
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{end_run_aside, insert_run, test_engine};
use crate::run::engine::tests::{minted_item, send, stored_events, turn};
use crate::run::engine::turns::steers::SteerRecord;
use crate::run::engine::undo::RunCut;
use crate::run::state_change::RunWriteCompanions;

// Starts a turn of `run_id` opened by `opening`; answers its number, `None` once the run ended.
async fn start(engine: &RunEngine, run_id: RunId, opening: Option<QueueItemId>) -> Option<u64> {
    engine
        .start_turn(run_id, None, None, None, opening)
        .await
        .expect("the turn's start is written")
        .map(|started| started.turn_number.get())
}

// Writes the completed end of turn `turn_number` of `run_id`, asserting it is no duplicate.
async fn end(engine: &Arc<RunEngine>, run_id: RunId, turn_number: u64) {
    let is_written = engine
        .record_turn_end(
            run_id,
            ProviderTurnEnd {
                turn_number: SafeInt::new(turn_number).expect("a small turn"),
                outcome: TurnOutcome::Completed,
            },
        )
        .await
        .expect("the turn's end is written")
        .log_resend_failure(run_id);
    assert!(is_written, "turn {turn_number}'s end is no duplicate");
}

fn epoch_position(epoch: u64, position: u64) -> EpochPosition {
    EpochPosition {
        epoch: SourceEpoch(SafeInt::new(epoch).expect("a small epoch")),
        position: SourcePosition(SafeInt::new(position).expect("a small turn")),
    }
}

// The sequence of the start of turn `turn_number` of `run_id`.
fn start_sequence(database: &TestDatabase, run_id: RunId, turn_number: u64) -> SafeInt<0> {
    let sequence: i64 = database
        .reader()
        .query_row(
            "SELECT sequence FROM session_events
              WHERE run_id = ?1 AND type = 'agent.turn.started'
                AND json_extract(payload, '$.turnNumber') = ?2",
            rusqlite::params![
                run_id.text().as_str(),
                i64::try_from(turn_number).expect("a small turn number")
            ],
            |row| row.get(0),
        )
        .expect("the test reads the turn's start");
    u64::try_from(sequence)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored sequence is a safe integer")
}

// Lists the session's checkpoints, asserting each reads back by its snapshot and by its message,
// and answers each one's message sequence, turn number and turn.
fn check_listed_checkpoints(
    database: &TestDatabase,
    session_id: SessionId,
    run_id: RunId,
) -> Vec<(SafeInt<0>, u64, EpochPosition)> {
    let reader = database.reader();
    let stored = list_checkpoints(&reader, |_| None, session_id).expect("the checkpoints read");
    for row in &stored {
        let checkpoint = &row.checkpoint;
        assert_eq!(checkpoint.run_id, run_id);
        let anchor_cursor = encode_event_cursor(i64::from(checkpoint.message_sequence))
            .expect("a stored sequence is a cursor");
        for target in [
            SessionRestoreTarget::Snapshot {
                snapshot_id: checkpoint.checkpoint_id.clone(),
            },
            SessionRestoreTarget::Message { anchor_cursor },
        ] {
            assert_eq!(
                read_checkpoint(&reader, |_| None, session_id, &target)
                    .expect("the checkpoint reads"),
                Some(row.clone()),
                "{target:?}"
            );
        }
    }
    stored
        .iter()
        .map(|row| {
            (
                row.checkpoint.message_sequence,
                row.checkpoint.turn_number.get(),
                row.checkpoint.turn,
            )
        })
        .collect()
}

// Every turn start writes one row: before its opening message, and before the start itself for a
// turn no message opened and for one whose message a row already holds, as a faster model's
// retry opens again. Killed by a row keyed on the start's own sequence where a new message opened
// it, by the standing read without this start applied (every position one short), by the epoch
// not read (the row after the rollback in epoch 0), by the turn's number not written, by no row
// for a turn with no opening, by the opening's row tried again for a message already kept (the
// conflict swallows the retry's row), and by a row written apart from its start (one for the
// ended run's start). The rollback cuts the epoch's first rows away, so the list reads them before
// it and only the new epoch's row after.
#[tokio::test]
async fn each_turn_start_writes_one_checkpoint_with_its_start() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let appender =
        SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone());
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(&database, session_id, run_id, "running");
    let [first, steer, second, third, fourth] = [(); 5].map(|()| minted_item());

    let first_sequence = send(&appender, session_id, run_id, first).await;
    assert_eq!(start(&engine, run_id, Some(first)).await, Some(1));
    send(&appender, session_id, run_id, steer).await;
    end(&engine, run_id, 1).await;
    let second_sequence = send(&appender, session_id, run_id, second).await;
    assert_eq!(start(&engine, run_id, Some(second)).await, Some(2));
    assert_eq!(start(&engine, run_id, None).await, Some(3));
    assert_eq!(
        start(&engine, run_id, Some(second)).await,
        Some(4),
        "a start naming a message already kept still lands"
    );
    // A rollback refuses a run holding a turn with no end.
    for turn_number in 2..=4 {
        end(&engine, run_id, turn_number).await;
    }
    assert_eq!(
        check_listed_checkpoints(&database, session_id, run_id),
        vec![
            (first_sequence, 1, epoch_position(0, 1)),
            (second_sequence, 2, epoch_position(0, 2)),
            (
                start_sequence(&database, run_id, 3),
                3,
                epoch_position(0, 3)
            ),
            (
                start_sequence(&database, run_id, 4),
                4,
                epoch_position(0, 4)
            ),
        ]
    );
    let hold = SESSION_APPEND_LOCK.acquire(session_id).await;
    engine
        .roll_back(
            RunCut {
                run_id,
                target_position: SourcePosition(SafeInt::ZERO),
            },
            Vec::new(),
            RunWriteCompanions::default(),
            &hold,
        )
        .await
        .expect("the rollback is written");
    drop(hold);
    let third_sequence = send(&appender, session_id, run_id, third).await;
    assert_eq!(start(&engine, run_id, Some(third)).await, Some(5));
    end_run_aside(&database.path(), &run_id);
    send(&appender, session_id, run_id, fourth).await;
    assert_eq!(start(&engine, run_id, Some(fourth)).await, None);

    assert_eq!(
        check_listed_checkpoints(&database, session_id, run_id),
        vec![(third_sequence, 5, epoch_position(1, 1))]
    );
}

// A steer lands at the run's next position with its checkpoint; a message the person never sent
// and a steer on an ended run write nothing. Killed by a row at the run's standing rather than its
// next position, by a row keyed on the opening's message, by the sent-message check dropped (a
// steer row with no checkpoint) and by the ended-run check dropped (the late steer written).
#[tokio::test]
async fn a_steers_write_records_its_checkpoint_at_its_position() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let appender =
        SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone());
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(&database, session_id, run_id, "running");
    let [opening, steer, never_sent, late_steer] = [(); 4].map(|()| minted_item());
    let steered_count = || {
        stored_events(&database, &run_id)
            .into_iter()
            .filter(|(event_type, _, _)| event_type == "agent.turn.steered")
            .count()
    };

    let opening_sequence = send(&appender, session_id, run_id, opening).await;
    assert_eq!(start(&engine, run_id, Some(opening)).await, Some(1));
    let steer_sequence = send(&appender, session_id, run_id, steer).await;
    let written = engine
        .record_steer(run_id, turn(1), steer)
        .await
        .expect("the steer is written");
    assert!(matches!(written, SteerRecord::Written(_)), "{written:?}");
    let recorded = vec![
        (opening_sequence, 1, epoch_position(0, 1)),
        (steer_sequence, 1, epoch_position(0, 2)),
    ];
    assert_eq!(
        check_listed_checkpoints(&database, session_id, run_id),
        recorded
    );
    assert_eq!(steered_count(), 1);

    assert_eq!(
        engine
            .record_steer(run_id, turn(1), never_sent)
            .await
            .expect("an unsent message's landing reads"),
        SteerRecord::NotSent
    );
    send(&appender, session_id, run_id, late_steer).await;
    end_run_aside(&database.path(), &run_id);
    assert_eq!(
        engine
            .record_steer(run_id, turn(1), late_steer)
            .await
            .expect("a steer on an ended run reads"),
        SteerRecord::RunEnded
    );
    assert_eq!(
        check_listed_checkpoints(&database, session_id, run_id),
        recorded
    );
    assert_eq!(steered_count(), 1);
}
