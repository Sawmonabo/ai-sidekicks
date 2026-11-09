//! An undo through the queue: the conversation cut, asked of the provider only once every run it
//! reaches holds no open turn and written in one write with the caller's companions, the fence on
//! the session's binding, the reach of an undo to a steer, and the release that sends the edited
//! message ahead of the held sends. The scenes and the fixture's writes they share are here.

mod cut;
mod release;
mod steer;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::restore::{SessionRestoreTarget, SnapshotId};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::rewind::RewindConversationResult;
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_provider::port::run_host::RunHost;
use sidekicks_session::checkpoints::schema::{CheckpointVersionContent, CheckpointVersionLeg};
use sidekicks_session::checkpoints::store::{
    Checkpoint, CheckpointVersion, insert_checkpoint_statement, insert_version_statement,
    newest_checkpoint, versions_after,
};
use sidekicks_session::queue_store::{QueueItemExit, QueueItemOutcome, leave_queued_statement};
use sidekicks_session::run::engine::test_fixture::{append, stored_run_state};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, HELD_WATCH, fixture, recording_driver};
use crate::service::undo::reach::UndoReach;
use crate::session_lock::QueueSessionLock;
use crate::test_items::Form;

/// The run position the undo's target message, the opening of its run's second turn, takes; the
/// cut keeps the positions before it.
const TARGET_POSITION: u64 = 2;

/// The number of the turn the target message opened.
const TARGET_TURN_NUMBER: u64 = 2;

/// The run position the steer into the target's turn takes, right after its opening's.
const STEER_POSITION: u64 = 3;

/// The run positions of the second steer into the target's turn and of the next turn's opening.
const SECOND_STEER_POSITION: u64 = 4;
const LATER_OPENING_POSITION: u64 = 5;

/// The words of the target message, of the two steers into its turn, of the next turn's opening
/// and of the steer into the answer turn.
const OPENING_WORDS: &str = "Look again";
const STEER_WORDS: &str = "Then the tests";
const SECOND_STEER_WORDS: &str = "And the docs";
const LATER_WORDS: &str = "Now ship it";
const ANSWER_STEER_WORDS: &str = "Use the newer client";

/// The file the target's turn edits before the steer, the one it edits after, the one the answer
/// turn edits before its steer, and the one it edits after.
const OPENING_EDIT: &str = "/repo/first.txt";
const STEER_EDIT: &str = "/repo/second.txt";
const ANSWER_EDIT: &str = "/repo/third.txt";
const ANSWER_STEER_EDIT: &str = "/repo/fourth.txt";

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
    /// The message each cut the provider was asked for lands before, in order.
    rewound_message_ids: Arc<Mutex<Vec<String>>>,
    /// Each close of the session's process the provider was asked for, in order.
    closes: Arc<Mutex<Vec<ProcessClose>>>,
    run_id: RunId,
    target: SessionRestoreTarget,
    /// The queue item of the message at `target`.
    target_message_id: QueueItemId,
}

/// One close of the session's process the provider was asked for.
#[derive(Debug, PartialEq, Eq)]
struct ProcessClose {
    cause: SessionCloseCause,
    /// Whether the session's append lock could be taken while the close ran.
    is_append_lock_free: bool,
    /// Whether the queue's hold on the session could be taken while the close ran.
    is_queue_lock_free: bool,
}

/// A cut the provider applied in place, naming words of its own for the cut message, which the
/// draft never takes.
fn applied_in_place() -> RewindAnswer {
    Arc::new(|| {
        Ok(RewindConversationResult::Applied {
            fork: None,
            cut_message_text: Some("The provider's own words".to_owned()),
        })
    })
}

/// The scene, its provider answering every cut with `answer` and cutting inside a turn.
async fn scene(answer: RewindAnswer) -> Scene {
    scene_on(answer, true, Form::Words(OPENING_WORDS)).await
}

