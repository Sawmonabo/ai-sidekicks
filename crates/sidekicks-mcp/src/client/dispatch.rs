//! The tool call's dispatch, one per daemon: a call's receipt is recorded and claimed before the
//! call is sent, the task the server accepts it as is stored on that receipt before its first
//! poll, and every wait races the session's close and the caller's cancel.
//!
//! - The dispatch writes a call's end only when the session's close reaches the call: a plain
//!   call is dropped, which tells the server it is canceled, and its end is unknown; a task is
//!   canceled on the still-open connection and its end read once. The caller writes every other
//!   end through [`McpDispatchedCall::complete`], or hands it off.
//! - An end without the server's answer while the client stops came from the stop, so nothing is
//!   written and the receipt stays in flight.

use std::pin::pin;
use std::sync::Mutex;

use futures::future::BoxFuture;
use rmcp::service::ServiceError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::WriteError;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::poll::{PollError as _, PollFailure};
use crate::client::requests::McpRequestError;
use crate::client::tasks::recorder::McpTaskHandleRecorder;
use crate::client::tasks::{
    McpTaskCancelOutcome, McpTaskContact, McpTaskGeneration, McpTaskHandleObservation,
    McpTaskHandleSink, McpToolCall, McpToolCallEnd, McpToolCallError,
};
use crate::command_receipts::{
    CommandOutcome, CommandReceiptError, CommandReceiptId, CommandReceiptStore,
};

#[cfg(test)]
mod tests;

/// The daemon's one tool call dispatch: the receipts every call is recorded in, and the recorder
/// each accepted task's handle is stored through.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the one dispatch every tool call goes through"
    )
)]
pub(crate) struct McpToolDispatch {
    receipts: CommandReceiptStore,
    recorder: McpTaskHandleRecorder,
}

/// Why a call was not dispatched.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpToolDispatchError {
    /// The caller canceled before the call was sent; no receipt was written.
    #[error("the tool call was canceled before it was sent")]
    Canceled,
    /// The session's connections closed before the call was sent; no receipt was written.
    #[error("the session's tool-server connections closed")]
    SessionClosed,
    /// The client is stopping: before the call was sent, no receipt written; or the call ended
    /// without the server's answer as the client stopped, its receipt left in flight.
    #[error("the tool-server client is stopping")]
    ClientStopping,
    /// No connection to the server is live in the session; no receipt was written.
    #[error("the tool server is not connected in this session")]
    NotConnected,
    /// The server's tools, which say whether the tool takes a task, could not be read; no receipt
    /// was written.
    #[error("the tool server's tools could not be read")]
    ToolsRead(#[source] McpRequestError),
    /// The receipt was not written, so the call was not sent.
    #[error("the tool call's receipt was not written")]
    Receipt(#[source] CommandReceiptError),
}

/// Why [`McpDispatchedCall::complete`] wrote no end.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpCallCompletionError {
    /// The dispatch wrote the end itself, at the session's close.
    #[error("the tool call's end was written at its session's close")]
    Settled,
    /// The call ended without the server's answer and the client is stopping, so the stop caused
    /// the end; the receipt stays in flight.
    #[error("the tool call ended as the tool-server client stopped")]
    ClientStopping,
    /// The end's write failed; the receipt stays in flight.
    #[error(transparent)]
    Write(#[from] WriteError),
}

/// A call the dispatch sent, with its end. Its caller writes the end through [`Self::complete`],
/// or hands it off; dropped, its receipt stays in flight.
#[must_use = "a dispatched call's end is written through `complete` or handed off"]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tool route and the workflow tool step end the calls they dispatch with it"
    )
)]
pub(crate) struct McpDispatchedCall {
    receipt_id: CommandReceiptId,
    end: Result<McpToolCallEnd, McpToolCallError>,
    outcome: CommandOutcome,
    /// The dispatch's own write of the end at the session's close; `None` when the caller
    /// writes it.
    session_close_write: Option<Result<(), WriteError>>,
    receipts: CommandReceiptStore,
    /// Read for its stopping mark when the end is written.
    standing: McpStandingConnection,
}

/// How the race between a sent call and its session's close or its caller's cancel came out.
enum CallRace {
    /// The call ended.
    Ended(Result<McpToolCallEnd, McpToolCallError>),
    /// The session's connections closed, giving this end and outcome.
    SessionClosed(Result<McpToolCallEnd, McpToolCallError>, CommandOutcome),
    /// The client is stopping.
    ClientStopping,
    /// The caller canceled a call the server had not accepted as a task.
    Canceled,
}

