//! An answer to a card no live call holds: kept, not refused, and handed once to the call made
//! again.

use serde_json::json;
use sidekicks_contracts::approval::{ApprovalRequestId, ApprovalState};
use sidekicks_provider::port::permission_ask::ProviderPermissionAsk;

use super::{AsksFixture, approval, command, device, plain_allow};
use crate::service::test_fixture::SETTLE_WAIT;

impl AsksFixture {
    /// The call of `npm publish` on `Bash` under `request_id` and tool call `tool_call_id`, its
    /// input the same each time.
    fn publish(&self, request_id: &str, tool_call_id: &str) -> ProviderPermissionAsk {
        ProviderPermissionAsk {
            input: json!({"command": "npm publish"}),
            tool_call_id: Some(tool_call_id.to_owned()),
            ..self.check.ask(request_id, command("npm publish"))
        }
    }

    /// The cards whose answer is kept.
    fn orphaned_cards(&self) -> Vec<String> {
        self.read_texts("SELECT approval_request_id FROM approval_orphaned_answers")
    }

    /// The cards whose orphaned answer the session's continue still owes.
    async fn owed_cards(&self) -> Vec<String> {
        let approvals = &self.check.approvals;
        approvals
            .service
            .orphaned_answers()
            .owed_continues(approvals.session_id)
            .await
            .expect("the owed continues read")
            .into_iter()
            .map(|owed| owed.approval_request_id.text().as_str().to_owned())
            .collect()
    }

    /// Waits until the fixture's run reads `state`.
    async fn wait_for_run_state(&self, state: &str) {
        let approvals = &self.check.approvals;
        tokio::time::timeout(SETTLE_WAIT, async {
            while approvals.run_state(approvals.run_id) != state {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the run moves");
    }
}

// An answer to a pending card whose ask the restarted intake does not hold is recorded and kept,
// not refused, and its run reads `running` once the answer returns; the call made again under a
// new tool call id with the same input takes the orphaned answer at once with no card, and a third
// such call raises its own card. A continue's claim leaves the call hand open, and once given
// back the continue owes the answer no longer, the call made again having taken it. Killed by
// keeping the withdraw-and-refuse branch, by a call hand whose claim is not checked (the third
// call is answered too), by a reconcile left spawned (the run still reads `waitingForApproval`
// when the answer returns), by a continue's claim that also takes the call hand (the call made
// again raises a card), and by the continue still owing an answer the call made again took.
#[tokio::test]
async fn an_answer_no_live_request_holds_is_orphaned_and_answers_the_call_made_again_once() {
    let fixture = AsksFixture::moving_its_run().await;
    let approvals = &fixture.check.approvals;
    fixture
        .asks
        .take_ask(fixture.publish("ask-1", "a"))
        .await
        .expect("the ask raises its card");
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    fixture.wait_for_run_state("waitingForApproval").await;

    let restarted = fixture.restarted_intake();
    let resolved = restarted
        .resolve(&approval(&card), device())
        .await
        .expect("the answer is kept");
    assert_eq!(resolved.response.state, ApprovalState::Approved);
    assert_eq!(
        resolved.orphaned,
        Some((approvals.session_id, approvals.run_id))
    );
    assert_eq!(fixture.orphaned_cards(), std::slice::from_ref(&card));
    assert_eq!(approvals.run_state(approvals.run_id), "running");
    assert_eq!(fixture.handed(), []);
    assert_eq!(fixture.owed_cards().await, std::slice::from_ref(&card));
    let orphaned_answers = approvals.service.orphaned_answers();
    let card_id = ApprovalRequestId::new(&card).expect("a card's id");
    assert!(
        orphaned_answers
            .claim_continue(card_id)
            .await
            .expect("the continue's claim is written")
    );

    restarted
        .take_ask(fixture.publish("ask-2", "b"))
        .await
        .expect("the call made again is answered");
    assert_eq!(fixture.pending_cards(), Vec::<String>::new());
    assert_eq!(fixture.handed(), [plain_allow()]);
    assert_eq!(fixture.handed_under(), ["ask-2"]);
    orphaned_answers
        .release_continue(card_id)
        .await
        .expect("the continue's claim is given back");
    assert_eq!(fixture.owed_cards().await, Vec::<String>::new());

    restarted
        .take_ask(fixture.publish("ask-3", "c"))
        .await
        .expect("the third call raises its card");
    assert_eq!(fixture.pending_cards().len(), 1);
    assert_eq!(fixture.handed(), [plain_allow()]);
}

// An answer handed to the live call that holds its card writes no orphaned row, so a later call
// with the same input raises a card of its own. Killed by keeping every answer, which hands the
// later call the first one's answer.
#[tokio::test]
async fn a_live_answer_writes_no_orphaned_row() {
    let fixture = AsksFixture::new().await;
    fixture
        .asks
        .take_ask(fixture.publish("ask-1", "a"))
        .await
        .expect("the ask raises its card");
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    let resolved = fixture
        .asks
        .resolve(&approval(&card), device())
        .await
        .expect("the answer is handed");
    assert_eq!(resolved.orphaned, None);
    assert_eq!(fixture.orphaned_cards(), Vec::<String>::new());
    assert_eq!(fixture.handed(), [plain_allow()]);

    fixture
        .restarted_intake()
        .take_ask(fixture.publish("ask-2", "b"))
        .await
        .expect("the later call raises its card");
    assert_eq!(fixture.pending_cards().len(), 1);
    assert_eq!(fixture.handed(), [plain_allow()]);
}
