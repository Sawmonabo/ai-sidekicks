//! Steering a Codex run's live turn with `turn/steer`. A steer is registered on the session's
//! record before it is written, as sent and not yet echoed on its turn, since Codex can write the
//! message's echo before it answers the request; steers on one conversation go out one at a time,
//! each once Codex answered the one before, in the order they were registered; and none is sent
//! into a turn that ended or that an interrupt is stopping.

use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use tokio::sync::oneshot;

use crate::provider::driver::codex::app_server_protocol::{TurnSteerParams, UserInput};
use crate::provider::driver::codex::intervention::CodexSteerAcknowledgment;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::thread::view::read_steered_turn_id;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::SteerTurnEndedError;

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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's task registers each steer call through it"
    )
)]
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

impl CodexSteerSend {
    /// The live turn the steer was registered on, which a withdrawal names.
    #[expect(
        dead_code,
        reason = "the Codex run's steer withdraws a steer whose send failed from its turn"
    )]
    pub(crate) fn turn_id(&self) -> &str {
        &self.turn_id
    }
}

/// Writes a registered steer with `input` once the steer before it was answered, and answers the
/// turn it targeted and the turn Codex acknowledged. Fails with `SteerTurnEnded` when Codex
/// refused it because its turn had ended or is not one a steer reaches, and as the request fails;
/// either way the caller withdraws it with [`withdraw_codex_steer`].
#[expect(
    dead_code,
    reason = "the Codex run's steer writes each registered steer off the session's task"
)]
pub(crate) async fn send_codex_steer(
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
        Err(error) => Err(error.into()),
    }
}

/// Takes back a steer Codex did not take, on the session's task: it is no longer waited for on
/// its turn, so no interrupt lists it as cancelled.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex run's steer withdraws a steer whose send failed"
    )
)]
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
