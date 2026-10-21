use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::ClaudeRequestSession;
use crate::provider::driver::claude::run::controls::claude_dialog_session;
use crate::provider::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::provider::driver::claude::session::scripted::daemon_services::PortCall;
use crate::provider::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::provider::driver::claude::session::tool_server_calls::ClaudeToolServerCalls;
use crate::provider::driver::contract::ProviderRequestAnswer;

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
    let session = ScriptedSession::new();
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
    let session = ScriptedSession::new();
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
