//! A person's send: into a paused run, which it resumes, into a session whose lead run changes
//! between the send's read and its write, with a skill its provider does not list, and repeated
//! under its key after its account was removed; a review queued as the session's next item, which
//! opens a run of its own, takes no edit and is sent again once not delivered, a retry carrying
//! none of a message's extras; and a plan message, which goes as a review does, opens its run as a
//! message carrying its plan, takes no edit, is sent again only in its own words and with none of a
//! message's extras, and is removed by a person only when it builds the plan, never when it seeds a
//! hand-off.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCreateRequest, AgentQueueItemCreateResponse,
    PlanMessage, PlanMessageKind, QueueItemId, QueueItemNotDeliveredReason, QueuedSkillPick,
};
use sidekicks_contracts::session::controls::methods::{
    SessionCodeReviewStartRequest, SessionReviewTarget,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::CurrentProviderAccount;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::RunOpeningItem;
use sidekicks_session::queue_store::{QueueItemBody, QueueItemRecord, RecordedQueueItemState};
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, client_key, fixture, queue_over, recording_driver};
use crate::error::QueueError;

// A send into a paused run resumes it with the message, which the provider is handed on the
// continue and reads admitted, and the run is running. Killed by leaving the message waiting
// while the run stays paused.
#[tokio::test]
async fn a_send_resumes_a_paused_run_with_the_message() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("paused").await;
    // Paused in this daemon, so its session's process is open.
    fixture.open_session(run_id).await;

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
        let run_id = fixture.insert_run("running").await;
        before_write.release.send(()).expect("the send waits");
        run_id
    };

    let (sent, run_id) = Box::pin(timeout(WAIT, async {
        tokio::join!(fixture.send(), changing)
    }))
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
        let started = fixture.insert_run("running").await;
        first.release.send(()).expect("the send waits");
        second.reached.await.expect("the second attempt reads");
        fixture.set_run_state(started, "completed");
        second.release.send(()).expect("the send waits");
        third.reached.await.expect("the third attempt reads");
        fixture.insert_run("running").await;
        third.release.send(()).expect("the send waits");
    };

    let (sent, ()) = Box::pin(timeout(WAIT, async {
        tokio::join!(fixture.send(), changing)
    }))
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
    /// Queues a review of the session's staged set under `key` as `session.codeReview.start` does,
    /// and answers the queued item's id.
    async fn queue_review(&self, key: ClientUuid) -> QueueItemId {
        let queued = timeout(
            WAIT,
            self.queue.queue_review(SessionCodeReviewStartRequest {
                session_id: self.session_id,
                client_idempotency_key: key,
                target: SessionReviewTarget::Staged,
            }),
        )
        .await
        .expect("the review answers")
        .expect("the review is queued");
        queue_item_id_of(&queued)
    }

    /// Sends again, or edits, the item `replaces` as a person's send naming it does, and answers
    /// the send. Fails as the queue refuses it.
    async fn replace_item(
        &self,
        replaces: QueueItemId,
    ) -> Result<AgentQueueItemCreateResponse, QueueError> {
        self.replace_item_carrying(replaces, |_| {}).await
    }

    /// Sends again the item `replaces` with what `carry` adds to the send, and answers the send.
    pub(super) async fn replace_item_carrying(
        &self,
        replaces: QueueItemId,
        carry: impl FnOnce(&mut AgentQueueItemCreateRequest),
    ) -> Result<AgentQueueItemCreateResponse, QueueError> {
        let mut request = AgentQueueItemCreateRequest {
            session_id: self.session_id,
            to: None,
            workspace_id: None,
            client_idempotency_key: client_key(),
            content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
            attachments: None,
            skills: None,
            replaces_queue_item_id: Some(replaces),
            answers_question_id: None,
            output_speed_for_turn: None,
        };
        carry(&mut request);
        timeout(
            WAIT,
            self.queue.create(
                request,
                DeviceId::new("device-1".to_owned()).expect("a test device id"),
            ),
        )
        .await
        .expect("the send answers")
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

// A review on a session whose process runs idle, with no live run, is queued as the lead's one
// item, a review, and admitted at once: the run it queues starts through the driver opening with
// that review, which reads admitted. A start again under the same key answers the same review and
// queues nothing more. Killed by a review that skips the queue, one whose run opens with a
// message, and a review queued with no key.
#[tokio::test]
async fn a_review_on_a_session_with_no_live_run_opens_a_run_of_its_own() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let key = client_key();

    let first = fixture.queue_review(key.clone()).await;
    fixture.queue.stop().await;
    let again = fixture.queue_review(key).await;
    fixture.queue.stop().await;

    let review = fixture.stored_review();
    assert_eq!(again, first);
    assert_eq!(review.id, first);
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
    let run_id = fixture.insert_run("running").await;

    fixture.queue_review(client_key()).await;
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

// An edit naming a review that waits behind a running turn is refused
// `agent.queueItem.changeRefused` with the reason `reviewItem`, and the review keeps waiting,
// nothing written. Killed by an edit that answers the review as an item the queue does not hold, or
// edits it like a message.
#[tokio::test]
async fn an_edit_of_a_waiting_review_is_refused_as_a_review_item() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.insert_run("running").await;
    let review_id = fixture.queue_review(client_key()).await;

    let edited = fixture.replace_item(review_id).await;
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = edited else {
        panic!("the edit is refused, got {edited:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("reviewItem")
    );
    assert_eq!(fixture.count_items(), 1);
    assert_eq!(
        fixture.stored_state(review_id),
        RecordedQueueItemState::Queued
    );
}

// A review whose run failed to start reads not delivered, and a send naming it queues the same
// review again: the failed one reads superseded, with its superseded event written, and the new
// review opens a run of its own through the driver. Killed by a retry that answers the review as
// an item the queue does not hold, one sent as a message, and a retry that writes no superseded
// event.
#[tokio::test]
async fn a_review_not_delivered_is_sent_again_as_the_same_review() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let failed_id = fixture.queue_review(client_key()).await;
    fixture.queue.stop().await;
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );

    let retried = fixture
        .replace_item(failed_id)
        .await
        .expect("the retry is queued");
    fixture.queue.stop().await;

    let (AgentQueueItemCreateResponse::Queued { queue_item_id, .. }
    | AgentQueueItemCreateResponse::Admitted { queue_item_id, .. }) = retried
    else {
        panic!("the retry waits or is admitted: {retried:?}");
    };
    let review = fixture.stored_item(queue_item_id);
    assert_eq!(
        review.body,
        QueueItemBody::Review {
            target: SessionReviewTarget::Staged
        }
    );
    assert_eq!(review.state, RecordedQueueItemState::Admitted);
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::Superseded
    );
    let superseded_events: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM session_events
             WHERE type = 'agent.queueItem.superseded' AND instr(payload, ?1) > 0",
            [failed_id.to_string()],
            |row| row.get(0),
        )
        .expect("the test reads the superseded events");
    assert_eq!(superseded_events, 1);
    let run_id = review.target_run_id.expect("the retry waits for its run");
    assert_eq!(calls.starts().last(), Some(&(run_id, queue_item_id)));
    assert_eq!(
        calls.opening_items(),
        [
            RunOpeningItem::Review {
                target: SessionReviewTarget::Staged
            },
            RunOpeningItem::Review {
                target: SessionReviewTarget::Staged
            }
        ]
    );
}

