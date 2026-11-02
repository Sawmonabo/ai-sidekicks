//! A tool server's question: its answer kept for the server's next ask and settled once that ask
//! takes it.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::question::{QuestionResolveRequest, QuestionResolveState};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_provider::port::question::{
    QuestionPort, ToolServerAnswerDelivery, mint_tool_server_request_id,
};

use super::RecordingTaskAnswer;
use crate::questions::service::HeldRequestAnswerer;
use crate::questions::service::test_fixture::{Fixture, HandedAnswers, choice_page};

// An answer the tool server keeps leaves the question open, its run waiting and no turn written;
// a later answer replaces the kept one, and the settle writes the kept turn, its device and the
// run's move in one write. A settled question's answer reads `answered` and sends nothing. Killed
// by settling a kept answer at once, by forgetting the hold on a kept answer (the settle finds
// nothing), by keeping the first answer (`Alpha` or `device-1` in the turn), by a settle that
// moves no run or writes no turn, by replying `answered` for a kept answer, and by sending a
// settled question's answer again.
#[tokio::test]
async fn a_kept_answer_leaves_its_question_open_until_its_settle() {
    let fixture = Fixture::new().await;
    let sent = HandedAnswers::default();
    let request_id = mint_tool_server_request_id();
    let question_id = fixture
        .ask_answered_by(
            &request_id,
            json!([choice_page()]),
            true,
            HeldRequestAnswerer::ToolServerTask(Arc::new(RecordingTaskAnswer(
                Arc::clone(&sent),
                ToolServerAnswerDelivery::Kept,
            ))),
        )
        .await;

    let first = fixture
        .answer(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await;
    assert_eq!(
        first.expect("the answer is kept"),
        QuestionResolveState::Kept
    );
    assert_eq!(fixture.state(question_id), "open");
    assert_eq!(fixture.run_state(), "waitingForInput");
    assert!(fixture.payloads("user.message.sent").is_empty());

    let second = fixture
        .questions
        .resolve_question(
            QuestionResolveRequest {
                question_id,
                answers: BoundedVec::new(
                    serde_json::from_value(json!([{ "kind": "picked", "labels": ["Beta"] }]))
                        .expect("the test's answers read"),
                )
                .expect("the test answers once"),
            },
            DeviceId::new("device-2".to_owned()).expect("a device id"),
        )
        .await
        .expect("the second answer is kept");
    assert_eq!(second.state, QuestionResolveState::Kept);

    QuestionPort::settle_kept_answer(&fixture.questions, fixture.session_id, request_id)
        .await
        .expect("the kept answer is settled");
    assert_eq!(fixture.state(question_id), "answered");
    assert_eq!(fixture.run_state(), "running");
    let turns = fixture.payloads("user.message.sent");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["message"], "Beta");
    assert_eq!(turns[0]["deviceId"], "device-2");
    assert_eq!(turns[0]["answersQuestionId"], json!(question_id));

    let third = fixture
        .answer(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await;
    assert_eq!(
        third.expect("a settled question reads its state"),
        QuestionResolveState::Answered
    );
    assert_eq!(sent.lock().expect("never poisoned").len(), 2);
}
