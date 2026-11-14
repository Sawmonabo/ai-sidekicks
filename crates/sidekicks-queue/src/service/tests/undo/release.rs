//! The undo's release: a send during the undo waits on every route and follows the edited message,
//! the edit reserved as the opening of the run that reads its opening later whatever the order
//! says meanwhile, a run that ends first never records it admitted, back-to-back undos open the run
//! once with the newer edit first, a resume pressed during the undo runs once at the release, a
//! start or continue already under way waits out the undo, a hold dropped unreleased still lets
//! the session go, and a retry under its key keeps its own.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::control::AgentRunResumeRequest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{AgentQueueItemReorderRequest, MessageText, QueueItemId};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::session::restore::SessionRestoreResend;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord};
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_session::run::read::safe_run_version;
use tokio::time::{sleep, timeout};

use super::super::{DriverCalls, HELD_WATCH, WAIT, client_key, fixture, recording_driver};
use super::{Fixture, applied_in_place, device, scene};
use crate::error::QueueError;

/// The edited message an undo sends again, saying `text`.
fn resend_of(text: &str) -> SessionRestoreResend {
    SessionRestoreResend {
        content: MessageText::new(text.to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        output_speed_for_turn: None,
    }
}

impl Fixture {
    /// The edited message the undo `key` sent.
    fn resent(&self, key: &ClientUuid) -> QueueItemRecord {
        QueueItemReader::new(&self.database.reader())
            .get_by_idempotency_key(&self.session_id, key)
            .expect("the test reads the edit")
            .expect("the edit is stored")
    }

    /// The items of the messages sent after the session's last conversation cut, in log order.
    fn sent_after_cut(&self) -> Vec<QueueItemId> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare(
                "SELECT type, payload FROM session_events WHERE session_id = ?1 ORDER BY sequence",
            )
            .expect("the test reads the log");
        let events: Vec<(String, String)> = statement
            .query_map([self.session_id.text().as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("the test reads the log")
            .collect::<Result<_, _>>()
            .expect("each event reads as text");
        let cut_at = events
            .iter()
            .rposition(|(event_type, _)| event_type == "agent.run.rolledBack")
            .expect("the cut is recorded");
        events[cut_at + 1..]
            .iter()
            .filter(|(event_type, _)| event_type == "user.message.sent")
            .map(|(_, payload)| {
                let payload: Value = serde_json::from_str(payload).expect("a stored payload");
                serde_json::from_value(payload["queueItemId"].clone()).expect("a sent item's id")
            })
            .collect()
    }

    /// Puts the lead's waiting messages in `order` as a person does.
    async fn reorder_lead(&self, order: Vec<QueueItemId>) {
        self.queue
            .reorder(AgentQueueItemReorderRequest {
                session_id: self.session_id,
                child_handle: None,
                queue_item_ids: UniqueList::new(order).expect("the order names each once"),
            })
            .await
            .expect("the queue takes the order");
    }

    /// Makes `run_id` the session's lead run resting interrupted, as the lifecycle leaves one a
    /// person interrupted.
    async fn rest_interrupted(&self, run_id: RunId) {
        self.set_run_state(run_id, "interrupted");
        self.insert_interrupted_end(run_id, None);
        self.settle_end(run_id).await;
    }
}

/// The lead run a send made during an undo goes to.
#[derive(Clone, Copy, Debug)]
enum HeldRoute {
    /// The run is live: the send is handed into it.
    Live,
    /// The run rests interrupted: the send continues it.
    Interrupted,
    /// No run is live or interrupted: the send queues a run of its own.
    NoRun,
    /// The run is live and the edit is refused, the session being purged since the cut.
    RefusedResend,
}

// A send during an undo is taken and waits on every route: nothing reaches the driver and no start
// or continue begins while the session is held. At the release the edit is sent after the cut and
// placed ahead of the held send, and the driver opens with the edit, then the held send: steered
// into a live run, opening an interrupted run's continue or the queued run's start. A refused edit
// still lets the hold go and hands the held send, and answers the refusal. Killed by the hold
// left unread in the interrupted run's continue or in a run's start (one under way while held),
// by the hold let go at the cut, by the edit placed after the held send, by the session's lock
// held across the undo (the send never answers), and by the release skipped on a refused edit.
#[rstest]
#[case::live(HeldRoute::Live)]
#[case::interrupted(HeldRoute::Interrupted)]
#[case::no_run(HeldRoute::NoRun)]
#[case::refused_resend(HeldRoute::RefusedResend)]
#[tokio::test]
async fn a_send_during_an_undo_waits_and_follows_the_edit(#[case] route: HeldRoute) {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    match route {
        HeldRoute::Interrupted => fixture.rest_interrupted(scene.run_id).await,
        HeldRoute::NoRun => fixture.set_run_state(scene.run_id, "completed"),
        HeldRoute::Live | HeldRoute::RefusedResend => {}
    }
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");
    let held_run_id = fixture
        .stored_item(held_send)
        .target_run_id
        .expect("the held send waits for a run");
    let is_starting_while_held = fixture.queue.admission.is_starting(held_run_id);
    fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");
    if matches!(route, HeldRoute::RefusedResend) {
        fixture
            .database
            .reader()
            .execute(
                "UPDATE sessions SET state = ?2 WHERE id = ?1",
                params![
                    fixture.session_id.text().as_str(),
                    <&'static str>::from(SessionState::PurgeRequested)
                ],
            )
            .expect("the test moves the session");
    }
    sleep(HELD_WATCH).await;
    fixture.queue.delivery.settle(fixture.session_id).await;
    let starts_while_held = scene.calls.starts();
    let steers_while_held = scene.calls.steers();

    let released = fixture
        .queue
        .release_undo_hold(hold, Some(resend_of("Look closer")), device())
        .await;
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the release's work settles");
    fixture.queue.delivery.settle(fixture.session_id).await;

    assert!(starts_while_held.is_empty(), "{starts_while_held:?}");
    assert!(steers_while_held.is_empty(), "{steers_while_held:?}");
    assert!(!is_starting_while_held, "no start begins while held");
    assert!(!fixture.queue.delivery.is_held_for_undo(fixture.session_id));
    if matches!(route, HeldRoute::RefusedResend) {
        assert!(
            matches!(
                released,
                Err(QueueError::Refused(DomainError {
                    code: RefusalCode::SessionChangeRefused,
                    ..
                }))
            ),
            "{released:?}"
        );
        assert_eq!(fixture.sent_after_cut(), Vec::<QueueItemId>::new());
        assert_eq!(scene.calls.steers(), [(held_send, false)]);
        assert!(
            scene.calls.starts().is_empty(),
            "{:?}",
            scene.calls.starts()
        );
        return;
    }
    released.expect("the release sends the edit");
    let resent = fixture.resent(&key);
    assert_eq!(fixture.sent_after_cut().first(), Some(&resent.id));
    assert!(
        fixture.stored_item(resent.id).position < fixture.stored_item(held_send).position,
        "the edit is placed ahead of the held send"
    );
    if matches!(route, HeldRoute::Live) {
        let steers_after_release = scene.calls.steers();
        let items_after_release = fixture.count_items();
        let again = fixture
            .queue
            .hold_for_undo(fixture.session_id, key.clone())
            .await;
        fixture
            .queue
            .release_undo_hold(again, Some(resend_of("Look closer")), device())
            .await
            .expect("a repeated release answers the first edit");
        fixture.queue.delivery.settle(fixture.session_id).await;
        assert_eq!(
            steers_after_release,
            [(resent.id, false), (held_send, false)]
        );
        assert_eq!(fixture.count_items(), items_after_release);
        assert_eq!(scene.calls.steers(), steers_after_release);
    } else {
        // The interrupted run's continue and the queued run's start open with the edit.
        assert_eq!(resent.target_run_id, Some(held_run_id));
        assert_eq!(
            scene.calls.starts().first(),
            Some(&(held_run_id, resent.id))
        );
    }
}

/// The lead run an undo's release reserves its edit for, which reads its opening after the
/// release lets the session's lock go.
#[derive(Clone, Copy, Debug)]
enum ReservedRun {
    /// A run resting interrupted, continued.
    Interrupted,
    /// The run the held send queued, started.
    Queued,
    /// A paused run, resumed.
    Paused,
}

// A reorder that puts the held send first between the release and the run's read of its opening
// leaves the edit the opening: an interrupted run's continue and a queued run's start open with
// it, and a paused run's resume carries it first. Killed by the edit not reserved (the reorder
// moves the held send ahead of it), and by the resume's read not taking the reservation (the edit
// is left out of the resume). The opening reads' taking the reservation first and the reserved
// edit counting as an opening each mask the other here, so each alone is judged by reading.
#[rstest]
#[case::interrupted(ReservedRun::Interrupted)]
#[case::queued(ReservedRun::Queued)]
#[case::paused(ReservedRun::Paused)]
#[tokio::test]
async fn a_reserved_edit_opens_its_run_whatever_the_order_says(#[case] reserved: ReservedRun) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let resting_run_id = match reserved {
        ReservedRun::Interrupted => {
            let run_id = fixture.insert_run("running").await;
            fixture.rest_interrupted(run_id).await;
            Some(run_id)
        }
        ReservedRun::Paused => {
            let run_id = fixture.insert_run("paused").await;
            // Paused in this daemon, so its session's process is open.
            fixture.open_session(run_id).await;
            Some(run_id)
        }
        ReservedRun::Queued => None,
    };
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");
    let run_id = resting_run_id.unwrap_or_else(|| {
        fixture
            .stored_item(held_send)
            .target_run_id
            .expect("the held send queued a run")
    });
    let pause = match reserved {
        ReservedRun::Paused => fixture.queue.resume_pause.arm(),
        ReservedRun::Interrupted | ReservedRun::Queued => {
            fixture.queue.admission.head_read_pause.arm()
        }
    };
    let reordering = async {
        pause
            .reached
            .await
            .expect("the run's read of its opening is held");
        let resent_id = fixture.resent(&key).id;
        fixture.reorder_lead(vec![held_send, resent_id]).await;
        pause.release.send(()).expect("the read waits");
        resent_id
    };

    let (released, resent_id) = timeout(WAIT, async {
        tokio::join!(
            Box::pin(fixture.queue.release_undo_hold(
                hold,
                Some(resend_of("Look closer")),
                device()
            )),
            reordering
        )
    })
    .await
    .expect("the release answers");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the release's work settles");

    released.expect("the release sends the edit");
    match reserved {
        ReservedRun::Interrupted | ReservedRun::Queued => {
            assert_eq!(calls.starts().first(), Some(&(run_id, resent_id)));
        }
        ReservedRun::Paused => {
            assert_eq!(
                calls.resumes().first(),
                Some(&(run_id, vec![resent_id, held_send]))
            );
        }
    }
}

