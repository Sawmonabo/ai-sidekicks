//! Steering a Codex run's live turn with `turn/steer`. A steer is registered on the session's
//! record before it is written, as sent and not yet echoed on its turn, since Codex can write the
//! message's echo before it answers the request; steers on one conversation go out one at a time,
//! each once Codex answered the one before, in the order they were registered; and none is sent
//! into a turn that ended or that an interrupt is stopping. A steer the person's own
//! `userPromptSubmit` hook keeps out of its turn is never echoed; at the turn's end it is paired
//! with the hook's words.

use std::sync::{Arc, LazyLock};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;

use crate::provider::driver::codex::app_server_protocol::{TurnSteerParams, UserInput};
use crate::provider::driver::codex::input_limit::message_too_large_refusal;
use crate::provider::driver::codex::intervention::CodexSteerAcknowledgment;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::thread::view::read_steered_turn_id;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::run_control::SteerTurnEndedError;

#[cfg(test)]
mod tests;

/// Codex's request that adds input to a running turn.
const CODEX_TURN_STEER_METHOD: &str = "turn/steer";

/// The words of Codex's refusals of a steer whose turn is no longer there to take it: it ended,
/// another turn runs, or the running turn takes no steer.
const CODEX_STEER_TURN_GONE_MESSAGES: [&str; 4] = [
    "no active turn to steer",
    "expected active turn id",
    "cannot steer a review turn",
    "compact turn",
];

/// What a refused steer reads when its hook gave no words of its own.
static BLOCKED_STEER_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("A prompt hook refused this message.".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// One steer registered on its record and waiting to be written, off the session's task.
pub(crate) struct CodexSteerSend {
    connection: Arc<CodexAppServerConnection>,
    thread_id: String,
    run_id: RunId,
    turn_id: String,
    targeted_turn_id: String,
    message_id: QueueItemId,
    /// The conversation's steer before this one, which this one waits for.
    previous: Option<Shared<BoxFuture<'static, ()>>>,
    /// Dropped once this steer is answered, which lets the next one go.
    answered: oneshot::Sender<()>,
}

/// Registers the steer `message_id` on `run_id`'s newest live turn, on the session's task, before
/// anything is written: as sent and not yet echoed on that turn, and as the conversation's newest
/// steer, which the next one waits for. `expected_turn_id`, where the caller pins one, is the turn
/// the steer names to Codex. Fails with `SteerTurnEnded` when the run has no live turn or an
/// interrupt is stopping it, and as the service's connection fails.
pub(crate) fn register_codex_steer(
    record: &mut CodexSessionRecord,
    run_id: RunId,
    expected_turn_id: Option<String>,
    message_id: QueueItemId,
) -> Result<CodexSteerSend, DriverError> {
    let Some(turn_id) = record
        .newest_active_turn_for_run(run_id)
        .filter(|turn_id| !record.interrupting_turn_ids.contains(*turn_id))
        .map(str::to_owned)
    else {
        return Err(SteerTurnEndedError { run_id }.into());
    };
    let connection = record.service.connection()?;
    record
        .unechoed_steers_by_turn_id
        .entry(turn_id.clone())
        .or_default()
        .push(message_id);
    let previous = record.last_steer_send.take();
    let (answered, answer) = oneshot::channel::<()>();
    let waited = previous.clone();
    let settled: BoxFuture<'static, ()> = async move {
        if let Some(waited) = waited {
            waited.await;
        }
        // Answered or dropped, the steer is settled either way.
        let _settled = answer.await;
    }
    .boxed();
    record.last_steer_send = Some(settled.shared());
    Ok(CodexSteerSend {
        connection,
        thread_id: record.thread_id.clone(),
        run_id,
        targeted_turn_id: expected_turn_id.unwrap_or_else(|| turn_id.clone()),
        turn_id,
        message_id,
        previous,
        answered,
    })
}

/// Steers one message into `run_id`'s live turn, off the session's task: registers it on the
/// session's task before anything is written, waits for its `input`, writes it once the steer
/// before it was answered, and takes it back when Codex did not take it. `expected_turn_id`, where
/// the caller pins one, is the turn the steer names. Answers the turn it targeted and the turn
/// Codex acknowledged. Fails with `SteerTurnEnded` when the run has no live turn, an interrupt is
/// stopping it, its session's task ended or Codex refused it for its turn, with
/// `session.message.tooLarge` when its text passes Codex's input limit, and as `input` and the
/// request fail.
pub(crate) async fn steer_codex_run(
    inbound: &CodexSessionInboundSender,
    run_id: RunId,
    expected_turn_id: Option<String>,
    message_id: QueueItemId,
    input: impl Future<Output = Result<Vec<UserInput>, DriverError>>,
) -> Result<CodexSteerAcknowledgment, DriverError> {
    let (reply, replied) = oneshot::channel();
    let registered = if inbound.push(CodexSessionInbound::Call(CodexSessionCall::RegisterSteer {
        run_id,
        expected_turn_id,
        message_id,
        reply,
    })) {
        replied.await.ok()
    } else {
        None
    };
    // A session whose task ended has no turn left to steer.
    let send = registered.unwrap_or_else(|| Err(SteerTurnEndedError { run_id }.into()))?;
    let turn_id = send.turn_id.clone();
    // A steer whose input failed is dropped unsent, which lets the next one go.
    let sent = match input.await {
        Ok(input) => send_codex_steer(send, input).await,
        Err(error) => Err(error),
    };
    if sent.is_err() {
        // The session's task takes it back; one that ended has nothing to take back.
        let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::WithdrawSteer {
            turn_id,
            message_id,
        }));
    }
    sent
}

