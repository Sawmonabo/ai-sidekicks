use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageText, QueueItemId};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::claude::session::transport::user_message::CLAUDE_RESET_REFUSAL_SENTENCE;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::run_control::{
    ApplyInterventionParams, ResumeRunParams, SteerPayload, WaitingMessage,
};
use crate::driver::test_registry::{new_agent_id, new_run_id};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

// The opening of `run_id` on `session`'s lead binding, carrying `attachments`.
fn opening_params(
    session: &ScriptedSession,
    run_id: RunId,
    attachments: Vec<ArtifactId>,
) -> StartRunParams {
    StartRunParams {
        run_id,
        opening: RunOpening {
            session_id: session.session_id,
            binding_id: binding_id("lead"),
            agent_id: new_agent_id(),
            message_id: QueueItemId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an item id"),
            item: RunOpeningItem::Message {
                content: MessageText::new("go on".to_owned()).expect("the words fit"),
                attachments,
                skills: Vec::new(),
            },
        },
        conversation_history: None,
        output_speed: None,
        options: Vec::new(),
        output_speed_for_turn: None,
        execution_posture: None,
        output_schema: None,
        step_bound: None,
    }
}

// Starts the message run `params` opens with its words as typed and its files.
async fn start_message(
    session: &ScriptedSession,
    params: &StartRunParams,
) -> Result<(), DriverError> {
    let RunOpeningItem::Message {
        content,
        attachments,
        ..
    } = &params.opening.item
    else {
        panic!("the test's opening is a message");
    };
    let text = OutboundText {
        text: content.as_str().to_owned(),
        origin: OutboundTextOrigin::HumanText,
    };
    session.start.start_run(params, &text, attachments).await
}

// Killed by answering a picture past Claude Code's limit as an internal failure, at a run's
// start or as it continues, by dropping Claude Code's own words or the session's model from
// the refusal, or by holding the session's turn for a run that never started.
#[rstest]
#[case::start(true)]
#[case::resume(false)]
#[tokio::test]
async fn a_picture_past_the_limit_refuses_the_run_in_claude_codes_own_words(
    #[case] is_start: bool,
) {
    let session = ScriptedSession::new().await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let path = folder.path().join("screen.png");
    // Sparse: its size, which the limit reads, without its bytes.
    std::fs::File::create(&path)
        .and_then(|file| file.set_len(4_000_000))
        .expect("the test stores a large picture");
    let picture = session.attachments.picture(path);
    let run_id = new_run_id();

    let refused = if is_start {
        start_message(&session, &opening_params(&session, run_id, vec![picture])).await
    } else {
        session
            .parts
            .run_controls
            .resume_run(ResumeRunParams {
                session_id: session.session_id,
                run_id,
                messages: vec![WaitingMessage {
                    id: QueueItemId::new(&mint_uuid_v7().to_string())
                        .expect("a minted UUID is an item id"),
                    content: MessageText::new("go on".to_owned()).expect("the words are a message"),
                    attachments: vec![picture],
                    skills: Vec::new(),
                }],
                is_continuation_owed: false,
            })
            .await
            .map(drop)
    };

    let Err(DriverError::RunRefused(refusal)) = refused else {
        panic!("a picture past the limit refuses the run, not {refused:?}");
    };
    assert_eq!(refusal.model.as_str(), "opus");
    assert_eq!(
        refusal.sentence,
        "screen.png: Image base64 size (5333336) exceeds API limit (5242880). Please resize \
         the image before sending."
    );
    assert_eq!(session.channel.user_frames(), [] as [serde_json::Value; 0]);
    assert!(
        session
            .start
            .routes
            .lead_run_on(session.session_id)
            .is_none()
    );
}

// The write a reset word is handed to.
#[derive(Clone, Copy, Debug)]
enum ResetWrite {
    Start,
    Resume,
    Steer,
}

