//! The tool call's dispatch, one per daemon: a call's receipt is recorded and claimed before the
//! call is sent, the task the server accepts it as is stored on that receipt before its first
//! poll, and every wait races the session's close and the caller's cancel.
//!
//! - The dispatch writes a call's end only when the session's close reaches the call: a plain
//!   call is dropped, which tells the server it is canceled, and its end is unknown; a task is
//!   canceled on the still-open connection and its end read once, within two requests' bounds,
//!   or its end is unknown at once when the server refused the caller's cancel already; a task
//!   waiting for its connection's replacement reads unknown. The caller writes every other end
//!   through [`McpDispatchedCall::complete`], or hands it off, the unknown end of a caller's
//!   cancel during that wait included.
//! - The caller's cancel asks the server to cancel an accepted task beside its follow, which goes
//!   on to the end the server gives: `failed` after `cancelled`, `completed` when the result came
//!   first, and on through a refused or failed cancel.
//! - A task on a server at an address whose connection closes under its follow is re-bound to the
//!   connection a Reconnect puts in its place, and a receipt the restart left in flight is resumed
//!   through the same race ([`resume`]).
//! - An end without the server's answer while the client stops came from the stop, so nothing is
//!   written and the receipt stays in flight.

pub mod restart_sweep;
mod resume;
pub mod workflow_step;

use std::pin::pin;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rmcp::service::ServiceError;
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::poll::{PollError as _, PollFailure};
use crate::client::requests::{McpRequestError, ORDINARY_REQUEST_TIMEOUT};
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
pub struct McpToolDispatch {
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
    #[error("the tool call's end was written by its dispatch")]
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
pub(crate) struct McpDispatchedCall {
    receipt_id: CommandReceiptId,
    end: Result<McpToolCallEnd, McpToolCallError>,
    outcome: CommandOutcome,
    /// The dispatch's own write of the end, at the session's close; `None` when the caller writes
    /// it.
    settled_write: Option<Result<(), WriteError>>,
    receipts: CommandReceiptStore,
    /// Read for its stopping mark when the end is written.
    standing: McpStandingConnection,
}

/// How the race between a sent call and its session's close or its caller's cancel came out.
enum CallRace {
    /// The call ended.
    Ended(Result<McpToolCallEnd, McpToolCallError>),
    /// The dispatch writes this end and outcome itself: the session's connections closed.
    Settled(Result<McpToolCallEnd, McpToolCallError>, CommandOutcome),
    /// The client is stopping.
    ClientStopping,
    /// The caller canceled a call the server had not accepted as a task.
    Canceled,
}

/// What the caller's cancel came to.
enum CallerCancel {
    /// No task was held, so the call is dropped.
    Unaccepted,
    /// The held task was asked to cancel beside its follow.
    Sent {
        /// Whether the server refused the cancel.
        is_refused: bool,
    },
}

impl McpToolDispatch {
    /// A dispatch recording each call's receipt and each accepted task's handle through
    /// `writer`.
    pub fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self {
            receipts: CommandReceiptStore::new(Arc::clone(&writer)),
            recorder: McpTaskHandleRecorder::new(writer),
        }
    }