// Writes a registered steer with `input` once the steer before it was answered; a refusal because
// its turn had ended or is not one a steer reaches fails with `SteerTurnEnded`.
async fn send_codex_steer(
    send: CodexSteerSend,
    input: Vec<UserInput>,
) -> Result<CodexSteerAcknowledgment, DriverError> {
    if let Some(previous) = send.previous {
        previous.await;
    }
    let reply = send
        .connection
        .request(
            CODEX_TURN_STEER_METHOD,
            &TurnSteerParams {
                thread_id: send.thread_id,
                input,
                expected_turn_id: send.targeted_turn_id.clone(),
                // The message's own id, never re-minted, so its echo names it.
                client_user_message_id: Some(send.message_id.to_string()),
                additional_context: None,
                responsesapi_client_metadata: None,
            },
        )
        .await;
    drop(send.answered);
    match reply {
        Ok(reply) => Ok(CodexSteerAcknowledgment {
            targeted_turn_id: send.targeted_turn_id,
            acknowledged_turn_id: read_steered_turn_id(&reply),
        }),
        Err(error) if is_steer_turn_gone(&error) => Err(SteerTurnEndedError {
            run_id: send.run_id,
        }
        .into()),
        Err(error) => {
            Err(message_too_large_refusal(&error)
                .map_or_else(|| error.into(), DriverError::Refused))
        }
    }
}

/// Takes back a steer Codex did not take, on the session's task: it is no longer waited for on
/// its turn, so no interrupt lists it as cancelled.
pub(crate) fn withdraw_codex_steer(
    record: &mut CodexSessionRecord,
    turn_id: &str,
    message_id: QueueItemId,
) {
    let Some(unechoed) = record.unechoed_steers_by_turn_id.get_mut(turn_id) else {
        return;
    };
    unechoed.retain(|unechoed_id| *unechoed_id != message_id);
    if unechoed.is_empty() {
        record.unechoed_steers_by_turn_id.remove(turn_id);
    }
}

/// Takes the steer `client_message_id` Codex echoed on the turn `turn_id` out of the steers the
/// turn has yet to echo, on the session's task, answering the message's id the first time only,
/// so its message is taken once; an echo of anything else answers `None`.
pub(crate) fn take_echoed_codex_steer(
    record: &mut CodexSessionRecord,
    turn_id: &str,
    client_message_id: &str,
) -> Option<QueueItemId> {
    let echoed = QueueItemId::new(client_message_id).ok()?;
    let unechoed = record.unechoed_steers_by_turn_id.get_mut(turn_id)?;
    let at = unechoed
        .iter()
        .position(|message_id| *message_id == echoed)?;
    let message_id = unechoed.remove(at);
    if unechoed.is_empty() {
        record.unechoed_steers_by_turn_id.remove(turn_id);
    }
    Some(message_id)
}

/// Remembers, on the session's task, a prompt the person's own `userPromptSubmit` hook kept out of
/// the turn `turn_id`, with the hook's `words`, until that turn ends; a turn that is not live keeps
/// nothing, since no end would let it go.
pub(crate) fn remember_blocked_codex_prompt(
    record: &mut CodexSessionRecord,
    turn_id: &str,
    words: &[String],
) {
    if record.active_turn_run(turn_id).is_none() {
        tracing::debug!(turn_id, "a blocked codex prompt names no live turn");
        return;
    }
    record
        .blocked_prompt_words_by_turn_id
        .entry(turn_id.to_owned())
        .or_default()
        .push(words.join("\n"));
}

/// Takes, on the session's task, the steers the person's own `userPromptSubmit` hook kept out of
/// the turn `turn_id`, which ended, each with its hook's words, and lets go of the rest the turn
/// still holds unechoed, unless the turn's interrupt takes them as the ones Codex dropped. Codex
/// echoes every steer its hooks let through and reports each hook run in the steers' order, so
/// the steers still unechoed are the blocked ones; a block reported ahead of them is the turn's
/// opening prompt's, never a steer.
pub(crate) fn take_blocked_codex_steers(
    record: &mut CodexSessionRecord,
    turn_id: &str,
) -> Vec<(QueueItemId, FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>)> {
    let blocked = record
        .blocked_prompt_words_by_turn_id
        .remove(turn_id)
        .unwrap_or_default();
    // The interrupt marked its turn before it went and keeps it for its end once Codex answered.
    let is_interrupt_taking = record.interrupted_turn_run(turn_id).is_some()
        || record.interrupting_turn_ids.contains(turn_id);
    let Some(unechoed) = record.unechoed_steers_by_turn_id.get_mut(turn_id) else {
        return Vec::new();
    };
    let opening_blocks = blocked.len().saturating_sub(unechoed.len());
    let refused: Vec<_> = unechoed
        .drain(..blocked.len() - opening_blocks)
        .zip(&blocked[opening_blocks..])
        .map(|(message_id, words)| {
            (
                message_id,
                bound_failure_detail(words, BLOCKED_STEER_FALLBACK.clone()),
            )
        })
        .collect();
    if unechoed.is_empty() || !is_interrupt_taking {
        record.unechoed_steers_by_turn_id.remove(turn_id);
    }
    refused
}

// Codex refuses a steer whose turn ended before it arrived, and the turn's end reaches the daemon
// ahead of that answer, so the refused message waits for the run's next turn.
fn is_steer_turn_gone(error: &CodexError) -> bool {
    matches!(
        error,
        CodexError::ProviderRequest { message, .. }
            if CODEX_STEER_TURN_GONE_MESSAGES
                .iter()
                .any(|refusal| message.contains(refusal))
    )
}
