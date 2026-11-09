//! The one-turn process: a session's process brought up over a copy of its conversation that
//! Claude Code keeps no file of, sent one message, and read until its lead `result`. No one watches
//! it, so every tool ask is denied, the daemon's hooks pass, its in-process tool servers answer as
//! on the session's own process, and a stop ends it at once. A process given a channel apart from
//! the session's, a staged review's, makes each of its commands a row under its run, any left open
//! ending with the process.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use sidekicks_contracts::event::declared_variants::ProviderBlock;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio_util::sync::CancellationToken;

use crate::driver::claude::delivery::commands::ClaudeCommandChannel;
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::delivery::streamed_blocks::{
    ClaudeFrameBlocks, ClaudeStreamedResponses, read_stream_event,
};
use crate::driver::claude::delivery::system::read_claude_refusal_without_fallback;
use crate::driver::claude::event_normalizer::is_claude_result_frame_kind;
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::process::{ClaudeCodeProcess, ClaudeStreamFrame};
use crate::driver::claude::session::tool_server_calls::{
    ClaudeToolServerCallContext, ClaudeToolServerCalls,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::declarations::{
    ClaudeInboundFrameObservation, ClaudeMessageUsageObservation, ClaudeModelCost,
};
use crate::driver::claude::session::transport::inbound::{
    ClaudeInboundRequest, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, compose_claude_user_frame,
};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSessionSpawn, bring_up_claude_process,
};
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcessArrival, ForwardedArrivals,
};
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::lenient_json::read_lenient;
use crate::outbound_text::OutboundText;
use crate::spawned_version::ResolvedProviderExecutable;

/// What a one-turn process answers a tool ask with: it has no one to ask.
const CLAUDE_ONE_TURN_ASK_DENIAL: &str =
    "This turn runs on its own copy of the conversation, with no one to approve a tool.";

/// One unkept turn to run.
pub(crate) struct ClaudeOneTurnRequest<'a> {
    /// What the session's processes are spawned from.
    pub(crate) spawn: ClaudeSessionSpawn<'a>,
    /// The account the turn runs on.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The conversation copied; `None` starts from an empty one.
    pub(crate) resume_handle: Option<String>,
    /// The mode the turn runs in in place of its level's own; `None` keeps the level's.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
    /// The one message.
    pub(crate) text: OutboundText,
    /// Ends the turn and its process at once when canceled.
    pub(crate) stop: CancellationToken,
}

// What the lead frames so far say about the turn's reply.
#[derive(Debug, Default)]
struct OneTurnReading {
    // The responses the lead streamed and the block each last started.
    responses: ClaudeStreamedResponses,
    // The id of the last assistant message.
    provider_message_id: Option<String>,
    // The block of the last assistant message the reply is.
    provider_block: Option<ProviderBlock>,
    // The last refusal.
    refusal: Option<RunFailureCause>,
    // The text of the last compaction summary.
    compaction_summary: Option<String>,
}

/// The reply of one unkept turn.
#[derive(Debug)]
pub(crate) struct ClaudeOneTurnReply {
    /// The `result` text, empty where it carries none.
    pub(crate) text: String,
    /// The lead's last assistant message, the one the `result` text repeats.
    pub(crate) provider_message_id: Option<String>,
    /// The block of that message the `result` text repeats.
    pub(crate) provider_block: Option<ProviderBlock>,
    /// The turn's last refusal, as Claude Code reads a turn.
    pub(crate) refusal: Option<RunFailureCause>,
    /// The text of the summary a compaction in the turn wrote, where one did.
    pub(crate) compaction_summary: Option<String>,
}

/// What one one-turn process spent: each message it streamed, its helpers' among them, at its last
/// reading in arrival order, and the per-model figures its lead `result` states.
#[derive(Debug, Default)]
pub(crate) struct ClaudeOneTurnSpend {
    /// The id the process's conversation was minted under.
    pub(crate) thread_id: String,
    /// Each message's usage.
    pub(crate) messages: Vec<ClaudeMessageUsageObservation>,
    /// The lead `result`'s spend per model; `None` where no result came or it stated none.
    pub(crate) model_costs: Option<Vec<ClaudeModelCost>>,
}