// A paused run stopped after the release reserved its edit, before its resume read it, never
// records the edit admitted into it: the edit moves with the held send to the next run, which
// opens with it. Killed by the run's end settling the reservation as a started opening (the edit
// admitted into the stopped run, the next run opening with the held send).
#[tokio::test]
async fn a_run_ended_before_it_reads_its_reserved_edit_never_admits_it() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("paused").await;
    bind_run_to_first_provider(&fixture.database, run_id);
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");
    let resume = fixture.queue.resume_pause.arm();
    let ending = async {
        resume.reached.await.expect("the release's resume is held");
        fixture.set_run_state(run_id, "stopped");
        fixture
            .queue
            .lifecycle
            .settle_ended_run(fixture.session_id, run_id);
        fixture
            .queue
            .lifecycle
            .reconcile(fixture.session_id)
            .await
            .expect("the drain answers")
            .expect("the session reads again");
        resume.release.send(()).expect("the resume waits");
    };

    let (released, ()) = timeout(WAIT, async {
        tokio::join!(
            fixture
                .queue
                .release_undo_hold(hold, Some(resend_of("Look closer")), device()),
            ending
        )
    })
    .await
    .expect("the release answers");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the next run's start settles");

    released.expect("the release sends the edit");
    let resent = fixture.resent(&key);
    let next_run_id = resent.target_run_id.expect("the edit waits for a run");
    assert_ne!(next_run_id, run_id);
    assert_eq!(
        fixture.stored_item(held_send).target_run_id,
        Some(next_run_id)
    );
    assert_eq!(calls.starts(), [(next_run_id, resent.id)]);
    assert!(calls.resumes().is_empty(), "{:?}", calls.resumes());
}

