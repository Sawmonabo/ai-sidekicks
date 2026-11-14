use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::question::{QuestionAnswer, QuestionDefault};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::ClaudeRequestSession;
use super::answers::{ClaudeQuestionRoute, compose_claude_question_refusal};
use crate::driver::claude::delivery::stream::tests::session_with_open_window;
use crate::driver::claude::run::controls::claude_dialog_session;
use crate::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::{ScriptedSession, binding_id, settle};
use crate::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::driver::contract::params_and_results::ProviderRequestAnswer;
use crate::port::command_capture::{CaptureCall, CommandWindowEnd, next_call, no_call};
use crate::port::permission_ask::ProviderPermissionAnswer;
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

// The extended form's members reach the record, and the answer goes back as Claude Code reads it.
// Killed by keying an answer by anything but its question's own words, by sending one pick of
// several, by sending `response`, by a preview sent for an option not picked, and by a key for a
// skipped question.
#[tokio::test(start_paused = true)]
async fn a_questions_record_carries_its_extended_form_and_its_answer_goes_back_keyed_by_its_words()
{
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let card = Arc::new(QuestionCard::default());
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
            "input": {
                "title": "Deck setup",
                "questions": [
                    {
                        "question": "Which colors?",
                        "header": "Colors",
                        "multiSelect": true,
                        "options": [{"label": "Red"}, {"label": "Blue"}, {"label": "Green"}],
                    },
                    {
                        "question": "Which layout?",
                        "header": "Layout",
                        "options": [
                            {"label": "Grid", "preview": "grid mock"},
                            {"label": "List", "preview": "list mock"},
                        ],
                    },
                    {
                        "question": "Which theme?",
                        "header": "Theme",
                        "options": [{"label": "Dark", "preview": "dark mock"}, {"label": "Light"}],
                    },
                    {
                        "question": "How many slides?",
                        "header": "Slides",
                        "kind": "number",
                        "min": 1,
                        "max": 20,
                        "step": 1,
                        "defaultValue": 5,
                        "unit": "slides",
                    },
                    {
                        "question": "Which name?",
                        "header": "Name",
                        "kind": "text",
                        "description": "Shown on the cover",
                        "placeholder": "Ada",
                    },
                ],
            },
        }),
    );
    settle().await;

    let taken = card.taken();
    assert_eq!(taken.len(), 1);
    let questions = &taken[0].questions;
    assert!(
        questions
            .iter()
            .all(|question| question.heading == Some(text("Deck setup")))
    );
    assert_eq!(
        questions[1].options[1].preview.as_deref(),
        Some("list mock")
    );
    let number = &questions[3];
    assert_eq!(
        (number.minimum, number.maximum, number.step),
        (Number::new(1.0), Number::new(20.0), Number::new(1.0))
    );
    assert_eq!(
        number.default,
        Number::new(5.0).map(QuestionDefault::Number)
    );
    assert_eq!(number.unit, Some(text("slides")));
    assert_eq!(questions[4].placeholder, Some(text("Ada")));
    assert_eq!(questions[4].description, Some(text("Shown on the cover")));

    let picked = |labels: &[&str]| QuestionAnswer::Picked {
        labels: BoundedVec::new(labels.iter().map(|label| text(label)).collect())
            .expect("the picks fit"),
    };
    session
        .requests
        .respond(
            &session.live,
            "question",
            ProviderRequestAnswer::Question {
                answers: vec![
                    picked(&["Red", "Blue"]),
                    picked(&["List"]),
                    picked(&["Light"]),
                    QuestionAnswer::Typed { text: text("8") },
                    QuestionAnswer::Skipped {},
                ],
            },
        )
        .await
        .expect("the answer is written");

    let answers = session.channel.answers();
    assert_eq!(answers.len(), 1);
    let updated_input = &answers[0].1["updatedInput"];
    assert_eq!(
        updated_input["answers"],
        json!({
            "Which colors?": "Red, Blue",
            "Which layout?": "List",
            "Which theme?": "Light",
            "How many slides?": "8",
        })
    );
    assert_eq!(
        updated_input["annotations"],
        json!({"Which layout?": {"preview": "list mock"}})
    );
    assert!(updated_input.get("response").is_none());
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
    let answers = session.channel.answers();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0].0, "question");
    assert_eq!(answers[0].1["behavior"], "deny");
}

// A question with no questions card registered is answered refused at once, so the agent never
// waits on a request nothing can show. Killed by leaving the request held.
#[tokio::test(start_paused = true)]
async fn a_question_with_no_card_is_refused_at_once() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.request(
        "question",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "call-1",
            "input": {"questions": [{"question": "Which name?", "header": "Name", "options": []}]},
        }),
    );
    settle().await;

    let answers = session.channel.answers();
    assert_eq!(
        answers,
        [(
            "question".to_owned(),
            compose_claude_question_refusal(ClaudeQuestionRoute::Ask)
        )]
    );
    assert_eq!(session.requests.open_request_count(session.session_id), 0);
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
    let has_answer = session.channel.written_answer("question").is_some();
    assert!(!has_answer, "a request let go of is not answered");
}