impl ClaudeOneTurnSpend {
    /// Takes `observation`'s spend: its message's reading raises that message, a new one appended,
    /// and a lead `result`'s figures are taken.
    pub(crate) fn read_frame(&mut self, observation: &ClaudeInboundFrameObservation) {
        if let Some(message) = &observation.message_usage {
            match (self.messages.iter_mut()).find(|kept| kept.message_id == message.message_id) {
                Some(kept) => kept.raise(message),
                None => self.messages.push(message.clone()),
            }
        }
        if observation.subagent_id.is_none() && is_claude_result_frame_kind(&observation.frame_kind)
        {
            self.model_costs.clone_from(&observation.model_costs);
        }
    }
}

/// How one unkept turn ended: its reply or failure, and its process's spend, `None` where no
/// process came up.
#[derive(Debug)]
pub(crate) struct ClaudeOneTurnOutcome {
    /// The reply, or why there is none.
    pub(crate) reply: Result<ClaudeOneTurnReply, ClaudeLaunchError>,
    /// What the process spent, however the turn ended.
    pub(crate) spend: Option<ClaudeOneTurnSpend>,
}

// The members of a lead `user` frame a compaction summary is read from: Claude Code marks the
// summary's echo `isReplay: false`, a person's message's `true`, and a tool result's not at all.
#[derive(Deserialize)]
struct UserFrame {
    #[serde(rename = "isReplay", default, deserialize_with = "read_lenient")]
    is_replay: Option<bool>,
    #[serde(default)]
    message: Option<UserFrameMessage>,
}

#[derive(Deserialize)]
struct UserFrameMessage {
    #[serde(default)]
    content: Value,
}

// The text of a compaction summary's echo: its content as one string, else its text blocks joined.
fn read_compaction_summary(frame_text: &str) -> Option<String> {
    let frame = serde_json::from_str::<UserFrame>(frame_text).ok()?;
    if frame.is_replay != Some(false) {
        return None;
    }
    match frame.message?.content {
        Value::String(text) => Some(text),
        Value::Array(blocks) => Some(
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => None,
    }
}

// The members of a lead `result` frame the reply reads.
#[derive(Deserialize)]
struct ResultFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    result: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
}