    /// Calls `call`'s tool over `standing`'s live connection: whether the tool takes a task is
    /// read, the receipt recorded and claimed, then the call made, `contact` saying whether a
    /// task's server still answers. The session's close ends the call at once, writing its end;
    /// `cancellation` drops a call the server has not accepted as a task, its end `Canceled`
    /// and outcome unknown, and asks the server to cancel an accepted task, which is followed to
    /// its end, `contact` reading `CancelRefused` when the server refuses. A task on a server at
    /// an address whose connection closes is followed on over the connection that replaces it;
    /// the session's close during that wait writes its end unknown, and `cancellation` ends it
    /// unknown for the caller to write.
    ///
    /// Fails, writing nothing, when `cancellation` fires, the session's connections close or the
    /// client stops before the call is sent, when no connection is live, when the server's tools
    /// cannot be read, or when the receipt is not written; and with `ClientStopping`, the receipt
    /// left in flight, when the call ended without the server's answer as the client stopped.
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
        // The connection the task is followed on, which a re-bind moves to the replacement.
        let following = Mutex::new(Arc::clone(&connection));
        let ending = async {
            let end = connection
                .call_tool(standing, call.clone(), is_task_tool, &sink, contact)
                .await;
            match sink.held_handle() {
                Some(handle) => {
                    resume::follow_across_reconnects(
                        standing,
                        call.run_id,
                        handle,
                        end,
                        &following,
                        contact,
                        cancellation,
                    )
                    .await
                }
                None => CallRace::Ended(end),
            }
        };
        // Boxed, so the race, which holds the call and its follow, is kept off the caller's future.
        let race = Box::pin(race_call(
            standing,
            &sink,
            &following,
            ending,
            contact,
            cancellation,
        ))
        .await;
        self.end_dispatch(standing, receipt_id, race).await
    }

    /// The dispatched call of receipt `receipt_id` from how its race came out: an end the dispatch
    /// writes is written here. Fails with `ClientStopping`, writing nothing, when the client's stop
    /// ended the call.
    async fn end_dispatch(
        &self,
        standing: &McpStandingConnection,
        receipt_id: CommandReceiptId,
        race: CallRace,
    ) -> Result<McpDispatchedCall, McpToolDispatchError> {
        let (end, outcome, settled_write) = match race {
            CallRace::Ended(end) => {
                if standing.is_stopping() && !has_server_answer(&end) {
                    return Err(McpToolDispatchError::ClientStopping);
                }
                let outcome = outcome_of(&end);
                (end, outcome, None)
            }
            CallRace::Canceled => (Ok(McpToolCallEnd::Canceled), CommandOutcome::Unknown, None),
            CallRace::ClientStopping => return Err(McpToolDispatchError::ClientStopping),
            CallRace::Settled(end, outcome) => {
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
            settled_write,
            receipts: self.receipts.clone(),
            standing: standing.clone(),
        })
    }
}

