//! The one-turn process: a session's process brought up over a copy of its conversation that
//! Claude Code keeps no file of, sent one message, and read until its lead `result`. No one watches
//! it, so every tool ask is denied, the daemon's hooks pass, its in-process tool servers answer as
//! on the session's own process, and a stop ends it at once.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::claude::hooks::callbacks::answer_claude_request;
use crate::provider::driver::claude::session::process::{ClaudeCodeProcess, ClaudeStreamFrame};
use crate::provider::driver::claude::session::tool_server_calls::{
    ClaudeToolServerCallContext, ClaudeToolServerCalls,
};
use crate::provider::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeInboundRequest, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, compose_claude_user_frame,
};
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSessionSpawn, bring_up_claude_process,
};
use crate::provider::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcessArrival, ForwardedArrivals,
};
use crate::provider::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::provider::lenient_json::read_lenient;
use crate::provider::outbound_text::OutboundText;

/// What a one-turn process answers a tool ask with: it has no one to ask.
const CLAUDE_ONE_TURN_ASK_DENIAL: &str =
    "This turn runs on its own copy of the conversation, with no one to approve a tool.";

/// One unkept turn to run.
pub(crate) struct ClaudeOneTurnRequest<'a> {
    /// What the session's processes are spawned from.
    pub(crate) spawn: ClaudeSessionSpawn<'a>,
    /// The conversation copied; `None` starts from an empty one.
    pub(crate) resume_handle: Option<String>,
    /// The one message.
    pub(crate) text: OutboundText,
    /// Ends the turn and its process at once when cancelled.
    pub(crate) stop: CancellationToken,
}

/// What one lead frame says about the turn's reply, as the session's frame readers read it.
#[derive(Debug, Default)]
pub(crate) struct ClaudeOneTurnFrameReading {
    /// The id of the assistant message the frame is a piece of.
    pub(crate) provider_message_id: Option<String>,
    /// The refusal the frame carries.
    pub(crate) refusal: Option<RunFailureCause>,
}

/// The reply of one unkept turn.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's side question and staged review read the reply"
    )
)]
pub(crate) struct ClaudeOneTurnReply {
    /// The `result` text, empty where it carries none.
    pub(crate) text: String,
    /// The lead's last assistant message, the one the `result` text repeats.
    pub(crate) provider_message_id: Option<String>,
    /// The turn's last refusal, as Claude Code reads a turn.
    pub(crate) refusal: Option<RunFailureCause>,
}

// The members of a lead `result` frame the reply reads.
#[derive(Deserialize)]
struct ResultFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    result: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
}