/// The scene, its provider answering every cut with `answer`, its cut landing inside a turn as
/// `can_cut_inside_turn` says, the target message sent in `opening`'s form; the provider answers
/// each skill pick by its name and folder.
async fn scene_on(answer: RewindAnswer, can_cut_inside_turn: bool, opening: Form) -> Scene {
    let calls = Arc::new(DriverCalls::default());
    let rewinds = Arc::new(AtomicUsize::new(0));
    let rewound_message_ids = Arc::new(Mutex::new(Vec::new()));
    let mut driver = recording_driver(&calls);
    let asked = Arc::clone(&rewinds);
    let rewound = Arc::clone(&rewound_message_ids);
    driver
        .expect_rewind_conversation()
        .returning(move |params| {
            asked.fetch_add(1, Ordering::SeqCst);
            rewound
                .lock()
                .expect("unpoisoned")
                .push(params.target_message_id);
            let answered = answer();
            async move { answered }.boxed()
        });
    driver
        .expect_can_cut_inside_turn()
        .return_const(can_cut_inside_turn);
    driver
        .expect_skill_resolve_starts_process()
        .return_const(false);
    driver
        .expect_resolve_skill_picks()
        .returning(|_, _, picks| {
            let resolved = picks
                .iter()
                .map(|pick| {
                    serde_json::from_value(json!({
                        "name": pick.name.as_str(),
                        "path": pick.folder_path.as_str(),
                    }))
                    .expect("a resolved pick")
                })
                .collect();
            async move { Ok(resolved) }.boxed()
        });
    let closes = Arc::new(Mutex::new(Vec::new()));
    let closing = Arc::clone(&closes);
    // Set once the queue is built, before any close can run.
    let queue_lock: Arc<OnceLock<Arc<QueueSessionLock>>> = Arc::new(OnceLock::new());
    let closing_queue_lock = Arc::clone(&queue_lock);
    driver.expect_close_session().returning(move |params| {
        let closes = Arc::clone(&closing);
        let queue_lock = Arc::clone(
            closing_queue_lock
                .get()
                .expect("the queue is built before a close"),
        );
        async move {
            let is_append_lock_free =
                timeout(HELD_WATCH, SESSION_APPEND_LOCK.acquire(params.session_id))
                    .await
                    .is_ok();
            let is_queue_lock_free =
                timeout(HELD_WATCH, queue_lock.hold_session(params.session_id))
                    .await
                    .is_ok();
            closes.lock().expect("unpoisoned").push(ProcessClose {
                cause: params.cause,
                is_append_lock_free,
                is_queue_lock_free,
            });
            Ok(())
        }
        .boxed()
    });
    let fixture = fixture(driver).await;
    assert!(
        queue_lock
            .set(Arc::clone(&fixture.queue.session_lock))
            .is_ok(),
        "the queue's lock is set once"
    );
    let run_id = fixture.insert_run("running").await;
    let (target_message_id, message_sequence) = fixture.insert_sent_message(run_id, opening).await;
    let target = fixture
        .insert_checkpoint(
            run_id,
            message_sequence,
            TARGET_TURN_NUMBER,
            epoch_position(0, TARGET_POSITION),
        )
        .await;
    Scene {
        fixture,
        calls,
        rewinds,
        rewound_message_ids,
        closes,
        run_id,
        target,
        target_message_id,
    }
}

/// The scene with steers into the target's turn and a turn after it: the turn opens with the
/// scene's message O, edits [`OPENING_EDIT`], takes the steer S, edits [`STEER_EDIT`], takes the
/// steer S2 and ends; then O3 opens the run's next turn, which ends.
struct SteerScene {
    /// The scene, its `target` and `target_message_id` naming S.
    scene: Scene,
    /// The queue item of the turn's opening message.
    opening_message_id: QueueItemId,
    /// The opening's checkpoint.
    opening: SessionRestoreTarget,
}

/// The steer scene, its provider answering every cut with `answer` and cutting inside a turn as
/// `can_cut_inside_turn` says, O sent in `opening`'s form.
async fn steer_scene(answer: RewindAnswer, can_cut_inside_turn: bool, opening: Form) -> SteerScene {
    let mut scene = scene_on(answer, can_cut_inside_turn, opening).await;
    let fixture = &scene.fixture;
    let run_id = scene.run_id;
    let opening = scene.target.clone();
    let opening_message_id = scene.target_message_id;
    fixture
        .append_turn_event(run_id, "agent.turn.started", TARGET_TURN_NUMBER)
        .await;
    fixture.insert_edit(&opening, OPENING_EDIT).await;
    let (steer_message_id, steer) = fixture
        .insert_steer(run_id, STEER_WORDS, TARGET_TURN_NUMBER, STEER_POSITION)
        .await;
    fixture.insert_edit(&steer, STEER_EDIT).await;
    fixture
        .insert_steer(
            run_id,
            SECOND_STEER_WORDS,
            TARGET_TURN_NUMBER,
            SECOND_STEER_POSITION,
        )
        .await;
    fixture
        .append_turn_event(run_id, "agent.turn.completed", TARGET_TURN_NUMBER)
        .await;
    let (_, later_sequence) = fixture
        .insert_sent_message(run_id, Form::Words(LATER_WORDS))
        .await;
    fixture
        .insert_checkpoint(
            run_id,
            later_sequence,
            TARGET_TURN_NUMBER + 1,
            epoch_position(0, LATER_OPENING_POSITION),
        )
        .await;
    for event_type in ["agent.turn.started", "agent.turn.completed"] {
        fixture
            .append_turn_event(run_id, event_type, TARGET_TURN_NUMBER + 1)
            .await;
    }
    scene.target = steer;
    scene.target_message_id = steer_message_id;
    SteerScene {
        scene,
        opening_message_id,
        opening,
    }
}