// A retry of a review not delivered that carries an answered question and a speed is refused
// `agent.queueItem.changeRefused`, `retryExtras`, and the failed review stays not delivered,
// nothing written. Killed by a retry that queues the review and drops what the send carried.
#[tokio::test]
async fn a_review_s_retry_carrying_what_a_review_cannot_take_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let failed_id = fixture.queue_review(client_key()).await;
    fixture.queue.stop().await;

    let retried = fixture
        .replace_item_carrying(failed_id, |request| {
            request.answers_question_id =
                Some(QuestionId::try_from(mint_uuid_v7()).expect("a minted UUID"));
            request.output_speed_for_turn =
                Some(ProviderToken::new("standard".to_owned()).expect("a speed token"));
        })
        .await;
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = retried else {
        panic!("the retry is refused, got {retried:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("retryExtras")
    );
    assert_eq!(fixture.count_items(), 1);
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );
}

// A send that opens the session's next lead run admits it under the daemon's configured
// `Tokens per run`, kept on its creation record. Killed by admission that writes no limit.
#[tokio::test]
async fn a_new_lead_run_is_admitted_with_the_configured_token_limit() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;

    timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    fixture.queue.stop().await;

    let token_limit: Option<i64> = fixture
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.effectiveRunConfig.tokenLimit') FROM session_events
             WHERE type = 'agent.run.queued'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the run's creation record");
    assert_eq!(token_limit, Some(500_000));
}

