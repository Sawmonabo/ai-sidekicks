use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::port_registration::PortRegistration;

use super::ClaudeConversationCuts;
use crate::driver::claude::session::scripted::channel::ScriptedAnswer;
use crate::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::driver::rewind::RewindConversationResult;

// The person's message every test cuts back to.
const TARGET_MESSAGE_ID: &str = "target-message";

// The cuts over the scripted session's own routes, prompts, dialogs and streams.
fn cuts_of(session: &ScriptedSession) -> Arc<ClaudeConversationCuts> {
    Arc::new(ClaudeConversationCuts {
        routes: Arc::clone(&session.start.routes),
        prompts: Arc::clone(&session.start.prompts),
        dialogs: Arc::clone(&session.parts.run_controls.dialogs),
        streams: Arc::clone(&session.start.streams),
    })
}

// Scripts the answers of the session's next cuts, in order.
fn script_cut_answers(session: &ScriptedSession, answers: &[Value]) {
    for answer in answers {
        session
            .channel
            .answer("rewind_conversation", ScriptedAnswer::Reply(answer.clone()));
    }
}

// The cuts written so far, in order.
fn cut_requests(session: &ScriptedSession) -> Vec<Value> {
    session
        .channel
        .control_requests()
        .into_iter()
        .filter(|request| request["subtype"] == "rewind_conversation")
        .collect()
}

// Runs the person's undo back to the target off the test's task, with no approvals registered.
fn spawn_rewind(session: &ScriptedSession) -> tokio::task::JoinHandle<RewindConversationResult> {
    let cuts = cuts_of(session);
    let live = Arc::clone(&session.live);
    tokio::spawn(async move {
        cuts.rewind(
            &live,
            TARGET_MESSAGE_ID,
            &PortRegistration::new("reviewer denials"),
        )
        .await
        .expect("the cut is answered")
    })
}

// Killed by sending no second cut, by sending it before the turn settles, and by sending it with
// another target.
#[tokio::test(start_paused = true)]
async fn a_refusal_claude_code_marks_sendable_is_sent_once_more_after_the_turn_settles() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    script_cut_answers(
        &session,
        &[
            json!({"rewound": false, "reason": "turn_running"}),
            json!({"rewound": true}),
        ],
    );

    let rewind = spawn_rewind(&session);
    settle().await;
    assert_eq!(cut_requests(&session).len(), 1);

    session.start.routes.settle_turn_holds(session.session_id);
    let result = rewind.await.expect("the undo's task ends");

    let targets: Vec<Value> = cut_requests(&session)
        .into_iter()
        .map(|request| request["target_message_uuid"].clone())
        .collect();
    assert_eq!(
        targets,
        [json!(TARGET_MESSAGE_ID), json!(TARGET_MESSAGE_ID)]
    );
    assert_eq!(
        result,
        RewindConversationResult::Applied {
            binding_id: None,
            cut_message_text: None,
        }
    );
}

// Killed by sending again a refusal Claude Code marks final, by a third send, and by sending again
// a word outside the set.
#[rstest]
#[case::final_code(&[json!({"rewound": false, "reason": "stale_target"})], 1, "stale_target")]
#[case::second_refusal(
    &[
        json!({"rewound": false, "reason": "turn_running"}),
        json!({"rewound": false, "reason": "turn_running"}),
    ],
    2,
    "turn_running"
)]
#[case::usage_limited_target_missing(
    &[json!({"rewound": false, "reason": "usage_limited", "target_not_found": true})],
    1,
    "usage_limited"
)]
#[case::target_missing(&[json!({"rewound": false, "reason": "target_not_found"})], 1, "target_not_found")]
#[case::unknown_word(&[json!({"rewound": false, "reason": "cut_too_soon"})], 1, "cut_too_soon")]
#[tokio::test(start_paused = true)]
async fn a_final_refusal_or_a_second_one_is_never_sent_again(
    #[case] answers: &[Value],
    #[case] sends: usize,
    #[case] reason: &str,
) {
    let session = ScriptedSession::new().await;
    script_cut_answers(&session, answers);
    // A third send would be answered as applied.
    script_cut_answers(&session, &[json!({"rewound": true})]);

    let result = spawn_rewind(&session).await.expect("the undo's task ends");

    assert_eq!(cut_requests(&session).len(), sends);
    assert_eq!(
        result,
        RewindConversationResult::Degraded {
            fallback_action: Some(format!("rewind-refused: {reason}")),
        }
    );
}