// Killed by checking after the write (a line is written), after `record_written` (the message
// is recorded as sent), after the start holds the session's turn (the turn stays held), by
// letting files change the verdict, and by answering a start with anything but the run's
// refusal or a continue or a steer with anything but `session.message.resetRefused`.
#[rstest]
#[case::start(ResetWrite::Start)]
#[case::resume(ResetWrite::Resume)]
#[case::steer(ResetWrite::Steer)]
#[tokio::test]
async fn a_reset_word_with_files_writes_and_records_nothing(#[case] write: ResetWrite) {
    let session = ScriptedSession::new().await;
    let file = session.attachments.slow_file(Duration::ZERO);
    let words = "/clear now";
    let message_id =
        QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an item id");
    let writes_before = session.channel.writes().len();

    let refused = match write {
        ResetWrite::Start => {
            let mut params = opening_params(&session, new_run_id(), Vec::new());
            params.opening.item = RunOpeningItem::Message {
                content: MessageText::new(words.to_owned()).expect("the words fit"),
                attachments: vec![file],
                skills: Vec::new(),
            };
            start_message(&session, &params).await
        }
        ResetWrite::Resume => {
            let run_id = session.hold_lead_turn("lead");
            session
                .parts
                .run_controls
                .resume_run(ResumeRunParams {
                    session_id: session.session_id,
                    run_id,
                    messages: vec![WaitingMessage {
                        id: message_id,
                        content: MessageText::new(words.to_owned())
                            .expect("the words are a message"),
                        attachments: vec![file],
                        skills: Vec::new(),
                    }],
                    is_continuation_owed: false,
                })
                .await
                .map(drop)
        }
        ResetWrite::Steer => {
            let run_id = session.hold_lead_turn("lead");
            session
                .interventions
                .apply_intervention(ApplyInterventionParams::Steer {
                    target_run_id: run_id,
                    expected_run_version: SafeInt::new(0).expect("zero is a run version"),
                    client_idempotency_key: message_id,
                    payload: SteerPayload {
                        content: MessageText::new(words.to_owned()).expect("the words fit"),
                        attachments: vec![file],
                        skills: Vec::new(),
                        expected_turn_id: None,
                        is_priority: false,
                    },
                })
                .await
                .map(drop)
        }
    };

    match (write, refused) {
        (ResetWrite::Start, Err(DriverError::RunRefused(refusal))) => {
            assert_eq!(refusal.model.as_str(), "opus");
            assert_eq!(refusal.sentence, CLAUDE_RESET_REFUSAL_SENTENCE);
            assert!(
                session
                    .start
                    .routes
                    .lead_run_on(session.session_id)
                    .is_none()
            );
        }
        (ResetWrite::Resume | ResetWrite::Steer, Err(DriverError::Refused(refusal))) => {
            assert_eq!(refusal.code, RefusalCode::SessionMessageResetRefused);
        }
        (write, refused) => panic!("a reset word at {write:?} is refused, not {refused:?}"),
    }
    assert_eq!(session.channel.writes().len(), writes_before);
    assert!(
        lock(&session.start.prompts)
            .newest_for(session.session_id)
            .is_none()
    );
}

// Killed by releasing an ended turn's hold on the session's task: a continue of the run that
// the interrupt stopped would wait on the task, which is itself waiting on that run's turn.
#[tokio::test(start_paused = true)]
async fn a_continued_run_starts_while_the_session_task_is_still_opening_its_last_turn() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.stream.mark_interrupted(run_id);
    let turn_start = session.engine.hold_next_turn_start();
    session.frame(&json!({
        "type": "system",
        "subtype": "init",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    session.frame(&json!({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "terminal_reason": "aborted_tools",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    settle().await;
    let params = opening_params(&session, run_id, Vec::new());
    let message_id = params.opening.message_id;

    start_message(&session, &params)
        .await
        .expect("the run starts without waiting on the session's task");

    let written = session.channel.user_frames();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["uuid"], message_id.to_string());
    drop(turn_start);
}