// A send repeated under its key answers what the first send saved, though no account of its
// provider is registered any more. Killed by resolving the account before reading the saved send
// (the repeat is refused `provider.account.notRegistered`).
#[tokio::test]
async fn a_send_repeated_after_its_account_was_removed_answers_the_saved_one() {
    let fixture = fixture(MockProviderDriver::new()).await;
    let run_id = fixture.insert_run("queued").await;
    let item_id = fixture.queue_message(run_id).await;
    let key = fixture
        .stored_item(item_id)
        .client_idempotency_key
        .expect("the saved send keeps its key");
    let queue = queue_over(
        &fixture.database,
        &fixture.log,
        &fixture.home,
        MockProviderDriver::new(),
        Arc::clone(&fixture.process) as _,
        CurrentProviderAccount::NoneRegistered,
        Arc::clone(&fixture.halted_runs) as _,
        &fixture.orphaned_approvals,
        &fixture.resumed_runs,
    );

    let answer = queue
        .create(
            AgentQueueItemCreateRequest {
                session_id: fixture.session_id,
                to: None,
                workspace_id: None,
                client_idempotency_key: key,
                content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
                attachments: None,
                skills: None,
                replaces_queue_item_id: None,
                answers_question_id: None,
                output_speed_for_turn: None,
            },
            DeviceId::new("device-1".to_owned()).expect("a test device id"),
        )
        .await
        .expect("the repeated send answers the saved one");

    assert!(
        matches!(
            answer,
            AgentQueueItemCreateResponse::Queued { queue_item_id, .. } if queue_item_id == item_id
        ),
        "{answer:?}"
    );
    assert_eq!(fixture.count_items(), 1);
}

/// The words of the plan messages the tests send.
pub(super) const PLAN_MESSAGE_TEXT: &str = "Implement the plan.";

/// The device whose verdict the tests' plan messages carry out.
const VERDICT_DEVICE: &str = "device-verdict";

impl Fixture {
    /// Sends the daemon's plan message of `kind` for `plan_id` under `key`, for the verdict of
    /// [`VERDICT_DEVICE`], and answers the queued item's id.
    pub(super) async fn send_plan_message(
        &self,
        plan_id: PlanId,
        kind: PlanMessageKind,
        key: ClientUuid,
    ) -> QueueItemId {
        let queued = timeout(
            WAIT,
            self.queue.send_plan_message(
                self.session_id,
                PlanMessage {
                    plan_id,
                    kind,
                    source_session_id: None,
                },
                FreeFormText::new(PLAN_MESSAGE_TEXT.to_owned()).expect("a test message"),
                key,
                DeviceId::new(VERDICT_DEVICE.to_owned()).expect("a test device id"),
            ),
        )
        .await
        .expect("the plan message answers")
        .expect("the plan message is queued");
        queue_item_id_of(&queued)
    }

    /// Removes the lead's item `item_id` as a person's removal does.
    async fn cancel_item(&self, item_id: QueueItemId) -> Result<(), QueueError> {
        timeout(
            WAIT,
            self.queue.cancel(AgentQueueItemCancelRequest {
                queue_item_id: item_id,
                child_handle: None,
            }),
        )
        .await
        .expect("the removal answers")
        .map(|_| ())
    }

    /// The `user.message.sent` payload recorded for `item_id`.
    fn sent_message_payload(&self, item_id: QueueItemId) -> serde_json::Value {
        let payload: String = self
            .database
            .reader()
            .query_row(
                "SELECT payload FROM session_events
                 WHERE type = 'user.message.sent'
                   AND json_extract(payload, '$.queueItemId') = ?1",
                [item_id.to_string()],
                |row| row.get(0),
            )
            .expect("the test reads the item's transcript row");
        serde_json::from_str(&payload).expect("a stored payload is JSON")
    }
}