/// Races `ending`, a sent call's end on `following`'s connection, against the session's close and
/// the caller's cancel. The close drops a call the server has not accepted as a task, which tells
/// the server it is canceled, and cancels an accepted one on the connection followed, its end read
/// once. The cancel drops a call with no task too, and asks the server to cancel an accepted task
/// beside its follow, which goes on.
async fn race_call(
    standing: &McpStandingConnection,
    sink: &CallHandleSink<'_>,
    following: &Mutex<Arc<McpServerConnection>>,
    ending: impl Future<Output = CallRace>,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> CallRace {
    let mut ending = pin!(ending);
    // The caller's cancel: a call the server has not accepted as a task is dropped; an accepted
    // task is asked to cancel beside its follow, which goes on.
    let mut caller_cancel = pin!(async {
        cancellation.cancelled().await;
        let Some((generation, mcp_task_id)) = sink.held_handle() else {
            return CallerCancel::Unaccepted;
        };
        let followed = Arc::clone(&lock(following));
        // Boxed, so the request's future is held only once a task is canceled.
        let is_refused = Box::pin(cancel_followed_task(
            &followed,
            generation,
            &mcp_task_id,
            contact,
        ))
        .await;
        CallerCancel::Sent { is_refused }
    });
    let mut is_cancel_sent = false;
    let mut is_cancel_refused = false;
    loop {
        tokio::select! {
            biased;
            race = &mut ending => return race,
            () = standing.closed() => {
                if standing.is_stopping() {
                    return CallRace::ClientStopping;
                }
                // A plain call is dropped with `ending`, which tells the server its request is
                // canceled; a task is canceled first, its follow still held, unless the server
                // refused the caller's cancel already, which leaves its end unknown.
                return match sink.held_handle() {
                    None => {
                        CallRace::Settled(Ok(McpToolCallEnd::Canceled), CommandOutcome::Unknown)
                    }
                    Some(_) if is_cancel_refused => CallRace::Settled(
                        Ok(McpToolCallEnd::ConnectionClosed),
                        CommandOutcome::Unknown,
                    ),
                    Some((generation, mcp_task_id)) => {
                        let followed = Arc::clone(&lock(following));
                        let ending =
                            pin!(end_at_session_close(&followed, generation, &mcp_task_id));
                        // The cancel and one read of the task: two requests' bounds at most.
                        let end = wait_within(ending, 2 * ORDINARY_REQUEST_TIMEOUT, None)
                            .await
                            .unwrap_or_else(|| {
                                tracing::warn!(
                                    server = followed.scope.server_name.as_str(),
                                    "a closing session's tool server task was not read in time; \
                                     its end is unknown"
                                );
                                McpToolCallEnd::ConnectionClosed
                            });
                        let end = Ok(end);
                        let outcome = outcome_of(&end);
                        CallRace::Settled(end, outcome)
                    }
                };
            }
            cancel = &mut caller_cancel, if !is_cancel_sent => match cancel {
                CallerCancel::Unaccepted => return CallRace::Canceled,
                CallerCancel::Sent { is_refused } => {
                    is_cancel_sent = true;
                    is_cancel_refused = is_refused;
                }
            },
        }
    }
}

impl McpDispatchedCall {
    /// Writes the call's end inline and returns it with how the write went: `Settled` when the
    /// dispatch wrote it itself, `ClientStopping` when the end came without the server's answer
    /// as the client stopped, and the store's error, a backgrounded call's refusal among them,
    /// when the write fails.
    pub(crate) async fn complete(
        self,
    ) -> (
        Result<McpToolCallEnd, McpToolCallError>,
        Result<(), McpCallCompletionError>,
    ) {
        let written = match self.settled_write {
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

/// Asks the server to cancel the followed task `mcp_task_id` at its caller's cancel, its follow
/// going on to the end the server gives; true when the server refused, which takes
/// `CancelRefused` as the task's standing arm on `contact`. A failed cancel is logged, at debug
/// for a `-32602`, a task that ended already. A task resumed after a restart then owes its follow
/// no cancel of its own.
async fn cancel_followed_task(
    connection: &McpServerConnection,
    generation: McpTaskGeneration,
    mcp_task_id: &str,
    contact: &watch::Sender<McpTaskContact>,
) -> bool {
    connection
        .scope
        .task_watches
        .settle_restart_cancel(&connection.scope, mcp_task_id);
    match connection.cancel_task(generation, mcp_task_id).await {
        Ok(McpTaskCancelOutcome::Taken) => false,
        Ok(McpTaskCancelOutcome::Refused) => {
            connection.scope.task_watches.write_standing_arm(
                &connection.scope,
                mcp_task_id,
                contact,
                McpTaskContact::CancelRefused { is_from_stop: true },
            );
            true
        }
        Err(error) => {
            if is_ended_task(&error) {
                tracing::debug!(
                    server = connection.scope.server_name.as_str(),
                    "a canceled tool server task had ended already; its follow reads its end"
                );
            } else {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    server = connection.scope.server_name.as_str(),
                    "a canceled tool server task was not canceled on its server; its follow goes on"
                );
            }
            false
        }
    }
}

// Whether a cancel failed with `-32602`: the task ended already, or the server no longer knows it.
fn is_ended_task(error: &McpToolCallError) -> bool {
    matches!(error.poll_failure(), PollFailure::TaskIdRejected { .. })
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
        Err(error) if is_ended_task(&error) => {
            tracing::debug!(
                server = connection.scope.server_name.as_str(),
                "a closing session's tool server task had ended already; it is read once"
            );
            true
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                server = connection.scope.server_name.as_str(),
                "a closing session's tool server task was not canceled; its end is unknown"
            );
            false
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
            | McpToolCallEnd::TaskUnknown { .. }
            | McpToolCallEnd::InputLost,
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
        Ok(
            McpToolCallEnd::TaskUnknown { .. }
            | McpToolCallEnd::ConnectionClosed
            | McpToolCallEnd::InputLost,
        )
        | Err(
            McpToolCallError::Request(_)
            | McpToolCallError::Service(_)
            | McpToolCallError::AcceptanceWithoutHandle
            | McpToolCallError::UnexpectedResult,
        ) => CommandOutcome::Unknown,
    }
}
