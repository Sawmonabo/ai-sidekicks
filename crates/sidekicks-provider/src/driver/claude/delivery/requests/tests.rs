use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::ClaudeRequestSession;
use crate::driver::claude::run::controls::claude_dialog_session;
use crate::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::driver::contract::params_and_results::ProviderRequestAnswer;
use crate::port::question::QuestionPort;
use crate::port::question::test_card::QuestionCard;

fn tool_ask(tool_use_id: &str) -> Value {
    json!({
        "subtype": "can_use_tool",
        "tool_name": "Bash",
        "input": {"command": "ls"},
        "tool_use_id": tool_use_id,
    })
}

fn text(text: &str) -> NonEmptyText {
    NonEmptyText::new(text.to_owned()).expect("a test answer is text")
}

// Killed by handing on an ask Claude Code withdrew while its admission was in flight, and by
// keeping a withdrawal of an ask already handed on from the approval pipeline.
#[tokio::test(start_paused = true)]
async fn a_withdrawal_reaches_the_approval_pipeline_only_once_the_ask_did() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let tool_server_calls = ClaudeToolServerCalls::default();
    let request_session = ClaudeRequestSession {
        stream: &session.stream,
        dialog: claude_dialog_session(&session.live, "opus"),
        channel: Arc::clone(&session.live.channel),
        level: None,
        tool_server_calls: &tool_server_calls,
        tool_servers: None,
    };
    let admission = session.engine.hold_next_ask();

    let asked = session.requests.take_request(
        &request_session,
        session.read_request("early", &tool_ask("call-1")),
    );
    let withdrawn = async {
        tokio::task::yield_now().await;
        session
            .requests
            .take_request(&request_session, session.read_cancel("early"))
            .await;
        drop(admission);
    };
    tokio::join!(asked, withdrawn);
    settle().await;
    assert_eq!(session.ports.calls(), []);

    session.request("late", &tool_ask("call-2"));
    settle().await;
    session.cancel("late");
    settle().await;
    assert_eq!(
        session.ports.calls(),
        [
            PortCall::Ask("late".to_owned()),
            PortCall::AskWithdrawn("late".to_owned())
        ]
    );
}

// Killed by keying an answer by anything but its question's own words, and by sending one pick of
// several.
#[tokio::test(start_paused = true)]
async fn a_questions_answers_are_keyed_by_its_words_with_several_picks_joined() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.request(
        "question",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "call-1",
            "input": {
                "questions": [
                    {
                        "question": "Which colors?",
                        "header": "Colors",
                        "multiSelect": true,
                        "options": [{"label": "Red"}, {"label": "Blue"}, {"label": "Green"}],
                    },
                    {"question": "Which name?", "header": "Name", "options": []},
                ],
            },
        }),
    );
    settle().await;

    session
        .requests
        .respond(
            &session.live,
            "question",
            ProviderRequestAnswer::Question {
                answers: vec![
                    QuestionAnswer::Picked {
                        labels: BoundedVec::new(vec![text("Red"), text("Blue")])
                            .expect("two picks fit"),
                    },
                    QuestionAnswer::Typed { text: text("Ada") },
                ],
            },
        )
        .await
        .expect("the answer is written");

    let answers: Vec<_> = session
        .channel
        .writes()
        .into_iter()
        .filter_map(|write| match write {
            ScriptedWrite::Answer { answer, .. } => Some(answer),
            ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => None,
        })
        .collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(
        answers[0]["updatedInput"]["answers"],
        json!({"Which colors?": "Red, Blue", "Which name?": "Ada"})
    );
}

// Claude Code withdraws a question while its record's write is still queued: the withdrawal finds
// nothing on the card, and the question's own take withdraws it once the record lands. Killed by
// leaving the let-go out of a pending request's close.
#[tokio::test(start_paused = true)]
async fn a_question_withdrawn_before_its_record_landed_is_withdrawn_once_it_lands() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let card = Arc::new(QuestionCard::default());
    card.hold_records();
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(
        session
            .requests
            .dependencies
            .questions
            .register(port)
            .is_ok()
    );
    session.request(
        "question",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "call-1",
            "input": {"questions": [{"question": "Which name?", "header": "Name", "options": []}]},
        }),
    );
    card.wait_until_records_held(1).await;

    session.cancel("question");
    card.wait_until_withdrawals(1).await;
    assert!(card.taken().is_empty(), "the withdrawal finds nothing");
    card.land_records();
    card.wait_until_withdrawals(2).await;

    assert_eq!(card.withdrawals(), ["question", "question"]);
    assert_eq!(card.taken().len(), 1, "the record landed");
    card.wait_until_none_open().await;
}

// A question recorded waiting for its run whose take fails is withdrawn from the card by its
// request id, and Claude Code's request is answered denied, so the agent never waits on a request
// no card holds. Killed by leaving out the take's withdrawal or the driver's refusal.
#[tokio::test(start_paused = true)]
async fn a_question_whose_take_failed_is_withdrawn_and_refused() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let card = Arc::new(QuestionCard::default());
    card.fail_waiting_opens();
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(
        session
            .requests
            .dependencies
            .questions
            .register(port)
            .is_ok()
    );
    session.request(
        "question",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "call-1",
            "input": {"questions": [{"question": "Which name?", "header": "Name", "options": []}]},
        }),
    );
    card.wait_until_withdrawals(1).await;
    settle().await;

    assert_eq!(card.withdrawals(), ["question"]);
    assert!(card.taken().is_empty(), "it never opened");
    card.wait_until_none_waiting().await;
    let answers: Vec<_> = session
        .channel
        .writes()
        .into_iter()
        .filter_map(|write| match write {
            ScriptedWrite::Answer { request_id, answer } => Some((request_id, answer)),
            ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => None,
        })
        .collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0].0, "question");
    assert_eq!(answers[0].1["behavior"], "deny");
}

// A question Claude Code let go of while its record's write was queued, whose write then fails, is
// withdrawn by its take but never answered, since its id may already name a new request. Killed by
// leaving the let-go check out of the driver's refusal.
#[tokio::test(start_paused = true)]
async fn a_question_let_go_before_its_record_failed_is_not_refused() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let card = Arc::new(QuestionCard::default());
    card.hold_records();
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(
        session
            .requests
            .dependencies
            .questions
            .register(port)
            .is_ok()
    );
    session.request(
        "question",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "call-1",
            "input": {"questions": [{"question": "Which name?", "header": "Name", "options": []}]},
        }),
    );
    card.wait_until_records_held(1).await;

    session.cancel("question");
    card.wait_until_withdrawals(1).await;
    card.fail_records();
    card.land_records();
    card.wait_until_withdrawals(2).await;
    settle().await;

    assert_eq!(card.withdrawals(), ["question", "question"]);
    assert!(card.taken().is_empty(), "the record never landed");
    let has_answer = session.channel.writes().into_iter().any(|write| {
        matches!(write, ScriptedWrite::Answer { request_id, .. } if request_id == "question")
    });
    assert!(!has_answer, "a request let go of is not answered");
}