/// Runs one unkept turn on `executable`: brings the process up, sends the message, and reads the
/// lead's assistant messages and refusals until its `result`, with every frame's spend up to the
/// turn's end. The process is closed as a session closes once the turn ends, or terminated at once
/// on a stop. The reply fails with `TurnStopped` on a stop, `TurnErrored` on an error `result` with
/// no refusal, `Unanswered` when the process exits first, `MessageUnwritten` when the message could
/// not be written, and as the bring-up does, with no spend.
pub(crate) async fn run_claude_one_turn(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    request: ClaudeOneTurnRequest<'_>,
) -> ClaudeOneTurnOutcome {
    let session_id = request.spawn.legs.session_id;
    let servers = request.spawn.in_process_servers.cloned();
    let provider_account_id = request.provider_account_id;
    let command_channel = request.spawn.legs.command_channel.clone();
    let apart_run = command_channel
        .as_deref()
        .and_then(ClaudeCommandChannel::apart_run);
    let (listener, mut arrivals) = ForwardedArrivals::open();
    let provider_session_id = mint_uuid_v7().to_string();
    let brought_up = match bring_up_claude_process(
        launcher,
        executable,
        ClaudeBringUpRequest {
            spawn: request.spawn,
            provider_session_id: provider_session_id.clone(),
            account: ClaudeProcessAccount::new(Some(provider_account_id.clone())),
            conversation: ClaudeConversationStart::Unkept {
                resume_handle: request.resume_handle,
            },
            listener,
            turn_holds: None,
            permission_mode: request.permission_mode,
            messaging_socket: None,
        },
    )
    .await
    {
        Ok(brought_up) => brought_up,
        Err(error) => {
            // A process that never came up ended whatever task it had.
            if let Some(apart_run) = apart_run {
                apart_run.end();
            }
            return ClaudeOneTurnOutcome {
                reply: Err(error),
                spend: None,
            };
        }
    };
    let process = brought_up.process;
    if let Some(apart_run) = apart_run {
        apart_run.serve(Arc::clone(&process) as Arc<dyn ClaudeProcessChannel>);
    }
    let calls = ClaudeToolServerCalls::default();
    let mut spend = ClaudeOneTurnSpend {
        thread_id: provider_session_id,
        ..ClaudeOneTurnSpend::default()
    };
    let turn = async {
        let frame =
            compose_claude_user_frame(&request.text, mint_uuid_v7().to_string(), Vec::new());
        if let ClaudeWriteAttempt::Failed { cause, .. } = process.write_user_frame(frame).await {
            return Err(ClaudeLaunchError::MessageUnwritten(cause));
        }
        let mut reading = OneTurnReading::default();
        while let Some(arrival) = arrivals.recv().await {
            match arrival {
                ClaudeShortProcessArrival::Frame(frame) => {
                    spend.read_frame(&frame.observation);
                    // A helper's commands are rows under the run too.
                    if let Some(apart_run) = apart_run {
                        apart_run.read_frame(&frame.observation.frame_kind, &frame.text);
                    }
                    if frame.observation.subagent_id.is_some() {
                        continue;
                    }
                    if is_claude_result_frame_kind(&frame.observation.frame_kind) {
                        return read_reply(&frame, reading);
                    }
                    read_lead_frame(&frame, &mut reading);
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
    let reply = tokio::select! {
        reply = turn => reply,
        () = request.stop.cancelled() => Err(ClaudeLaunchError::TurnStopped),
    };
    calls.cancel_all();
    end_process(&process, request.stop.is_cancelled()).await;
    if let Some(apart_run) = apart_run {
        apart_run.end();
    }
    ClaudeOneTurnOutcome {
        reply,
        spend: Some(spend),
    }
}

// A tool ask is denied and every other request passes, since no one watches this process; a
// message for an in-process tool server goes to its server as on the session's own process.
async fn answer_unwatched(
    calls: &ClaudeToolServerCalls,
    context: ClaudeToolServerCallContext,
    asked: ClaudeInboundRequest,
) {
    if let ClaudeInboundRequestBody::McpMessage(message) = asked.body {
        calls.start(context, asked.request_id, message);
        return;
    }
    let answer = compose_unwatched_answer(&asked.body);
    answer_claude_request(
        &*context.channel,
        &context.session_id,
        &context.provider_account_id,
        asked.request_id,
        &answer,
    )
    .await;
}

// What a lead frame says of the reply, as Claude Code reads a turn: an assistant message's id, its
// block and the refusal it ends on, a refusal no other model took, and another model taking the
// refused turn, which retracts the refusal. A streamed message's frame is the block the response
// last started; a whole message's is its last text block.
fn read_lead_frame(frame: &ClaudeStreamFrame, reading: &mut OneTurnReading) {
    let frame_kind = frame.observation.frame_kind.as_str();
    if frame_kind == "system/model_refusal_fallback" {
        reading.refusal = None;
        return;
    }
    match frame_kind {
        "user" => {
            if let Some(summary) = read_compaction_summary(&frame.text) {
                reading.compaction_summary = Some(summary);
            }
        }
        "stream_event" => {
            if let Some(event) = read_stream_event(&frame.text) {
                reading.responses.observe(&event);
            }
        }
        "assistant" => {
            let Ok(message) = serde_json::from_str::<ClaudeMessageFrame>(&frame.text) else {
                return;
            };
            if let Some(id) = message.provider_message_id() {
                reading.provider_message_id = Some(id.to_owned());
                reading.provider_block =
                    match reading.responses.take_frame(id, message.block_count()) {
                        ClaudeFrameBlocks::Started(started) => started.provider_block(),
                        ClaudeFrameBlocks::Unstarted { offset, attempt } => message
                            .last_text_index()
                            .and_then(|index| ProviderBlock::new(offset + index, attempt)),
                    };
            }
            if let Some(refusal) = message.refusal() {
                reading.refusal = Some(refusal);
            }
        }
        "system/model_refusal_no_fallback" => {
            if let Ok(Value::Object(members)) = serde_json::from_str::<Value>(&frame.text) {
                reading.refusal = read_claude_refusal_without_fallback(&members);
            }
        }
        _ => {}
    }
}

/// The answer of a process no one watches to a request it holds: a tool ask is denied, since no one
/// can approve it, and every other request passes; a process that names no tool server sends no
/// message for one.
pub(crate) fn compose_unwatched_answer(body: &ClaudeInboundRequestBody) -> Value {
    match body {
        ClaudeInboundRequestBody::CanUseTool(_) => {
            json!({"behavior": "deny", "message": CLAUDE_ONE_TURN_ASK_DENIAL})
        }
        ClaudeInboundRequestBody::McpMessage(_)
        | ClaudeInboundRequestBody::HookCallback(_)
        | ClaudeInboundRequestBody::RequestUserDialog(_)
        | ClaudeInboundRequestBody::Unrouted { .. } => json!({}),
    }
}

fn read_reply(
    frame: &ClaudeStreamFrame,
    reading: OneTurnReading,
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
        provider_block: reading.provider_block,
        refusal: reading.refusal,
        compaction_summary: reading.compaction_summary,
    })
}

// A stopped turn ends its process at once; a finished one closes it as any session closes.
async fn end_process(process: &ClaudeCodeProcess, is_stopped: bool) {
    if is_stopped {
        process.terminate().await;
    } else {
        process.close().await;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::ClaudeOneTurnSpend;
    use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;

    // An assistant message `id` on Opus 5.5 of `input` and `output` tokens, a helper's where
    // `agent_id` names one.
    fn message(id: &str, agent_id: Option<&str>, input: u64, output: u64) -> Value {
        json!({"type": "assistant", "agent_id": agent_id, "message": {"id": id,
            "model": "claude-opus-5-5", "role": "assistant", "content": [],
            "usage": {"input_tokens": input, "output_tokens": output}}})
    }

    // Killed by two readings of one message summed (1,500 input), by a helper's message skipped,
    // and by a result's figures left untaken.
    #[test]
    fn a_one_turns_spend_holds_each_messages_last_reading_and_its_results_figures() {
        let mut spend = ClaudeOneTurnSpend::default();
        let result = json!({"type": "result", "subtype": "success", "is_error": false,
            "result": "done", "model_usage_since_last_result": {"claude-opus-5-5": {
                "inputTokens": 1_300, "outputTokens": 550, "costUSD": 0.02, "costBasis": "list"}}});
        for frame in [
            message("m1", None, 500, 100),
            message("m1", None, 1_000, 500),
            message("m2", Some("helper"), 300, 50),
            result,
        ] {
            let read = ClaudeStreamFrameRead::read(&frame.to_string()).expect("a frame");
            spend.read_frame(&read.into_observation());
        }

        let messages: Vec<_> = (spend.messages.iter())
            .map(|kept| {
                (
                    kept.message_id.as_str(),
                    kept.counts.input,
                    kept.counts.output,
                )
            })
            .collect();
        assert_eq!(
            messages,
            [("m1", Some(1_000), Some(500)), ("m2", Some(300), Some(50))]
        );
        let costs: Vec<_> = (spend.model_costs.iter().flatten())
            .map(|cost| (cost.model_id.as_str(), cost.counts.input, cost.cost_usd))
            .collect();
        assert_eq!(costs, [("claude-opus-5-5", Some(1_300), Some(0.02))]);
    }
}
