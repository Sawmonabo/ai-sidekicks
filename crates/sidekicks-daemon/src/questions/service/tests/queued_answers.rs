//! The queued answers of a question its agent does not wait for.

use serde_json::json;
use sidekicks_contracts::question::{QuestionAskedState, QuestionId};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{Fixture, choice_page};
use crate::provider::port::question::{ProviderQuestionWithdrawal, WaitingQuestionOpening};
use crate::questions::service::HeldRequestAnswerer;

/// The questions [`write_queued_answers`] settled, and the unwaited question's state after its
/// first queued answer was sent and after that send was withdrawn.
pub(crate) struct QueuedAnswers {
    unwaited: QuestionId,
    withdrawn: QuestionId,
    withdrawn_waiting: QuestionId,
    opened: QuestionId,
    after_send: String,
    after_withdrawal: String,
}

/// Writes, through `fixture`'s service and log, a held question answered, one withdrawn, one
/// withdrawn while it waited for its run, one opened from that wait and answered, and a question
/// its agent does not wait for, answered by the first of two queued answers its agent takes.
pub(crate) async fn write_queued_answers(fixture: &Fixture) -> QueuedAnswers {
    let record_waiting = |request_id: &'static str| {
        fixture.questions.record_question(
            fixture.question(request_id, json!([choice_page()]), true),
            HeldRequestAnswerer::Driver,
            QuestionAskedState::WaitingForRun,
        )
    };
    let withdrawn_waiting = record_waiting("request-4")
        .await
        .expect("the question is recorded waiting for its run");
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-4".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let opened = record_waiting("request-5")
        .await
        .expect("the question is recorded waiting for its run");
    assert_eq!(
        fixture
            .questions
            .open_waiting_question(fixture.session_id, "request-5")
            .await
            .expect("the run reads running"),
        WaitingQuestionOpening::Opened
    );
    fixture
        .answer(opened, json!([{ "kind": "picked", "labels": ["Beta"] }]))
        .await
        .expect("the opened question is answered");
    let withdrawn = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-1".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let held = fixture.ask("request-2", json!([choice_page()]), true).await;
    fixture
        .answer(held, json!([{ "kind": "picked", "labels": ["Alpha"] }]))
        .await
        .expect("the held question is answered");
    let unwaited = fixture
        .ask("request-3", json!([choice_page()]), false)
        .await;
    let [withdrawn_item, unrelated_item, first_item, second_item] =
        [(); 4].map(|()| mint_uuid_v7().to_string());
    let send = |queue_item_id: String| {
        json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "runId": fixture.run_id,
            "actor": "device-1",
            "deviceId": "device-1",
            "message": "Which one?\nAlpha",
            "answersQuestionId": unwaited,
        })
    };
    let queue_event = |state: &str, queue_item_id: String| {
        let mut payload = json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "state": state,
        });
        if state == "admitted" {
            payload["runId"] = json!(fixture.run_id);
        }
        payload
    };

    fixture
        .append("user.message.sent", send(withdrawn_item.clone()))
        .await;
    let after_send = fixture.state(unwaited);
    fixture
        .append(
            "agent.queueItem.canceled",
            queue_event("canceled", withdrawn_item),
        )
        .await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", unrelated_item),
        )
        .await;
    let after_withdrawal = fixture.state(unwaited);
    fixture
        .append("user.message.sent", send(first_item.clone()))
        .await;
    fixture.append("user.message.sent", send(second_item)).await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", first_item),
        )
        .await;

    QueuedAnswers {
        unwaited,
        withdrawn,
        withdrawn_waiting,
        opened,
        after_send,
        after_withdrawal,
    }
}

// A question its agent does not wait for stays open while a send naming it is queued, stays open
// when that item is withdrawn, and is answered when the agent takes a queued answer; of two
// devices' answers the first taken wins and unpairs the other, and an item that answers nothing
// answers nothing. Killed by answering at send time and by answering on another item's admission.
#[tokio::test]
async fn queued_answers_settle_a_question_its_agent_does_not_wait_for() {
    let fixture = Fixture::new().await;

    let written = write_queued_answers(&fixture).await;

    assert_eq!(written.after_send, "open");
    assert_eq!(written.after_withdrawal, "open");
    assert_eq!(fixture.state(written.unwaited), "answered");
    assert_eq!(fixture.state(written.withdrawn), "canceled");
    assert_eq!(fixture.state(written.withdrawn_waiting), "canceled");
    assert_eq!(fixture.state(written.opened), "answered");
    let paired_items: i64 = fixture
        .database
        .reader()
        .query_row("SELECT COUNT(*) FROM question_answer_items", [], |row| {
            row.get(0)
        })
        .expect("the answer items count");
    assert_eq!(paired_items, 0, "the first taken answer unpairs the other");
}