// Two undos back to back on a paused run: the first release's resume, held until the second undo
// cut the conversation and reserved its own edit, is refused as stale and leaves that reservation;
// one resume then carries the second edit first, the held send and the first edit after it, each
// once, whatever the order says. Killed by the refused resume dropping the run's reservation
// whatever it names, and by a second reservation that does not replace the first.
#[tokio::test]
async fn back_to_back_undos_resume_a_paused_run_once_with_the_newer_edit_first() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let run_id = scene.run_id;
    fixture.set_run_state(run_id, "paused");
    let first_key = client_key();
    let first_hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, first_key.clone())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");
    let first_resume = fixture.queue.resume_pause.arm();
    let second_resume = fixture.queue.resume_pause.arm();

    let queue = Arc::clone(&fixture.queue);
    let first_release = tokio::spawn(async move {
        queue
            .release_undo_hold(first_hold, Some(resend_of("Look closer")), device())
            .await
    });
    timeout(WAIT, first_resume.reached)
        .await
        .expect("the first release reaches its resume")
        .expect("the first release's resume is held");
    let second_key = client_key();
    let second_hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, second_key.clone())
        .await;
    fixture
        .queue
        .cut_conversation(&second_hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the second cut applies");
    let queue = Arc::clone(&fixture.queue);
    let second_release = tokio::spawn(async move {
        queue
            .release_undo_hold(second_hold, Some(resend_of("Look once more")), device())
            .await
    });
    timeout(WAIT, second_resume.reached)
        .await
        .expect("the second release reaches its resume")
        .expect("the second release's resume is held");
    first_resume
        .release
        .send(())
        .expect("the first resume waits");
    let first_released = timeout(WAIT, first_release)
        .await
        .expect("the first release answers")
        .expect("the first release's task ends");
    let first_edit = fixture.resent(&first_key).id;
    let second_edit = fixture.resent(&second_key).id;
    fixture
        .reorder_lead(vec![held_send, first_edit, second_edit])
        .await;
    second_resume
        .release
        .send(())
        .expect("the second resume waits");
    let second_released = timeout(WAIT, second_release)
        .await
        .expect("the second release answers")
        .expect("the second release's task ends");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the resume settles");

    first_released.expect("the first release sends its edit");
    second_released.expect("the second release sends its edit");
    assert_eq!(
        scene.calls.resumes(),
        [(run_id, vec![second_edit, held_send, first_edit])]
    );
}