impl McpToolDispatch {
    /// A dispatch recording each call in `receipts` and each accepted task's handle through
    /// `recorder`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the one dispatch every tool call goes through"
        )
    )]
    pub(crate) fn new(receipts: CommandReceiptStore, recorder: McpTaskHandleRecorder) -> Self {
        Self { receipts, recorder }
    }

    /// Calls `call`'s tool over `standing`'s live connection: whether the tool takes a task is
    /// read, the receipt recorded and claimed, then the call made, `contact` saying whether a
    /// task's server still answers. The session's close ends the call at once, writing its end;
    /// `cancellation` drops a call the server has not accepted as a task, its end `Canceled`
    /// and outcome unknown, and leaves an accepted task followed to its end.
    ///
    /// Fails, writing nothing, when `cancellation` fires, the session's connections close or the
    /// client stops before the call is sent, when no connection is live, when the server's tools
    /// cannot be read, or when the receipt is not written; and with `ClientStopping`, the receipt
    /// left in flight, when the call ended without the server's answer as the client stopped.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tool route and the workflow tool step call tools through it"
        )
    )]
    pub(crate) async fn call(
        &self,
        standing: &McpStandingConnection,
        call: McpToolCall,
        contact: &watch::Sender<McpTaskContact>,
        cancellation: &CancellationToken,
    ) -> Result<McpDispatchedCall, McpToolDispatchError> {
        // Taken before the marks are read, so a close that marks after the read waits for it.
        let _tracked = standing.track();
        read_marks(standing, cancellation)?;
        let connection = standing
            .current()
            .ok_or(McpToolDispatchError::NotConnected)?;
        let is_task_tool = tokio::select! {
            biased;
            () = standing.closed() => return Err(closed_error(standing)),
            () = cancellation.cancelled() => return Err(McpToolDispatchError::Canceled),
            read = connection.is_task_tool(&call.dispatch.tool_name) => {
                read.map_err(McpToolDispatchError::ToolsRead)?
            }
        };
        // The tools read can take a whole request's wait, so the marks are read again.
        read_marks(standing, cancellation)?;
        let receipt_id = self
            .receipts
            .accept_and_claim(&call.dispatch.command_id, call.run_id, cancellation)
            .await
            .map_err(McpToolDispatchError::Receipt)?;
        let sink = CallHandleSink {
            recorder: &self.recorder,
            handle: Mutex::new(None),
        };
        let race = {
            let mut ending =
                pin!(connection.call_tool(standing, call, is_task_tool, &sink, contact));
            let mut is_following_past_cancel = false;
            loop {
                tokio::select! {
                    biased;
                    end = &mut ending => break CallRace::Ended(end),
                    () = standing.closed() => {
                        if standing.is_stopping() {
                            break CallRace::ClientStopping;
                        }
                        // A plain call is dropped with `ending` below, which tells the server its
                        // request is canceled; a task is canceled first, its follow still held.
                        break match sink.held_handle() {
                            None => CallRace::SessionClosed(
                                Ok(McpToolCallEnd::Canceled),
                                CommandOutcome::Unknown,
                            ),
                            Some((generation, mcp_task_id)) => {
                                let end = Ok(end_at_session_close(
                                    &connection,
                                    generation,
                                    &mcp_task_id,
                                )
                                .await);
                                let outcome = outcome_of(&end);
                                CallRace::SessionClosed(end, outcome)
                            }
                        };
                    }
                    () = cancellation.cancelled(), if !is_following_past_cancel => {
                        if sink.held_handle().is_none() {
                            break CallRace::Canceled;
                        }
                        is_following_past_cancel = true;
                    }
                }
            }
        };
        let (end, outcome, session_close_write) = match race {
            CallRace::Ended(end) => {
                if standing.is_stopping() && !has_server_answer(&end) {
                    return Err(McpToolDispatchError::ClientStopping);
                }
                let outcome = outcome_of(&end);
                (end, outcome, None)
            }
            CallRace::Canceled => (Ok(McpToolCallEnd::Canceled), CommandOutcome::Unknown, None),
            CallRace::ClientStopping => return Err(McpToolDispatchError::ClientStopping),
            CallRace::SessionClosed(end, outcome) => {
                let write = self
                    .receipts
                    .complete_at_session_close(receipt_id, outcome)
                    .await;
                (end, outcome, Some(write))
            }
        };
        Ok(McpDispatchedCall {
            receipt_id,
            end,
            outcome,
            session_close_write,
            receipts: self.receipts.clone(),
            standing: standing.clone(),
        })
    }
}

impl McpDispatchedCall {
    /// Writes the call's end inline and returns it with how the write went: `Settled` when the
    /// dispatch wrote it at the session's close, `ClientStopping` when the end came without the
    /// server's answer as the client stopped, and the store's error, a backgrounded call's
    /// refusal among them, when the write fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tool route and the workflow tool step end the calls they dispatch with it"
        )
    )]
    pub(crate) async fn complete(
        self,
    ) -> (
        Result<McpToolCallEnd, McpToolCallError>,
        Result<(), McpCallCompletionError>,
    ) {
        let written = match self.session_close_write {
            Some(Ok(())) => Err(McpCallCompletionError::Settled),
            Some(Err(error)) => Err(McpCallCompletionError::Write(error)),
            None if self.standing.is_stopping() && !has_server_answer(&self.end) => {
                Err(McpCallCompletionError::ClientStopping)
            }
            None => self
                .receipts
                .complete(self.receipt_id, self.outcome)
                .await
                .map_err(McpCallCompletionError::Write),
        };
        (self.end, written)
    }
}

