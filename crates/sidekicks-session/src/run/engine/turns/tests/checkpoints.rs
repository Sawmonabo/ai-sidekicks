//! The checkpoint row a turn's start writes in its own write, before the message that opened it.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SessionRestoreTarget;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::checkpoints::schema::schema_parts;
use crate::checkpoints::store::{list_checkpoints, read_checkpoint};
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{end_run_aside, insert_running_run, test_engine};
use crate::run::epochs::ConfirmedCut;
use crate::run::state_change::RunStateChangeCompanions;

// Appends the person's message that queue item `item` sends to `run_id`, under the item's id as
// its correlation id, as the queue records it; answers its sequence.
async fn send(
    appender: &SessionEventAppender,
    session_id: SessionId,
    run_id: RunId,
    item: QueueItemId,
) -> SafeInt<0> {
    let event: SessionEvent = serde_json::from_value(json!({
        "type": "user.message.sent",
        "payload": {
            "sessionId": session_id,
            "queueItemId": item,
            "runId": run_id,
            "actor": "device-1",
            "deviceId": "device-1",
            "message": "Go on",
        },
    }))
    .expect("the test writes a sent message");
    let draft = SessionEventDraft::of_session(session_id, &event).expect("the message passes");
    let linkage = SessionEventLinkage {
        correlation_id: Some(
            FreeFormText::new(item.to_string()).expect("a queue item id is a short text"),
        ),
        ..SessionEventLinkage::default()
    };
    appender
        .append(draft, linkage)
        .await
        .expect("the message is appended")
        .sequence
}

// Starts a turn of `run_id` opened by `opening`; answers its number, `None` once the run ended.
async fn start(engine: &RunEngine, run_id: RunId, opening: Option<QueueItemId>) -> Option<u64> {
    engine
        .start_turn(run_id, None, None, None, opening)
        .await
        .expect("the turn's start is written")
        .map(|started| started.turn_number.get())
}

fn minted_item() -> QueueItemId {
    QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id")
}

fn epoch_position(epoch: u64, position: u64) -> EpochPosition {
    EpochPosition {
        epoch: SourceEpoch(SafeInt::new(epoch).expect("a small epoch")),
        position: SourcePosition(SafeInt::new(position).expect("a small turn")),
    }
}

// Killed by a row keyed on the turn's number or the start's own sequence, by a steer taken as an
// opening, by the standing read without this start applied (every position one short), by the
// epoch not read (the third row in epoch 0), by a second row for P2 or a plain insert refusing the
// start that names it again, by a row for a turn with no opening, and by a row written apart from
// its start (one for the ended run's start).
#[tokio::test]
async fn each_opened_turn_writes_one_checkpoint_before_its_message_with_its_start() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let appender =
        SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone());
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let [first, steer, second, third, fourth] = [(); 5].map(|()| minted_item());

    let first_sequence = send(&appender, session_id, run_id, first).await;
    assert_eq!(start(&engine, run_id, Some(first)).await, Some(1));
    send(&appender, session_id, run_id, steer).await;
    let is_turn_one_ended = engine
        .record_turn_end(
            run_id,
            ProviderTurnEnd {
                turn_number: SafeInt::new(1).expect("a small turn"),
                outcome: TurnOutcome::Completed,
            },
        )
        .await
        .expect("turn 1's end is written")
        .log_resend_failure(run_id);
    assert!(is_turn_one_ended);
    let second_sequence = send(&appender, session_id, run_id, second).await;
    assert_eq!(start(&engine, run_id, Some(second)).await, Some(2));
    assert_eq!(start(&engine, run_id, None).await, Some(3));
    assert_eq!(
        start(&engine, run_id, Some(second)).await,
        Some(4),
        "a start naming a message already kept still lands"
    );
    let hold = SESSION_APPEND_LOCK.acquire(session_id).await;
    engine
        .roll_back(
            run_id,
            &ConfirmedCut::InPlace {
                binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a binding id"),
                point: SourcePosition(SafeInt::ZERO),
            },
            RunStateChangeCompanions::default(),
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

    let reader = database.reader();
    let stored = list_checkpoints(&reader, session_id).expect("the checkpoints read");
    assert_eq!(
        stored
            .iter()
            .map(|row| (row.checkpoint.message_sequence, row.checkpoint.turn))
            .collect::<Vec<_>>(),
        vec![
            (first_sequence, epoch_position(0, 1)),
            (second_sequence, epoch_position(0, 2)),
            (third_sequence, epoch_position(1, 1)),
        ]
    );
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
                read_checkpoint(&reader, session_id, &target).expect("the checkpoint reads"),
                Some(row.clone()),
                "{target:?}"
            );
        }
    }
}