/// What waits for the paused lead run a person resumes during an undo.
#[derive(Clone, Copy, Debug)]
enum PressedWith {
    /// A send made to the lead during the undo, which is released with an edit.
    SendAndEdit,
    /// Nothing: no send is made, and the undo is released with no edit.
    Nothing,
}

// The person's `Resume` of the paused lead while an undo holds the session answers `paused` at
// once and reaches no driver; the cut moves the run's version, and at the release the run is
// resumed once at the version read then: with the edit first and the held send after it, or, with
// nothing waiting, with no message. Killed by the queue's read answering an empty list under the
// hold (the press resumes the run during the undo, and the release then steers instead), by the
// release dropping the runs whose resume the hold held back (the press alone is never resumed),
// and by resuming an owed run at the version the press read (refused stale after the cut, so no
// resume reaches the driver).
#[rstest]
#[case::with_a_send_and_an_edit(PressedWith::SendAndEdit)]
#[case::alone(PressedWith::Nothing)]
#[tokio::test]
async fn a_resume_pressed_during_an_undo_runs_once_at_the_release_with_the_edit_first(
    #[case] pressed_with: PressedWith,
) {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let run_id = scene.run_id;
    fixture.set_run_state(run_id, "paused");
    let pressed_version = fixture.run_version(run_id);
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let held_send = match pressed_with {
        PressedWith::SendAndEdit => Some(
            timeout(WAIT, fixture.send())
                .await
                .expect("a send during the undo answers")
                .expect("a send during the undo is taken"),
        ),
        PressedWith::Nothing => None,
    };

    let pressed = timeout(
        WAIT,
        fixture.queue.pauses.resume(
            &AgentRunResumeRequest {
                target_run_id: run_id,
                expected_run_version: safe_run_version(pressed_version),
            },
            &fixture.queue.delivery,
        ),
    )
    .await
    .expect("the press answers at once")
    .expect("the press is taken");
    fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");
    let resumes_while_held = scene.calls.resumes();
    let released_version = fixture.run_version(run_id);
    let resend = held_send.map(|_| resend_of("Look closer"));
    fixture
        .queue
        .release_undo_hold(hold, resend, device())
        .await
        .expect("the release lets the session go");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the release's resume settles");

    assert_eq!(pressed.response.new_state, RunState::Paused);
    assert_eq!(
        pressed.response.run_version,
        safe_run_version(pressed_version)
    );
    assert!(resumes_while_held.is_empty(), "{resumes_while_held:?}");
    assert_ne!(
        released_version, pressed_version,
        "the cut moves the run's version"
    );
    let carried = match held_send {
        Some(held_send) => vec![fixture.resent(&key).id, held_send],
        None => Vec::new(),
    };
    assert_eq!(scene.calls.resumes(), [(run_id, carried)]);
    assert_eq!(fixture.run_state(run_id), "running");
}

