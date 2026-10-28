//! A person's send: into a paused run, which it resumes, into a session whose lead run changes
//! between the send's read and its write, and with a skill its provider does not list; and a review
//! queued as the session's next item, which opens a run of its own.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::{QueueItemId, QueuedSkillPick};
use sidekicks_contracts::session::controls::methods::{
    SessionCodeReviewStartRequest, SessionReviewTarget,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, RunOpeningItem};
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_session::queue_store::{QueueItemBody, QueueItemRecord, RecordedQueueItemState};
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, fixture, recording_driver};
use crate::error::QueueError;

// A send into a paused run resumes it with the message, which the provider is handed on the
// continue and reads admitted, and the run is running. Killed by leaving the message waiting
// while the run stays paused.
#[tokio::test]
async fn a_send_resumes_a_paused_run_with_the_message() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("paused");
    bind_run_to_first_provider(&fixture.database, run_id);

    let item_id = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    fixture.queue.stop().await;

    assert_eq!(calls.resumes(), [(run_id, vec![item_id])]);
    assert_eq!(fixture.run_state(run_id), "running");
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Admitted
    );
}

// A lead run that starts between a send's read and its write turns the send's next attempt into
// that run, writing no run of its own. Killed by refusing at the first changed route.
#[tokio::test]
async fn a_send_whose_lead_run_started_meanwhile_goes_into_it() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let before_write = fixture.queue.sends.route_write_pause.arm();
    let changing = async {
        before_write
            .reached
            .await
            .expect("the send reads its route");
        let run_id = fixture.insert_run("running");
        bind_run_to_first_provider(&fixture.database, run_id);
        before_write.release.send(()).expect("the send waits");
        run_id
    };

    let (sent, run_id) = timeout(WAIT, async { tokio::join!(fixture.send(), changing) })
        .await
        .expect("the send answers");
    fixture.queue.stop().await;

    let item_id = sent.expect("the send is saved");
    assert_eq!(fixture.stored_item(item_id).target_run_id, Some(run_id));
    let runs: i64 = fixture
        .database
        .reader()
        .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))
        .expect("the test counts the runs");
    assert_eq!(runs, 1);
    assert_eq!(calls.steers(), [(item_id, false)]);
}

// A lead run that changes under each of a send's three attempts refuses it with
// `agent.queueItem.runChanged`, writing nothing. Killed by a fourth attempt, which finds the
// last run live and writes the send.
#[tokio::test]
async fn a_send_whose_lead_run_changes_under_every_attempt_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let attempts = [
        fixture.queue.sends.route_write_pause.arm(),
        fixture.queue.sends.route_write_pause.arm(),
        fixture.queue.sends.route_write_pause.arm(),
    ];
    let changing = async {
        let [first, second, third] = attempts;
        // A new run's send finds a run started, a live run's send finds it ended, and the next
        // new run's send finds another started.
        first.reached.await.expect("the first attempt reads");
        let started = fixture.insert_run("running");
        bind_run_to_first_provider(&fixture.database, started);
        first.release.send(()).expect("the send waits");
        second.reached.await.expect("the second attempt reads");
        fixture.set_run_state(started, "completed");
        second.release.send(()).expect("the send waits");
        third.reached.await.expect("the third attempt reads");
        let restarted = fixture.insert_run("running");
        bind_run_to_first_provider(&fixture.database, restarted);
        third.release.send(()).expect("the send waits");
    };

    let (sent, ()) = timeout(WAIT, async { tokio::join!(fixture.send(), changing) })
        .await
        .expect("the send answers");
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, .. })) = sent else {
        panic!("the send is refused as its run changed, got {sent:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemRunChanged);
    assert_eq!(fixture.count_items(), 0);
}

// A send picking a skill the session's provider does not list is refused `skill.pathRefused`
// naming the pick's folder with the reason `notListed`, and nothing is queued. Killed by deleting
// the `SkillNotListed` arm in `queue/admission/skill_picks.rs`, which makes it an internal error.
#[tokio::test]
async fn a_send_picking_a_skill_its_provider_does_not_list_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    let mut driver = recording_driver(&calls);
    driver
        .expect_skill_resolve_starts_process()
        .returning(|| false);
    driver
        .expect_resolve_skill_picks()
        .returning(|_, _, picks| {
            let pick = picks[0].clone();
            async move { Err(DriverError::SkillNotListed(pick)) }.boxed()
        });
    let fixture = fixture(driver).await;
    let pick = QueuedSkillPick {
        name: FreeFormText::new("review".to_owned()).expect("a skill name"),
        folder_path: FilesystemPath::new("/skills/review".to_owned()).expect("a short path"),
    };

    let sent = timeout(WAIT, fixture.send_picking(Some(vec![pick])))
        .await
        .expect("the send answers");
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = sent else {
        panic!("the send is refused for its pick, got {sent:?}");
    };
    assert_eq!(code, RefusalCode::SkillPathRefused);
    let detail = detail.expect("the refusal names the pick");
    assert_eq!(detail["path"], json!("/skills/review"));
    assert_eq!(detail["reason"], json!("notListed"));
    assert_eq!(fixture.count_items(), 0);
}

impl Fixture {
    /// Queues a review of the session's staged set as `session.codeReview.start` does.
    async fn queue_review(&self) {
        timeout(
            WAIT,
            self.queue.queue_review(SessionCodeReviewStartRequest {
                session_id: self.session_id,
                target: SessionReviewTarget::Staged,
            }),
        )
        .await
        .expect("the review answers")
        .expect("the review is queued");
    }

    /// The session's one stored review.
    fn stored_review(&self) -> QueueItemRecord {
        let item_id = self
            .database
            .reader()
            .query_row(
                "SELECT id FROM queue_items WHERE json_extract(payload, '$.kind') = 'review'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("the test reads its one review");
        self.stored_item(QueueItemId::new(&item_id).expect("a stored id is a queue item id"))
    }
}

// A review on a session with no live run is queued as the lead's one item, a review, and the run
// it queues starts through the driver opening with that review, which reads admitted. Killed by a
// review that skips the queue, or one whose run opens with a message.
#[tokio::test]
async fn a_review_on_a_session_with_no_live_run_opens_a_run_of_its_own() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;

    fixture.queue_review().await;
    fixture.queue.stop().await;

    let review = fixture.stored_review();
    assert_eq!(fixture.count_items(), 1);
    assert_eq!(
        review.body,
        QueueItemBody::Review {
            target: SessionReviewTarget::Staged
        }
    );
    let run_id = review.target_run_id.expect("the review waits for its run");
    assert_eq!(calls.starts(), [(run_id, review.id)]);
    assert_eq!(
        calls.opening_items(),
        [RunOpeningItem::Review {
            target: SessionReviewTarget::Staged
        }]
    );
    assert_eq!(review.state, RecordedQueueItemState::Admitted);
}

// A review queued behind a running turn waits for that run's end: a message sent after it is
// steered into the turn, and the review is neither steered nor started. Killed by a hand that
// steers a review into the running turn.
#[tokio::test]
async fn a_review_behind_a_running_turn_is_never_handed_into_it() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running");
    bind_run_to_first_provider(&fixture.database, run_id);

    fixture.queue_review().await;
    let message_id = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    fixture.queue.stop().await;

    let review = fixture.stored_review();
    assert_eq!(calls.steers(), [(message_id, false)]);
    assert!(calls.starts().is_empty(), "{:?}", calls.starts());
    assert_eq!(review.target_run_id, Some(run_id));
    assert_eq!(review.state, RecordedQueueItemState::Queued);
}