/// The steer scene, cutting inside a turn as `can_cut_inside_turn` says, with a turn after it
/// that no message of the person's of its own opened: the run engine opens it with the queue item
/// of `opening` admitted to the run where given, as a review is, else with none, as Codex's answer
/// turn is; it edits [`ANSWER_EDIT`], takes the steer S3, edits [`ANSWER_STEER_EDIT`] and ends.
struct DaemonTurnScene {
    /// The scene, its `target` and `target_message_id` naming S3.
    scene: Scene,
    /// The checkpoint the turn's start wrote.
    turn_start: Checkpoint,
    /// The queue item the turn was opened with.
    opening_id: Option<QueueItemId>,
}

/// The daemon-turn scene, its provider answering every cut with `answer`.
async fn daemon_turn_scene(
    answer: RewindAnswer,
    can_cut_inside_turn: bool,
    opening: Option<Form>,
) -> DaemonTurnScene {
    let mut scene = steer_scene(answer, can_cut_inside_turn, Form::Words(OPENING_WORDS))
        .await
        .scene;
    let fixture = &scene.fixture;
    let run_id = scene.run_id;
    let opening_id = match opening {
        Some(form) => {
            let queue_item_id = fixture.queue_form(run_id, form).await;
            fixture.admit(queue_item_id, run_id).await;
            Some(queue_item_id)
        }
        None => None,
    };
    let started = RunHost::start_turn(
        fixture.queue.engine.as_ref(),
        run_id,
        None,
        None,
        opening_id,
    )
    .await
    .expect("the turn's start is written")
    .expect("the run is live");
    let turn_start = newest_checkpoint(&fixture.database.reader(), fixture.session_id)
        .expect("the checkpoints read")
        .expect("the session holds a checkpoint")
        .checkpoint;
    assert_eq!(
        turn_start.turn_number, started.turn_number,
        "the turn's start wrote a checkpoint of its own"
    );
    fixture
        .insert_edit(
            &SessionRestoreTarget::Snapshot {
                snapshot_id: turn_start.checkpoint_id.clone(),
            },
            ANSWER_EDIT,
        )
        .await;
    let (steer_message_id, steer) = fixture
        .insert_steer(
            run_id,
            ANSWER_STEER_WORDS,
            started.turn_number.get(),
            turn_start.turn.position.0.get() + 1,
        )
        .await;
    fixture.insert_edit(&steer, ANSWER_STEER_EDIT).await;
    fixture
        .append_turn_event(run_id, "agent.turn.completed", started.turn_number.get())
        .await;
    scene.target = steer;
    scene.target_message_id = steer_message_id;
    DaemonTurnScene {
        scene,
        turn_start,
        opening_id,
    }
}

