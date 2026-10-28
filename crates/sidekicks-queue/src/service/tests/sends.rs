//! A person's send: into a paused run, which it resumes, into a session whose lead run changes
//! between the send's read and its write, with a skill its provider does not list, and repeated
//! under its key after its account was removed.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCreateRequest, AgentQueueItemCreateResponse, QueuedSkillPick,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::CurrentProviderAccount;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_session::queue_store::RecordedQueueItemState;
use tokio::time::timeout;

use super::{DriverCalls, WAIT, fixture, queue_over, recording_driver};
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
    let run_id = fixture.insert_run("queued");
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