/// One call's handle sink: it keeps the handle the server accepted the call under, so the
/// session's close can cancel the task, and stores it through the recorder.
struct CallHandleSink<'recorder> {
    recorder: &'recorder McpTaskHandleRecorder,
    handle: Mutex<Option<(McpTaskGeneration, String)>>,
}

impl CallHandleSink<'_> {
    fn held_handle(&self) -> Option<(McpTaskGeneration, String)> {
        lock(&self.handle).clone()
    }
}

impl McpTaskHandleSink for CallHandleSink<'_> {
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()> {
        *lock(&self.handle) = Some((
            observation.mcp_task_generation,
            observation.mcp_task_id.clone(),
        ));
        self.recorder.record(observation)
    }
}

// Fails with the first mark set: the client's stop, the session's close, then the caller's cancel.
fn read_marks(
    standing: &McpStandingConnection,
    cancellation: &CancellationToken,
) -> Result<(), McpToolDispatchError> {
    if standing.is_stopping() || standing.is_closed() {
        return Err(closed_error(standing));
    }
    if cancellation.is_cancelled() {
        return Err(McpToolDispatchError::Canceled);
    }
    Ok(())
}

// The error of a closed standing connection: the stop when the client stops, since its stop
// closes every session, else the session's close.
fn closed_error(standing: &McpStandingConnection) -> McpToolDispatchError {
    if standing.is_stopping() {
        McpToolDispatchError::ClientStopping
    } else {
        McpToolDispatchError::SessionClosed
    }
}

/// The end of task `mcp_task_id` when its session closes: the task is canceled on the still-open
/// connection. A 2025-11-25 server's ack means it was canceled; a 2026-07-28 ack, or a `-32602`
/// on either for a task that ended or that the server no longer knows, is followed by one read of
/// the task. A refused or failed cancel, or a read that gives no end, leaves the end unknown.
async fn end_at_session_close(
    connection: &McpServerConnection,
    generation: McpTaskGeneration,
    mcp_task_id: &str,
) -> McpToolCallEnd {
    let is_read = match connection.cancel_task(generation, mcp_task_id).await {
        Ok(McpTaskCancelOutcome::Taken) => match generation {
            McpTaskGeneration::V1 => return McpToolCallEnd::Canceled,
            McpTaskGeneration::V2 => true,
        },
        Ok(McpTaskCancelOutcome::Refused) => false,
        Err(error) => {
            let is_rejected = matches!(error.poll_failure(), PollFailure::TaskIdRejected { .. });
            if !is_rejected {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    server = connection.scope.server_name.as_str(),
                    "a closing session's tool server task was not canceled; its end is unknown"
                );
            }
            is_rejected
        }
    };
    let end = if is_read {
        connection.read_task_end(generation, mcp_task_id).await
    } else {
        None
    };
    end.unwrap_or(McpToolCallEnd::ConnectionClosed)
}

// Whether the server answered the call: an end it gave, or an error it answered with.
fn has_server_answer(end: &Result<McpToolCallEnd, McpToolCallError>) -> bool {
    match end {
        Ok(McpToolCallEnd::ConnectionClosed) => false,
        Ok(
            McpToolCallEnd::Answered { .. }
            | McpToolCallEnd::Failed { .. }
            | McpToolCallEnd::Canceled
            | McpToolCallEnd::TaskUnknown { .. },
        ) => true,
        Err(error) => !matches!(
            error.poll_failure(),
            PollFailure::ConnectionClosed | PollFailure::NoAnswer
        ),
    }
}

// The receipt's outcome for a call's end: completed when the server answered its result; failed
// when the task failed or was canceled, or the server refused the call or asked what the call
// cannot give; unknown otherwise, the call never run again.
fn outcome_of(end: &Result<McpToolCallEnd, McpToolCallError>) -> CommandOutcome {
    match end {
        Ok(McpToolCallEnd::Answered { .. }) => CommandOutcome::Completed,
        Ok(McpToolCallEnd::Failed { .. } | McpToolCallEnd::Canceled)
        | Err(
            McpToolCallError::Request(McpRequestError::Refused { .. })
            | McpToolCallError::Service(ServiceError::McpError(_))
            | McpToolCallError::UnsupportedInputRequest
            | McpToolCallError::InputRoundsExceeded { .. },
        ) => CommandOutcome::Failed,
        Ok(McpToolCallEnd::TaskUnknown { .. } | McpToolCallEnd::ConnectionClosed)
        | Err(
            McpToolCallError::Request(_)
            | McpToolCallError::Service(_)
            | McpToolCallError::AcceptanceWithoutHandle
            | McpToolCallError::UnexpectedResult,
        ) => CommandOutcome::Unknown,
    }
}