/// The id of the item a queued send answers.
pub(super) fn queue_item_id_of(queued: &AgentQueueItemCreateResponse) -> QueueItemId {
    match queued {
        AgentQueueItemCreateResponse::Queued { queue_item_id, .. }
        | AgentQueueItemCreateResponse::Admitted { queue_item_id, .. } => *queue_item_id,
        other @ (AgentQueueItemCreateResponse::Superseded { .. }
        | AgentQueueItemCreateResponse::Canceled { .. }
        | AgentQueueItemCreateResponse::NotDelivered { .. }) => {
            panic!("the send waits or is admitted: {other:?}")
        }
    }
}

/// A new plan's id.
pub(super) fn new_plan_id() -> PlanId {
    PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id")
}

/// The opening a plan message's run starts with: its words alone.
fn plan_message_opening() -> RunOpeningItem {
    RunOpeningItem::Message {
        content: FreeFormText::new(PLAN_MESSAGE_TEXT.to_owned()).expect("a test message"),
        attachments: Vec::new(),
        skills: Vec::new(),
    }
}

// A plan message sent behind a running turn waits for that run's end: a message the person sends
// after it is steered into the turn, and the plan message is neither steered nor started; a send
// again under its key answers the same item and queues nothing more. Killed by a plan message
// steered into the running turn, and by a second send under its key making a second item.
#[tokio::test]
async fn a_plan_message_behind_a_running_turn_is_never_handed_into_it() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running").await;
    let plan_id = new_plan_id();
    let key = client_key();

    let plan_message_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Build, key.clone())
        .await;
    let message_id = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    let again = fixture
        .send_plan_message(plan_id, PlanMessageKind::Build, key)
        .await;
    fixture.queue.stop().await;

    assert_eq!(again, plan_message_id);
    assert_eq!(fixture.count_items(), 2);
    assert_eq!(calls.steers(), [(message_id, false)]);
    assert!(calls.starts().is_empty(), "{:?}", calls.starts());
    let plan_message = fixture.stored_item(plan_message_id);
    assert_eq!(plan_message.target_run_id, Some(run_id));
    assert_eq!(plan_message.state, RecordedQueueItemState::Queued);
}

// A plan message on a session with no live run opens a run of its own at once, through the driver
// as a message of its words alone, and reads admitted; its transcript row is `user.message.sent`
// naming the verdict's device as its actor and carrying the plan, with no voice origin. Killed by
// a plan message opened as a review, a row naming another actor, one without the plan, and the
// plan put on the message's origin.
#[tokio::test]
async fn a_plan_message_at_rest_opens_a_run_of_its_own_recorded_with_its_plan() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();

    let item_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Build, client_key())
        .await;
    fixture.queue.stop().await;

    let item = fixture.stored_item(item_id);
    let run_id = item
        .target_run_id
        .expect("the plan message waits for its run");
    assert_eq!(calls.starts(), [(run_id, item_id)]);
    assert_eq!(calls.opening_items(), [plan_message_opening()]);
    assert_eq!(item.state, RecordedQueueItemState::Admitted);
    let sent = fixture.sent_message_payload(item_id);
    assert_eq!(sent["actor"], json!(VERDICT_DEVICE));
    assert_eq!(sent["deviceId"], json!(VERDICT_DEVICE));
    assert_eq!(sent["message"], json!(PLAN_MESSAGE_TEXT));
    assert_eq!(
        sent["planMessage"],
        json!({ "planId": plan_id, "kind": "build" })
    );
    assert!(sent.get("origin").is_none(), "{sent}");
}

// An edit naming a plan message that waits behind a running turn is refused
// `agent.queueItem.changeRefused` with the reason `planMessage`, and the plan message keeps
// waiting, nothing written. Killed by an edit admitted like a message's.
#[tokio::test]
async fn an_edit_of_a_waiting_plan_message_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.insert_run("running").await;
    let item_id = fixture
        .send_plan_message(new_plan_id(), PlanMessageKind::Build, client_key())
        .await;
    let events = fixture.count_events(None, None);

    let edited = fixture.replace_item(item_id).await;
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = edited else {
        panic!("the edit is refused, got {edited:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("planMessage")
    );
    assert_eq!(fixture.count_items(), 1);
    assert_eq!(fixture.count_events(None, None), events);
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Queued
    );
}

