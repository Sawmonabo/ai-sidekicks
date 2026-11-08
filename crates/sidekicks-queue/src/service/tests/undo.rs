//! An undo through the queue: the conversation cut, asked of the provider only once every run it
//! reaches holds no open turn and written in one write with the caller's companions, the fence on
//! the session's binding, and the release that sends the edited message ahead of the held sends.

mod cut;
mod release;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::restore::{SessionRestoreTarget, SnapshotId};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::rewind::RewindConversationResult;
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_session::checkpoints::store::{Checkpoint, insert_checkpoint_statement};
use sidekicks_session::run::engine::test_fixture::{append, stored_run_state};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, HELD_WATCH, fixture, recording_driver};

/// The turn position the undo's target message opened; the cut keeps the turns before it.
const TARGET_TURN: u64 = 2;

/// What the stand-in provider answers a conversation cut with.
type RewindAnswer = Arc<dyn Fn() -> Result<RewindConversationResult, DriverError> + Send + Sync>;

/// A session whose lead run runs on the stand-in driver, bound on the session's conversation, its
/// cursor open, with the person's message that opened its turn 2 sent through the queue and
/// checkpointed: the undo's target.
struct Scene {
    fixture: Fixture,
    calls: Arc<DriverCalls>,
    /// How many conversation cuts the provider was asked for.
    rewinds: Arc<AtomicUsize>,
    /// Each close of the session's process the provider was asked for, in order.
    closes: Arc<Mutex<Vec<ProcessClose>>>,
    run_id: RunId,
    target: SessionRestoreTarget,
}

/// One close of the session's process the provider was asked for.
#[derive(Debug, PartialEq, Eq)]
struct ProcessClose {
    cause: SessionCloseCause,
    /// Whether the session's append lock could be taken while the close ran.
    is_append_lock_free: bool,
}

/// A cut the provider applied in place.
fn applied_in_place() -> RewindAnswer {
    Arc::new(|| {
        Ok(RewindConversationResult::Applied {
            fork: None,
            cut_message_text: Some("Look again".to_owned()),
        })
    })
}

/// The scene, its provider answering every cut with `answer`.
async fn scene(answer: RewindAnswer) -> Scene {
    let calls = Arc::new(DriverCalls::default());
    let rewinds = Arc::new(AtomicUsize::new(0));
    let mut driver = recording_driver(&calls);
    let asked = Arc::clone(&rewinds);
    driver
        .expect_rewind_conversation()
        .returning(move |_params| {
            asked.fetch_add(1, Ordering::SeqCst);
            let answered = answer();
            async move { answered }.boxed()
        });
    let closes = Arc::new(Mutex::new(Vec::new()));
    let closing = Arc::clone(&closes);
    driver.expect_close_session().returning(move |params| {
        let closes = Arc::clone(&closing);
        async move {
            let is_append_lock_free =
                timeout(HELD_WATCH, SESSION_APPEND_LOCK.acquire(params.session_id))
                    .await
                    .is_ok();
            closes.lock().expect("unpoisoned").push(ProcessClose {
                cause: params.cause,
                is_append_lock_free,
            });
            Ok(())
        }
        .boxed()
    });
    let fixture = fixture(driver).await;
    let run_id = fixture.insert_run("running").await;
    let message_sequence = fixture.insert_sent_message(run_id);
    let target = fixture
        .insert_checkpoint(run_id, message_sequence, SourceEpoch(SafeInt::ZERO))
        .await;
    Scene {
        fixture,
        calls,
        rewinds,
        closes,
        run_id,
        target,
    }
}

impl Fixture {
    /// Writes the person's message sent through the queue into `run_id`, and answers its sequence.
    fn insert_sent_message(&self, run_id: RunId) -> u64 {
        let queue_item_id = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
        self.insert_event(
            run_id,
            SessionEventType::UserMessageSent,
            &json!({
                "sessionId": self.session_id,
                "queueItemId": queue_item_id,
                "runId": run_id,
                "actor": "device-1",
                "message": "Look again",
            }),
        );
        let sequence: i64 = self
            .database
            .reader()
            .query_row(
                "SELECT MAX(sequence) FROM session_events WHERE session_id = ?1",
                [self.session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the message's sequence");
        u64::try_from(sequence).expect("a stored sequence is not negative")
    }

    /// Writes the checkpoint before the message at `message_sequence`, which opened turn 2 of
    /// `run_id` in `epoch`, and answers the undo's target naming it.
    async fn insert_checkpoint(
        &self,
        run_id: RunId,
        message_sequence: u64,
        epoch: SourceEpoch,
    ) -> SessionRestoreTarget {
        let snapshot_id = SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id");
        let checkpoint = Checkpoint {
            checkpoint_id: snapshot_id.clone(),
            session_id: self.session_id,
            message_sequence: SafeInt::new(message_sequence).expect("a small sequence"),
            run_id,
            turn: EpochPosition {
                epoch,
                position: position(TARGET_TURN),
            },
        };
        self.log
            .writer
            .write(vec![insert_checkpoint_statement(&checkpoint)])
            .await
            .expect("the test writes the checkpoint");
        SessionRestoreTarget::Snapshot { snapshot_id }
    }

    /// Appends the turn event `event_type` of `run_id`'s turn 2 through the run engine.
    async fn append_turn_event(&self, run_id: RunId, event_type: &str) {
        let event: SessionEvent = serde_json::from_value(json!({
            "type": event_type,
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": TARGET_TURN,
            },
        }))
        .expect("the test writes a turn event");
        append(&self.queue.engine, self.session_id, &event).await;
    }

    /// The types of the session's stored events, in order.
    fn event_types(&self) -> Vec<String> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare("SELECT type FROM session_events WHERE session_id = ?1 ORDER BY sequence")
            .expect("the test reads the log");
        statement
            .query_map([self.session_id.text().as_str()], |row| row.get(0))
            .expect("the test reads the log")
            .collect::<Result<_, _>>()
            .expect("each type reads as text")
    }

    fn run_version(&self, run_id: RunId) -> i64 {
        stored_run_state(&self.database, &run_id).1
    }
}

fn position(turn: u64) -> SourcePosition {
    SourcePosition(SafeInt::new(turn).expect("a small turn"))
}

fn device() -> DeviceId {
    DeviceId::new("device-1".to_owned()).expect("a test device id")
}