impl Fixture {
    /// Writes the person's message of `form`, sent through the queue into `run_id` and taken by
    /// it, and answers its queue item and its sequence.
    async fn insert_sent_message(&self, run_id: RunId, form: Form) -> (QueueItemId, u64) {
        let words = form
            .body()
            .as_message()
            .expect("the person's message")
            .content
            .as_str()
            .to_owned();
        let queue_item_id = self.queue_form(run_id, form).await;
        self.admit(queue_item_id, run_id).await;
        self.insert_event(
            run_id,
            SessionEventType::UserMessageSent,
            &json!({
                "sessionId": self.session_id,
                "queueItemId": queue_item_id,
                "runId": run_id,
                "actor": "device-1",
                "message": words,
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
        (
            queue_item_id,
            u64::try_from(sequence).expect("a stored sequence is not negative"),
        )
    }

    /// Admits the waiting queue item `queue_item_id` to `run_id`.
    async fn admit(&self, queue_item_id: QueueItemId, run_id: RunId) {
        self.log
            .writer
            .write(vec![leave_queued_statement(
                &queue_item_id,
                &QueueItemExit::Outcome(QueueItemOutcome::Admitted { run_id }),
                &WireInstant::now(),
            )])
            .await
            .expect("the test admits its queue item");
    }

    /// Writes the checkpoint before the message at `message_sequence`, which took `turn` of
    /// `run_id` in its turn `turn_number`, and answers the undo's target naming it.
    async fn insert_checkpoint(
        &self,
        run_id: RunId,
        message_sequence: u64,
        turn_number: u64,
        turn: EpochPosition,
    ) -> SessionRestoreTarget {
        let snapshot_id = SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id");
        let checkpoint = Checkpoint {
            checkpoint_id: snapshot_id.clone(),
            session_id: self.session_id,
            message_sequence: SafeInt::new(message_sequence).expect("a small sequence"),
            run_id,
            turn_number: SafeInt::new(turn_number).expect("a turn number"),
            turn,
        };
        self.log
            .writer
            .write(vec![insert_checkpoint_statement(&checkpoint)])
            .await
            .expect("the test writes the checkpoint");
        SessionRestoreTarget::Snapshot { snapshot_id }
    }

    /// Writes the person's message saying `words`, steered into turn `turn_number` of `run_id` at
    /// run position `at` with its checkpoint, and answers its queue item and the checkpoint.
    async fn insert_steer(
        &self,
        run_id: RunId,
        words: &'static str,
        turn_number: u64,
        at: u64,
    ) -> (QueueItemId, SessionRestoreTarget) {
        let (message_id, sequence) = self.insert_sent_message(run_id, Form::Words(words)).await;
        self.insert_event(
            run_id,
            SessionEventType::AgentTurnSteered,
            &json!({
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": turn_number,
                "position": at,
                "messageId": message_id,
            }),
        );
        let checkpoint = self
            .insert_checkpoint(run_id, sequence, turn_number, epoch_position(0, at))
            .await;
        (message_id, checkpoint)
    }

    /// Writes an edit's version of `path` into the checkpoint `target` names.
    async fn insert_edit(&self, target: &SessionRestoreTarget, path: &str) {
        let SessionRestoreTarget::Snapshot { snapshot_id } = target else {
            panic!("the scene names its checkpoints by snapshot");
        };
        let version = CheckpointVersion {
            path: FilesystemPath::new(path.to_owned()).expect("a test path"),
            leg: CheckpointVersionLeg::Edit,
            content: CheckpointVersionContent::Created,
            parent_real_path: FilesystemPath::new("/repo".to_owned()).expect("a test path"),
            window_id: None,
            tool_call_id: None,
        };
        self.log
            .writer
            .write(vec![insert_version_statement(snapshot_id, &version)])
            .await
            .expect("the test writes the edit");
    }

    /// The paths an undo to before the message at `message_sequence` puts back, in path order.
    fn restored_paths(&self, message_sequence: SafeInt<0>) -> Vec<String> {
        versions_after(&self.database.reader(), self.session_id, message_sequence)
            .expect("the test reads the versions")
            .into_iter()
            .map(|stored| stored.version.path.as_str().to_owned())
            .collect()
    }

    /// Appends the turn event `event_type` of turn `turn_number` of `run_id` through the run
    /// engine.
    async fn append_turn_event(&self, run_id: RunId, event_type: &str, turn_number: u64) {
        let event: SessionEvent = serde_json::from_value(json!({
            "type": event_type,
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": turn_number,
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

/// The words of each message `reach` takes back, in its order.
fn cut_words(reach: &UndoReach) -> Vec<&str> {
    reach
        .cut_messages
        .iter()
        .map(|message| message.body.content.as_str())
        .collect()
}

fn position(position: u64) -> SourcePosition {
    SourcePosition(SafeInt::new(position).expect("a small position"))
}

fn epoch_position(epoch: u64, at: u64) -> EpochPosition {
    EpochPosition {
        epoch: SourceEpoch(SafeInt::new(epoch).expect("a small epoch")),
        position: position(at),
    }
}

fn device() -> DeviceId {
    DeviceId::new("device-1".to_owned()).expect("a test device id")
}