// A plan message whose run failed to start reads not delivered: a retry in other words is refused
// `agent.queueItem.changeRefused`, `notDelivered`, and one in its own words queues the same plan
// message again, the failed one superseded, opening a run of its own as the same message with its
// plan on the new row. Killed by a retry in other words that is sent, and by a retry sent as the
// person's message.
#[tokio::test]
async fn a_plan_message_not_delivered_goes_again_only_in_its_own_words() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();
    let failed_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    fixture.queue.stop().await;
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );

    let other_words = fixture.replace_item(failed_id).await;
    let own_words = fixture
        .replace_item_carrying(failed_id, |request| {
            request.content =
                FreeFormText::new(PLAN_MESSAGE_TEXT.to_owned()).expect("a test message");
        })
        .await
        .expect("the retry is queued");
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = other_words else {
        panic!("the retry in other words is refused, got {other_words:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("notDelivered")
    );
    let retried_id = queue_item_id_of(&own_words);
    let retried = fixture.stored_item(retried_id);
    assert_eq!(retried.body, fixture.stored_item(failed_id).body);
    assert_eq!(retried.state, RecordedQueueItemState::Admitted);
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::Superseded
    );
    assert_eq!(
        calls.opening_items(),
        [plan_message_opening(), plan_message_opening()]
    );
    assert_eq!(
        fixture.sent_message_payload(retried_id)["planMessage"],
        json!({ "planId": plan_id, "kind": "seed" })
    );
}

// A retry of a plan message not delivered, in its own words but carrying files, is refused
// `agent.queueItem.changeRefused`, `retryExtras`, as a review's is, and the failed plan message
// stays not delivered, nothing written. Killed by a retry that queues the plan message and drops
// the files.
#[tokio::test]
async fn a_plan_message_s_retry_carrying_files_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let failed_id = fixture
        .send_plan_message(new_plan_id(), PlanMessageKind::Seed, client_key())
        .await;
    fixture.queue.stop().await;

    let retried = fixture
        .replace_item_carrying(failed_id, |request| {
            request.content =
                FreeFormText::new(PLAN_MESSAGE_TEXT.to_owned()).expect("a test message");
            request.attachments = Some(AttachmentReferenceList(vec![
                ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id"),
            ]));
        })
        .await;
    fixture.queue.stop().await;

    let Err(QueueError::Refused(DomainError { code, detail, .. })) = retried else {
        panic!("the retry is refused, got {retried:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("retryExtras")
    );
    assert_eq!(fixture.count_items(), 1);
    assert_eq!(
        fixture.stored_state(failed_id),
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );
}

// A person's removal of a waiting build message is admitted as any message of theirs and reads
// canceled, while one of a hand-off's seed is refused `agent.queueItem.changeRefused`,
// `handOffSeed`, the seed still waiting and nothing written. Killed by a seed a person cancels,
// and by a build message's removal refused as a seed's.
#[tokio::test]
async fn a_person_removes_a_build_message_but_never_a_hand_off_s_seed() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.insert_run("running").await;
    let build_id = fixture
        .send_plan_message(new_plan_id(), PlanMessageKind::Build, client_key())
        .await;
    let seed_id = fixture
        .send_plan_message(new_plan_id(), PlanMessageKind::Seed, client_key())
        .await;

    fixture
        .cancel_item(build_id)
        .await
        .expect("the build message is removed");
    let events = fixture.count_events(None, None);
    let seed_canceled = fixture.cancel_item(seed_id).await;
    fixture.queue.stop().await;

    assert_eq!(
        fixture.stored_state(build_id),
        RecordedQueueItemState::Canceled
    );
    let Err(QueueError::Refused(DomainError { code, detail, .. })) = seed_canceled else {
        panic!("the seed's removal is refused, got {seed_canceled:?}");
    };
    assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
    assert_eq!(
        detail.expect("the refusal names its reason")["reason"],
        json!("handOffSeed")
    );
    assert_eq!(
        fixture.stored_state(seed_id),
        RecordedQueueItemState::Queued
    );
    assert_eq!(fixture.count_events(None, None), events);
}
