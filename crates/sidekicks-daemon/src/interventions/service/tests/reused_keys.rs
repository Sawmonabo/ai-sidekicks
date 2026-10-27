//! A reused key: the saved row's answer or a conflict for an interrupt, and for a `Send now` the
//! first's answer once its message left the queue, the request run again while it waits.

use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::intervention::AgentRunInterveneResponse;

use super::{applied, device, harness, harness_reading_priority, interrupt, retry, send_now};
use crate::interventions::service::errors::InterventionError;
use crate::run::engine::tests::stored_run_state;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::MockProviderDriver;

// A reused key answers what the first request saved without a second dispatch or a hold of the
// queue, and refuses a request that asks for something else, also with no hold. Killed by
// dropping the payload comparison or the saved answer, or by taking the hold before the key's
// read.
#[tokio::test]
async fn a_reused_key_answers_the_saved_result_or_refuses_another_request() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(|_| async { Ok(applied()) }.boxed());
    let harness = harness(driver).await;

    let first = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect("the first request applies");
    let again = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect("the same request answers again");
    let conflict = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "another reason"), device())
        .await
        .expect_err("another request under the key is refused");

    let AgentRunInterveneResponse::Applied {
        intervention_id, ..
    } = first
    else {
        panic!("the first request applies, got {first:?}");
    };
    let AgentRunInterveneResponse::Applied {
        intervention_id: saved,
        ..
    } = again
    else {
        panic!("the same request answers the saved result, got {again:?}");
    };
    assert_eq!(saved, intervention_id);
    let InterventionError::Refused(DomainError { code, detail, .. }) = conflict else {
        panic!("a conflict is a refusal, got {conflict:?}");
    };
    assert_eq!(code, RefusalCode::AgentInterventionIdempotencyConflict);
    let detail = detail.expect("the refusal names the run and the saved intervention");
    assert_eq!(detail["targetRunId"], harness.run_id.text().as_str());
    assert_eq!(detail["interventionId"], intervention_id.text().as_str());
    assert_eq!(harness.stored_rows().len(), 1);
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 1);
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "interrupted"
    );
}

// `Send now` on a provider that reads a priority message hands the message with no interrupt row.
// The same request again goes to the queue while the message waits with its mark, and once the
// message has left the queue, taken or never delivered, or a reorder moved it off first place and
// cleared its mark, answers the first's `applied` without the queue; the key reused for an
// interrupt without the message first, or for a retry, is refused as a conflict. Killed by dropping
// the sent-now read before the saved row's, its comparison of the message first, or its check of a
// retry, by answering from the key while the mark is in force, or by running again a `Send now`
// whose message left the queue another way or lost its mark.
#[rstest]
#[case::taken("UPDATE queue_items SET state = 'admitted' WHERE id = ?1")]
#[case::never_delivered(
    "UPDATE queue_items SET state = 'notDelivered', not_delivered_reason = 'failed' WHERE id = ?1"
)]
#[case::reordered("UPDATE queue_items SET send_now_id = NULL WHERE id = ?1")]
#[tokio::test]
async fn a_reused_send_now_key_answers_applied_or_refuses_another_request(#[case] moved_on: &str) {
    let harness = harness_reading_priority(MockProviderDriver::new(), true).await;
    let item_id = harness.queue_message().await;

    let first = harness
        .service
        .apply_intervention(send_now(harness.run_id, item_id), device())
        .await
        .expect("the message is sent now");
    let again = harness
        .service
        .apply_intervention(send_now(harness.run_id, item_id), device())
        .await
        .expect("the same request answers again");
    let asked_while_waiting = harness.sent_now.load(Ordering::SeqCst);
    harness
        .database
        .reader()
        .execute(moved_on, [item_id.text().as_str()])
        .expect("the test moves the message on");
    let after_leaving = harness
        .service
        .apply_intervention(send_now(harness.run_id, item_id), device())
        .await
        .expect("the same request answers once the message left");
    let conflict = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect_err("an interrupt under the spent key is refused");
    let retry_conflict = harness
        .service
        .apply_intervention(retry(harness.run_id, 1), device())
        .await
        .expect_err("a retry under the spent key is refused");

    let AgentRunInterveneResponse::Applied {
        intervention_id, ..
    } = first
    else {
        panic!("the message is sent now, got {first:?}");
    };
    for answer in [again, after_leaving] {
        let AgentRunInterveneResponse::Applied {
            intervention_id: saved,
            ..
        } = answer
        else {
            panic!("the same request answers the first's result, got {answer:?}");
        };
        assert_eq!(saved, intervention_id);
    }
    for refused in [conflict, retry_conflict] {
        let InterventionError::Refused(DomainError { code, .. }) = refused else {
            panic!("a conflict is a refusal, got {refused:?}");
        };
        assert_eq!(code, RefusalCode::AgentInterventionIdempotencyConflict);
    }
    assert_eq!(
        (asked_while_waiting, harness.sent_now.load(Ordering::SeqCst)),
        (2, 2)
    );
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
    assert_eq!(harness.stored_rows(), []);
}