// A helper's ask, asked while the lead holds its turn.
fn helper_ask(agent_id: &str) -> Value {
    json!({
        "subtype": "can_use_tool",
        "tool_name": "Bash",
        "input": {"command": "ls"},
        "tool_use_id": "call-1",
        "agent_id": agent_id,
    })
}

// A bound helper's ask waits for its card under the helper's own run while the lead holds its
// turn. Killed by attributing every ask to the lead's run.
#[tokio::test(start_paused = true)]
async fn a_helpers_ask_waits_under_its_own_run() {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    session.bind_helper(lead, "agent-1");

    session.request("ask", &helper_ask("agent-1"));
    settle().await;

    assert_eq!(session.ports.calls(), [PortCall::Ask("ask".to_owned())]);
    let asks: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "permissionAsk")
        .map(|delivery| delivery.binding_id)
        .collect();
    assert_eq!(asks, [Some(binding_id("helper"))]);
}

// An ask from a helper no route holds stays pending at Claude Code: no answer, no card, no
// delivery. Killed by an unknown helper's ask falling back to the lead's run.
#[tokio::test(start_paused = true)]
async fn an_unknown_helpers_ask_stays_pending_at_the_provider() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");

    session.request("ask", &helper_ask("agent-unknown"));
    settle().await;

    assert_eq!(session.ports.calls(), []);
    assert!(
        session
            .engine
            .deliveries()
            .iter()
            .all(|delivery| delivery.kind != "permissionAsk")
    );
    let is_answered = session.channel.writes().into_iter().any(
        |write| matches!(write, ScriptedWrite::Answer { request_id, .. } if request_id == "ask"),
    );
    assert!(!is_answered, "the ask stays pending at the provider");
}

/// How a case settles the call whose window is open.
#[derive(Clone, Copy, Debug)]
enum AskSettlement {
    Refused,
    Allowed,
    DeniedInAutoMode,
}

// No frame is fed, so each close is the path under test's own. Killed by the refusal taking an
// after-capture, by the allow closing the window, and by the auto mode denial without its close.
#[rstest]
#[case::refused(AskSettlement::Refused, Some(CommandWindowEnd::Unrun))]
#[case::allowed(AskSettlement::Allowed, None)]
#[case::denied_in_auto_mode(AskSettlement::DeniedInAutoMode, Some(CommandWindowEnd::Unrun))]
#[tokio::test(start_paused = true)]
async fn a_call_that_never_ran_closes_its_window_unrun(
    #[case] settlement: AskSettlement,
    #[case] expected: Option<CommandWindowEnd>,
) {
    let (session, mut called) = session_with_open_window(None).await;
    let answer = match settlement {
        AskSettlement::DeniedInAutoMode => {
            let tool_server_calls = ClaudeToolServerCalls::default();
            let request_session = ClaudeRequestSession {
                stream: &session.stream,
                dialog: claude_dialog_session(&session.live, "opus"),
                channel: Arc::clone(&session.live.channel),
                level: None,
                tool_server_calls: &tool_server_calls,
                tool_servers: None,
            };
            let denied = json!({
                "subtype": "hook_callback",
                "callback_id": "sidekicks-permission-denied",
                "input": {"hook_event_name": "PermissionDenied", "tool_use_id": "call-2"},
            });
            session
                .requests
                .take_request(&request_session, session.read_request("denied", &denied))
                .await;
            assert_eq!(session.channel.answer_to("denied").await, json!({}));
            None
        }
        AskSettlement::Refused | AskSettlement::Allowed => {
            session.request("ask", &tool_ask("call-2"));
            settle().await;
            let answer = if matches!(settlement, AskSettlement::Refused) {
                ProviderPermissionAnswer::Refuse {
                    reason: Some("not now".to_owned()),
                    made_rule: None,
                }
            } else {
                ProviderPermissionAnswer::Allow {
                    correction: None,
                    made_rule: None,
                    answered_by_rule: None,
                }
            };
            session
                .requests
                .respond(
                    &session.live,
                    "ask",
                    ProviderRequestAnswer::Permission(answer),
                )
                .await
                .expect("the answer is written");
            Some(session.channel.answer_to("ask").await)
        }
    };

    if let Some(answer) = answer {
        let behavior = if expected.is_some() { "deny" } else { "allow" };
        assert_eq!(answer["behavior"], behavior);
    }
    if let Some(end) = expected {
        assert_eq!(next_call(&mut called).await, CaptureCall::Close(1, end));
    }
    no_call(&mut called, "a window closed by an allow, or twice").await;
}