/// Runs one unkept turn: brings the process up, sends the message, and reads until the lead
/// `result`, handing each other lead frame to `read_frame`. The process is closed as a session
/// closes once the turn ends, or terminated at once on a stop. Fails with `TurnStopped` on a stop,
/// `TurnErrored` on an error `result` with no refusal, `Unanswered` when the process exits first,
/// `MessageUnwritten` when the message could not be written, and as the bring-up does.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's side question and staged review run their turn through it"
    )
)]
pub(crate) async fn run_claude_one_turn(
    launcher: &ClaudeProcessLauncher,
    request: ClaudeOneTurnRequest<'_>,
    read_frame: &(dyn Fn(&ClaudeStreamFrame) -> ClaudeOneTurnFrameReading + Sync),
) -> Result<ClaudeOneTurnReply, ClaudeLaunchError> {
    let session_id = request.spawn.legs.session_id;
    let servers = request.spawn.in_process_servers.cloned();
    let provider_account_id = request.spawn.provider_account_id.clone();
    let (listener, mut arrivals) = ForwardedArrivals::open();
    let brought_up = bring_up_claude_process(
        launcher,
        ClaudeBringUpRequest {
            spawn: request.spawn,
            provider_session_id: mint_uuid_v7().to_string(),
            conversation: ClaudeConversationStart::Unkept {
                resume_handle: request.resume_handle,
            },
            listener,
            turn_holds: None,
        },
    )
    .await?;
    let process = brought_up.process;
    let calls = ClaudeToolServerCalls::default();
    let turn = async {
        let frame =
            compose_claude_user_frame(&request.text, mint_uuid_v7().to_string(), Vec::new());
        if let ClaudeWriteAttempt::Failed { cause, .. } = process.write_user_frame(frame).await {
            return Err(ClaudeLaunchError::MessageUnwritten(cause));
        }
        let mut reading = ClaudeOneTurnFrameReading::default();
        while let Some(arrival) = arrivals.recv().await {
            match arrival {
                ClaudeShortProcessArrival::Frame(frame) => {
                    if frame.observation.subagent_id.is_some() {
                        continue;
                    }
                    if frame.observation.frame_kind.split('/').next() == Some("result") {
                        return read_reply(&frame, reading);
                    }
                    let frame_reading = read_frame(&frame);
                    reading.provider_message_id = frame_reading
                        .provider_message_id
                        .or(reading.provider_message_id);
                    reading.refusal = frame_reading.refusal.or(reading.refusal);
                }
                ClaudeShortProcessArrival::Request(ClaudeInboundRequestEvent::Request(asked)) => {
                    let context = ClaudeToolServerCallContext {
                        session_id,
                        provider_account_id: provider_account_id.clone(),
                        channel: Arc::clone(&process) as Arc<dyn ClaudeProcessChannel>,
                        servers: servers.clone(),
                    };
                    answer_unwatched(&calls, context, asked).await;
                }
                ClaudeShortProcessArrival::Request(ClaudeInboundRequestEvent::Cancel {
                    request_id,
                }) => {
                    calls.cancel(&request_id);
                }
                ClaudeShortProcessArrival::Exit => break,
            }
        }
        Err(ClaudeLaunchError::Unanswered {
            what: "the one-turn message".to_owned(),
        })
    };
    let outcome = tokio::select! {
        outcome = turn => outcome,
        () = request.stop.cancelled() => Err(ClaudeLaunchError::TurnStopped),
    };
    calls.cancel_all();
    end_process(&process, request.stop.is_cancelled()).await;
    outcome
}

// A tool ask is denied and every other request passes, since no one watches this process; a
// message for an in-process tool server goes to its server as on the session's own process.
async fn answer_unwatched(
    calls: &ClaudeToolServerCalls,
    context: ClaudeToolServerCallContext,
    asked: ClaudeInboundRequest,
) {
    let answer = match asked.body {
        ClaudeInboundRequestBody::McpMessage(message) => {
            calls.start(context, asked.request_id, message);
            return;
        }
        ClaudeInboundRequestBody::CanUseTool(_) => {
            json!({"behavior": "deny", "message": CLAUDE_ONE_TURN_ASK_DENIAL})
        }
        ClaudeInboundRequestBody::HookCallback(_)
        | ClaudeInboundRequestBody::RequestUserDialog(_)
        | ClaudeInboundRequestBody::Unrouted { .. } => json!({}),
    };
    answer_claude_request(
        &*context.channel,
        &context.session_id,
        context.provider_account_id.as_ref(),
        asked.request_id,
        &answer,
    )
    .await;
}

fn read_reply(
    frame: &ClaudeStreamFrame,
    reading: ClaudeOneTurnFrameReading,
) -> Result<ClaudeOneTurnReply, ClaudeLaunchError> {
    let result = serde_json::from_str::<ResultFrame>(&frame.text).ok();
    let text = result
        .as_ref()
        .and_then(|result| result.result.clone())
        .unwrap_or_default();
    let is_error = result.and_then(|result| result.is_error) == Some(true);
    if is_error && reading.refusal.is_none() {
        return Err(ClaudeLaunchError::TurnErrored { text });
    }
    Ok(ClaudeOneTurnReply {
        text,
        provider_message_id: reading.provider_message_id,
        refusal: reading.refusal,
    })
}

// A stopped turn ends its process at once; a finished one closes it as any session closes.
async fn end_process(process: &ClaudeCodeProcess, is_stopped: bool) {
    if is_stopped {
        process.terminate().await;
    } else {
        process.stop(CLAUDE_REQUEST_DEADLINE).await;
    }
}
