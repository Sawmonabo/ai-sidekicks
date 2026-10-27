//! Bringing a session's process up: a failed start, the model check, a resume's place in its
//! conversation, and the handshake a resumed conversation reads.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;

use super::resume_params;
use crate::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel, ScriptedWrite};
use crate::claude::session::scripted::driver::{ScriptedDriver, create_params};
use crate::claude::session::scripted::{SCRIPTED_PROVIDER_SESSION_ID, hand_scripted_frame, settle};
use crate::claude::session::transport::declarations::{
    ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::contract::DriverError;
use crate::driver::error_causes::ProviderAxis;
use crate::driver::session_control::{CloseSessionParams, CreateSessionParams, DriverResumeResult};
use crate::driver::test_registry::new_session_id;

// Killed by a failed bring-up leaving its claim behind, which refuses the next create, and by a
// close that finds a bring-up in flight returning before it settles, which leaves its process
// running with no session to close it.
#[tokio::test(start_paused = true)]
async fn a_failed_bring_up_frees_its_claim_and_a_close_waits_for_one_in_flight() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    fixture.starts.script_failed_session("the spawn failed");
    assert!(
        fixture
            .driver
            .create_session(create_params(session_id))
            .await
            .is_err()
    );
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release = fixture.starts.hold_next_session_start();
    let driver = Arc::clone(&fixture.driver);
    let create =
        tokio::spawn(async move { driver.create_session(create_params(session_id)).await });
    fixture.starts.wait_for_starts(1).await;
    let driver = Arc::clone(&fixture.driver);
    let close = tokio::spawn(async move {
        driver
            .close_session(CloseSessionParams { session_id })
            .await
    });
    settle().await;
    assert!(!channel.writes().contains(&ScriptedWrite::Terminate));

    drop(release);
    create
        .await
        .expect("the create runs")
        .expect("the create succeeds");
    close
        .await
        .expect("the close runs")
        .expect("the close succeeds");

    assert!(channel.writes().contains(&ScriptedWrite::Terminate));
    assert!(fixture.driver.starts_process(session_id));
}

// Killed by matching the session's model to the build's catalog exactly, which switches a listed
// model; by sending no switch for an unlisted one; and by refusing a model Claude Code will not
// run as an internal failure instead of naming the session's lead.
#[rstest]
#[case::listed_under_its_window_spelling(
    "claude-opus-4-6-1m",
    "claude-opus-4-6[1m]",
    false,
    Some(0)
)]
#[case::larger_window_unlisted("claude-opus-4-6[1m]", "claude-opus-4-6", false, Some(1))]
#[case::unlisted_and_refused("claude-opus-4-6[1m]", "claude-opus-4-6", true, None)]
#[tokio::test(start_paused = true)]
async fn a_new_session_switches_to_an_unlisted_model_and_refuses_one_claude_code_rejects(
    #[case] model: &str,
    #[case] listed: &str,
    #[case] is_refused: bool,
    #[case] switches: Option<usize>,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    if is_refused {
        channel.answer("set_model", ScriptedAnswer::Refused);
    }
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: listed.to_owned(),
                resolved_model: None,
                display_name: None,
            }],
            ..ClaudeInitializeDeclaration::default()
        });
    fixture.starts.script_session(Arc::clone(&channel));
    let params = CreateSessionParams {
        model: ProviderToken::new(model.to_owned()).expect("the model fits"),
        ..create_params(new_session_id())
    };
    let agent_id = params.agent_id;

    let created = fixture.driver.create_session(params).await;

    let model_switches = channel
        .control_requests()
        .iter()
        .filter(|request| request["subtype"] == "set_model")
        .count();
    if let Some(count) = switches {
        assert!(created.is_ok(), "the session opens");
        assert_eq!(model_switches, count);
    } else {
        let Err(DriverError::ProviderAxisInvalid(invalid)) = created else {
            panic!("a model Claude Code refuses is refused for the session's lead");
        };
        assert_eq!(invalid.agent_id, agent_id);
        assert_eq!(invalid.axis, ProviderAxis::ModelId);
        assert_eq!(invalid.value, Value::from(model));
        assert!(channel.writes().contains(&ScriptedWrite::Terminate));
    }
}

// Killed by reading a conversation file that cannot be read as one with no turns, which resumes
// the session at the wrong place in it, and by failing a resume whose conversation has no file
// yet.
#[rstest]
#[case::no_file_yet(false)]
#[case::unreadable_file(true)]
#[tokio::test(start_paused = true)]
async fn a_resume_starts_at_its_conversations_turn_count_and_fails_on_an_unreadable_file(
    #[case] is_unreadable: bool,
) {
    let fixture = ScriptedDriver::new();
    if is_unreadable {
        // A folder where the conversation's file would be is found and cannot be read.
        let file = fixture
            .home
            .join(".claude/projects/work/conversation.jsonl");
        std::fs::create_dir_all(file).expect("the folder is made");
    }
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    let resumed = fixture
        .driver
        .resume_session(resume_params(new_session_id()))
        .await
        .expect("the resume answers");

    match resumed {
        DriverResumeResult::Resumed {
            session_position, ..
        } => {
            assert!(
                !is_unreadable,
                "an unreadable conversation fails the resume"
            );
            assert_eq!(session_position.get(), 0);
        }
        DriverResumeResult::Failed { .. } => {
            assert!(is_unreadable, "a conversation with no file yet resumes");
            assert!(fixture.starts.take_started().is_empty());
        }
    }
}

// Killed by keeping a process's handshake past its end: a resume that reuses the conversation's
// id would read the old process's declaration before its new process declares one.
#[tokio::test(start_paused = true)]
async fn a_resumed_conversation_reads_no_handshake_until_its_new_process_declares_one() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let parts = fixture.driver.composed_parts().expect("composed");
    let (routes, handshakes) = (&parts.run_start.routes, &parts.run_start.handshakes);
    let handle = resume_params(session_id).resume_handle;
    let init =
        json!({"type": "system", "subtype": "init", "session_id": SCRIPTED_PROVIDER_SESSION_ID});
    let resume = async || {
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        let resumed = fixture
            .driver
            .resume_session(resume_params(session_id))
            .await
            .expect("the resume answers");
        assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
        fixture.next_start().await
    };
    let first = resume().await;
    hand_scripted_frame(&*first.listener, routes, session_id, &init);
    assert!(handshakes.held_handshake_for(session_id, &handle).is_some());
    fixture
        .driver
        .close_session(CloseSessionParams { session_id })
        .await
        .expect("the close succeeds");
    settle().await;

    let second = resume().await;

    assert!(handshakes.held_handshake_for(session_id, &handle).is_none());
    hand_scripted_frame(&*second.listener, routes, session_id, &init);
    assert!(handshakes.held_handshake_for(session_id, &handle).is_some());
}
