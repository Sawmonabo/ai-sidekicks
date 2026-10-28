//! Steering a Codex run's live turn with `turn/steer`. A steer is registered on the session's
//! record before it is written, as sent and not yet echoed on its turn, since Codex can write the
//! message's echo before it answers the request; steers on one conversation go out one at a time,
//! each once Codex answered the one before, in the order they were registered; and none is sent
//! into a turn that ended or that an interrupt is stopping. A steer the person's own
//! `userPromptSubmit` hook keeps out of its turn is never echoed; at the turn's end it is paired
//! with the words of the hook handlers that refused it, and the steers a pause or a retry stopped
//! the turn under go back to the queue.

use std::sync::{Arc, LazyLock};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;

use crate::driver::codex::app_server_protocol::{TurnSteerParams, UserInput};
use crate::driver::codex::delivery::frames::{CodexPromptHookRun, CodexTurnEnding};
use crate::driver::codex::input_limit::message_too_large_refusal;
use crate::driver::codex::intervention::CodexSteerAcknowledgment;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::view::read_steered_turn_id;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::{DriverError, bound_failure_detail};
use crate::driver::run_control::SteerTurnEndedError;

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
        .register(message_id);
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
        targeted_turn_id: expected_turn_id.unwrap_or_else(|| turn_id.clone()),
        turn_id,
        message_id,
        previous,
        answered,
    })
}

/// Steers one message into `run_id`'s live turn, off the session's task: registers it on the
/// session's task before anything is written, waits for its `input`, writes it once the steer
/// before it was answered, and takes it back when Codex surely did not take it: refused, or never
/// sent; one whose answer never came keeps its place. `expected_turn_id`, where the caller pins
/// one, is the turn the steer names. Answers the turn it targeted and the turn Codex acknowledged.
/// Fails with `SteerTurnEnded` when the run has no live turn, an interrupt is stopping it, its
/// session's task ended or Codex refused it for its turn, with `session.message.tooLarge` when its
/// text passes Codex's input limit, and as `input` and the request fail.
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
    let (error, is_untaken) = match input.await {
        Ok(input) => match send_codex_steer(send, input).await {
            Ok(acknowledged) => return Ok(acknowledged),
            // One whose answer never came may have been taken, its prompt hook run, so it keeps
            // its place among the turn's steers.
            Err(error) => {
                let is_untaken = !matches!(error, CodexError::Unanswered { .. });
                (read_steer_failure(run_id, error), is_untaken)
            }
        },
        Err(error) => (error, true),
    };
    if is_untaken {
        // The session's task takes it back; one that ended has nothing to take back.
        let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::WithdrawSteer {
            turn_id,
            message_id,
        }));
    }
    Err(error)
}

// Writes a registered steer with `input` once the steer before it was answered.
async fn send_codex_steer(
    send: CodexSteerSend,
    input: Vec<UserInput>,
) -> Result<CodexSteerAcknowledgment, CodexError> {
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
    Ok(CodexSteerAcknowledgment {
        targeted_turn_id: send.targeted_turn_id,
        acknowledged_turn_id: read_steered_turn_id(&reply?),
    })
}

// A steer's failed send as the driver reports it: a refusal because its turn had ended or is not
// one a steer reaches fails with `SteerTurnEnded`, and one past Codex's input limit is refused.
fn read_steer_failure(run_id: RunId, error: CodexError) -> DriverError {
    if is_steer_turn_gone(&error) {
        return SteerTurnEndedError { run_id }.into();
    }
    message_too_large_refusal(&error).map_or_else(|| error.into(), DriverError::Refused)
}

