//! A tool server's question: its answer kept for the server's next ask and settled once that ask
//! takes it, and the restart's withdrawal of the questions the tool-server client asked.

use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::question::{QuestionPrompt, QuestionResolveRequest, QuestionResolveState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_provider::port::question::{
    ProviderQuestion, QuestionPort, ToolServerAnswerDelivery, mint_tool_server_request_id,
};
use sidekicks_store::database::writer::test_file::test_session_id;

use super::RecordingTaskAnswer;
use crate::questions::service::test_fixture::{Fixture, HandedAnswers, choice_page};
use crate::questions::service::{HeldRequestAnswerer, QuestionRecording};
use crate::run::engine::test_fixture::insert_running_run;

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
    assert_eq!(fixture.payloads("user.message.sent"), Vec::<Value>::new());

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

// A restart's withdrawal cancels the session's questions under ids the client mints, holding no
// request: the open one in the write that moves its run back to `running`, the waiting one in a
// write of its own, each `withdrawn`. A version 4 UUID, an uppercase one, another `mcp:` shape, a
// driver's own id and another session's question are left waiting. Killed by a prefix match, by
// the version or the case unread, by a lookup through the held requests (nothing canceled), by
// the open one canceled without its run's move, by the waiting branch skipped, by the session
// filter dropped, and by a mint that writes another shape.
#[tokio::test]
async fn a_restarts_withdrawal_cancels_only_the_clients_questions_of_its_session() {
    let fixture = Fixture::new().await;
    let open = fixture
        .ask(&mint_tool_server_request_id(), json!([choice_page()]), true)
        .await;
    assert_eq!(fixture.run_state(), "waitingForInput");
    let record_waiting = |question: ProviderQuestion| {
        fixture.questions.record(
            question,
            HeldRequestAnswerer::Driver,
            QuestionRecording::WaitingForRun,
        )
    };
    let minted = mint_tool_server_request_id();
    let uppercase = format!(
        "mcp:{}",
        mint_tool_server_request_id()["mcp:".len()..].to_uppercase()
    );
    let mut waiting = Vec::new();
    for request_id in [
        minted.as_str(),
        "mcp:0f8fad5b-d9cb-469f-a165-70867728950e",
        uppercase.as_str(),
        "mcp:x:call-1:1",
        "toolu_01A09q90qw90lq917835lq9",
    ] {
        let (question_id, _state) =
            record_waiting(fixture.question(request_id, json!([choice_page()]), true))
                .await
                .expect("the question is recorded waiting for its run");
        waiting.push(question_id);
    }
    let other_session = test_session_id();
    let other_run = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&fixture.database, other_session, other_run);
    let (other_question, _state) = record_waiting(ProviderQuestion {
        session_id: other_session,
        run_id: other_run,
        request_id: mint_tool_server_request_id(),
        questions: serde_json::from_value::<Vec<QuestionPrompt>>(json!([choice_page()]))
            .expect("the test's pages read"),
        is_agent_waiting: true,
    })
    .await
    .expect("the other session's question is recorded waiting for its run");
    for question_id in waiting.iter().chain([&open, &other_question]) {
        fixture.questions.forget_held_request(question_id);
    }

    fixture
        .questions
        .withdraw_tool_server_questions(fixture.session_id)
        .await
        .expect("the client's questions are withdrawn");

    let withdrawn = [open, waiting[0]];
    for question_id in withdrawn {
        assert_eq!(fixture.state(question_id), "canceled");
    }
    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 2);
    for (payload, question_id) in canceled.iter().zip(withdrawn) {
        assert_eq!(payload["questionId"], json!(question_id));
        assert_eq!(payload["reason"], "withdrawn");
    }
    assert_eq!(fixture.run_state(), "running");
    for question_id in waiting[1..].iter().chain([&other_question]) {
        assert_eq!(fixture.state(*question_id), "waitingForRun");
    }
}