/// What was under way when the undo held the session.
#[derive(Clone, Copy, Debug)]
enum UnderWay {
    /// A send's start of the run it queued.
    Start,
    /// A send's continue of the run resting interrupted.
    Continue,
}

// An undo that goes away holding the session, its request canceled or its handler failed, lets
// the hold go: the send it held is handed and the session is held no more. Killed by an
// `UndoHold` with no drop guard.
#[tokio::test]
async fn a_dropped_hold_lets_the_session_go_and_hands_the_held_send() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");

    drop(hold);
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the dropped hold's release settles");
    fixture.queue.delivery.settle(fixture.session_id).await;

    assert!(!fixture.queue.delivery.is_held_for_undo(fixture.session_id));
    let steers = scene.calls.steers();
    assert!(
        steers.iter().any(|(item_id, _)| *item_id == held_send),
        "{steers:?}"
    );
}

// An undo retried under the key of one that was canceled holds the session apart from it: the
// canceled hold's release, which runs on the queue's task once the retry holds, leaves the retry's
// hold in place, and the send made meanwhile is handed only at the retry's release. Killed by
// holds kept by the undo's key, where that late release ends the retry's hold.
#[tokio::test]
async fn a_retry_under_a_canceled_undos_key_keeps_its_own_hold() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let key = client_key();
    let canceled = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let held_send = timeout(WAIT, fixture.send())
        .await
        .expect("a send during the undo answers")
        .expect("a send during the undo is taken");

    drop(canceled);
    let retry = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let releases = &fixture.queue.releases;
    releases.close();
    timeout(WAIT, releases.wait())
        .await
        .expect("the canceled hold's release settles");
    releases.reopen();
    let is_held_after_late_release = fixture.queue.delivery.is_held_for_undo(fixture.session_id);
    fixture
        .queue
        .release_undo_hold(retry, None, device())
        .await
        .expect("the retry lets the session go");
    fixture.queue.delivery.settle(fixture.session_id).await;

    assert!(is_held_after_late_release);
    assert!(!fixture.queue.delivery.is_held_for_undo(fixture.session_id));
    let steers = scene.calls.steers();
    assert!(
        steers.iter().any(|(item_id, _)| *item_id == held_send),
        "{steers:?}"
    );
}

// A start or continue a send began before the undo held the session, held just before its read
// of the run's opening, waits out the undo: nothing opens while the session is held, and at the
// release the run opens with the edit and the earlier send is handed after it. Killed by an
// opening read that reads no undo hold (the run opens with the earlier send while held), and by a
// release that keeps the session's holders, so their signal never closes and the waiting read
// never wakes (the run never opens). An opening read that returns
// instead of waiting is not caught here, since the release's own start or continue then opens the
// run, and is judged by reading.
#[rstest]
#[case::start(UnderWay::Start)]
#[case::continue_run(UnderWay::Continue)]
#[tokio::test]
async fn an_opening_read_under_way_waits_out_the_undo(#[case] under_way: UnderWay) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let resting_run_id = match under_way {
        UnderWay::Continue => {
            let run_id = fixture.insert_run("running").await;
            fixture.rest_interrupted(run_id).await;
            Some(run_id)
        }
        UnderWay::Start => None,
    };
    let head_read = fixture.queue.admission.head_read_pause.arm();
    let earlier_send = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is taken");
    let run_id = resting_run_id.unwrap_or_else(|| {
        fixture
            .stored_item(earlier_send)
            .target_run_id
            .expect("the send queued a run")
    });
    timeout(WAIT, head_read.reached)
        .await
        .expect("the opening read is reached")
        .expect("the opening read is held");
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    head_read.release.send(()).expect("the opening read waits");
    sleep(HELD_WATCH).await;
    let starts_while_held = calls.starts();

    fixture
        .queue
        .release_undo_hold(hold, Some(resend_of("Look closer")), device())
        .await
        .expect("the release sends the edit");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the run opens once the undo lets go");

    assert!(starts_while_held.is_empty(), "{starts_while_held:?}");
    let resent = fixture.resent(&key);
    assert_eq!(calls.starts(), [(run_id, resent.id)]);
    assert_eq!(calls.steers(), [(earlier_send, false)]);
}