/// Takes back a steer Codex did not take, on the session's task: it is no longer waited for on
/// its turn, so no interrupt lists it as canceled.
pub(crate) fn withdraw_codex_steer(
    record: &mut CodexSessionRecord,
    turn_id: &str,
    message_id: QueueItemId,
) {
    if let Some(unechoed) = record.unechoed_steers_by_turn_id.get_mut(turn_id) {
        unechoed.withdraw(message_id);
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
    record
        .unechoed_steers_by_turn_id
        .get_mut(turn_id)?
        .take_echoed(echoed)
        .then_some(echoed)
}

/// Remembers, on the session's task, one run of the person's own `userPromptSubmit` hook on a
/// prompt of its turn, until that turn ends; a run naming no live turn is kept nowhere, since no
/// end would let it go.
pub(crate) fn remember_codex_prompt_hook_run(
    record: &mut CodexSessionRecord,
    hook_run: CodexPromptHookRun,
) {
    let Some(turn_id) = hook_run
        .turn_id
        .clone()
        .filter(|turn_id| record.active_turn_run(turn_id).is_some())
    else {
        tracing::debug!(turn_id = ?hook_run.turn_id, "a codex prompt hook run names no live turn");
        return;
    };
    record
        .prompt_hook_runs_by_turn_id
        .entry(turn_id)
        .or_default()
        .push(hook_run);
}

/// What an ended turn's unechoed steers come to: those the person's own hook refused, each with its
/// words, and those a pause or a retry stopped the turn under, which the queue gives back.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexEndedTurnSteers {
    /// The refused steers' messages and their hooks' words, in send order.
    pub(crate) refused: Vec<(QueueItemId, FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>)>,
    /// The messages of the steers Codex dropped unsent, in send order.
    pub(crate) dropped: Vec<QueueItemId>,
}

/// Takes, on the session's task, the steers the turn `turn_id`, which ended `ending`, still holds
/// unechoed: those the person's own `userPromptSubmit` hook kept out of it, each with its hook's
/// words, and, when a pause or a retry stopped it, the rest as dropped. An interrupt's turn keeps
/// the rest for the interrupt to take, and a turn that ended by itself lets them go. Codex runs
/// the hook on the turn's opening prompt and then on each steer it took, in order, so the steer at
/// place `p` is refused when the prompt after the opening's `p`th one was.
pub(crate) fn take_blocked_codex_steers(
    record: &mut CodexSessionRecord,
    turn_id: &str,
    ending: CodexTurnEnding,
) -> CodexEndedTurnSteers {
    let prompts = read_refused_prompt_words(
        &record
            .prompt_hook_runs_by_turn_id
            .remove(turn_id)
            .unwrap_or_default(),
    );
    let Some(unechoed) = record.unechoed_steers_by_turn_id.get_mut(turn_id) else {
        return CodexEndedTurnSteers::default();
    };
    let mut refused = Vec::new();
    unechoed.steers.retain(|(place, message_id)| {
        let Some(Some(words)) = prompts.get(place + 1) else {
            return true;
        };
        refused.push((
            *message_id,
            bound_failure_detail(words, BLOCKED_STEER_FALLBACK.clone()),
        ));
        false
    });
    let dropped = match ending {
        CodexTurnEnding::Interrupted if !unechoed.steers.is_empty() => {
            return CodexEndedTurnSteers {
                refused,
                dropped: Vec::new(),
            };
        }
        CodexTurnEnding::Paused | CodexTurnEnding::Retried => unechoed.message_ids(),
        CodexTurnEnding::Live | CodexTurnEnding::Interrupted => Vec::new(),
    };
    record.unechoed_steers_by_turn_id.remove(turn_id);
    CodexEndedTurnSteers { refused, dropped }
}

// Each prompt's refusal in order, the opening's first: the words of every handler that ran on it
// where one blocked or stopped it, `None` where all let it through. Codex reports one run per
// handler for every prompt, in the handlers' configured order, and a handler's run id is the same
// on every prompt, so a run id the current prompt already holds starts the next prompt.
fn read_refused_prompt_words(hook_runs: &[CodexPromptHookRun]) -> Vec<Option<String>> {
    let mut prompts: Vec<Vec<&CodexPromptHookRun>> = Vec::new();
    for hook_run in hook_runs {
        match prompts.last_mut() {
            Some(prompt) if prompt.iter().all(|held| held.run_id != hook_run.run_id) => {
                prompt.push(hook_run);
            }
            _ => prompts.push(vec![hook_run]),
        }
    }
    prompts
        .into_iter()
        .map(|prompt| {
            prompt
                .iter()
                .any(|hook_run| hook_run.is_blocked || hook_run.is_stopped)
                .then(|| {
                    prompt
                        .iter()
                        .flat_map(|hook_run| &hook_run.words)
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
        })
        .collect()
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
