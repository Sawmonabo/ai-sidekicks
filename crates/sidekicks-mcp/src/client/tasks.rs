//! A tool call that may become a task, on either MCP Tasks protocol: the task's handle goes to the
//! task handle sink before the first poll, so recovery can poll it again; the task is then polled
//! to its end, its questions asked on the questions card and answered back to the server.
//!
//! - A 2025-11-25 server takes a task only on a tool whose `execution.taskSupport` allows it, and
//!   its replies are read raw ([`revision_2025_11_25`]); a 2026-07-28 server decides per call
//!   and is read through rmcp's own types ([`revision_2026_07_28`]).
//! - A task's question is held under its own request id, and its answer goes back to the server
//!   that asked, never to the run's driver.
//! - A question a server's request waits on is taken in its run's turn: asked while its run waits
//!   on something else, it is recorded at once waiting for the run and opened once the run reads
//!   running, first in, first out per run, never answered `cancel` for that reason.
//! - A question nobody waits on any more is withdrawn from the card: one whose task or call is
//!   dropped, or whose request the server canceled.
//! - A task is watched by its session, its server's name and its id, so two sessions whose
//!   servers mint the same id never share a watch.

pub(crate) mod recorder;
mod revision_2025_11_25;
mod revision_2026_07_28;
pub(in crate::client) mod watches;

use std::error::Error;

use futures::future::BoxFuture;
use rmcp::model::ErrorCode;
use rmcp::service::ServiceError;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::run::id::RunId;
use sidekicks_provider::record_readers::read_non_empty_string;
use strum::{EnumString, IntoStaticStr, VariantArray};
use tokio::sync::watch;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::poll::{PollError, PollFailure};
use crate::client::requests::{McpRequestError, RequestWait};
use crate::sign_in::address_digest::ServerAddressDigest;

/// The identity of one MCP tool dispatch. `command_id` is the client-supplied idempotency key on
/// the dispatch's command receipt row; `tool_name` names no stored row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskDispatchIdentity {
    /// The dispatch's idempotency key.
    pub(crate) command_id: String,
    /// The tool called.
    pub(crate) tool_name: String,
}

/// Which MCP Tasks protocol a task handle belongs to, stored beside the handle so recovery polls
/// it the way its server answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, EnumString, IntoStaticStr, VariantArray)]
#[strum(serialize_all = "lowercase")]
pub(crate) enum McpTaskGeneration {
    /// A task on a 2025-11-25 server, whose result `tasks/result` reads.
    V1,
    /// A task on a 2026-07-28 server, whose result `tasks/get` carries inline.
    V2,
}

/// Which server a task was accepted on, so a task is resumed only on that server: a stdio
/// server, or a server at an address by its keyed digest, the one its sign-in is kept under, so
/// no row lets a guessed address be confirmed without the key. One server spelled two ways is one
/// endpoint, and a changed header or token does not change it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServerEndpoint(String);

impl McpServerEndpoint {
    /// The endpoint of every stdio server.
    pub(crate) const STDIO: &str = "stdio";
    /// What an address endpoint starts with, before its digest.
    pub(crate) const ADDRESS_PREFIX: &str = "address:";
    /// The length of an address endpoint's digest, in lowercase hex digits.
    pub(crate) const ADDRESS_DIGEST_HEX_LEN: usize = 64;

    /// A stdio server's endpoint.
    pub(crate) fn stdio() -> Self {
        Self(Self::STDIO.to_owned())
    }

    /// The endpoint of the server whose address has `digest`: the prefix, then the digest.
    pub(crate) fn at_address(digest: &ServerAddressDigest) -> Self {
        Self(format!("{}{}", Self::ADDRESS_PREFIX, digest.as_str()))
    }

    /// The endpoint as a receipt row stores it, whose form the table's check holds, so it is not
    /// checked again.
    pub(crate) fn from_stored(text: String) -> Self {
        Self(text)
    }

    /// The endpoint as stored.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the server is reached at an address, so a closed connection to it can be replaced
    /// by a Reconnect; a stdio server's task dies with its process.
    pub(crate) fn is_address(&self) -> bool {
        self.0.starts_with(Self::ADDRESS_PREFIX)
    }
}

/// Why a recorded task's follow is resumed, which decides how a 2025-11-25 task waiting on input
/// goes on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskResumption {
    /// On the connection a Reconnect put in place of the one the follow was on: the task's watch,
    /// with the question kept for the server's next ask, is adopted.
    AfterReconnect,
    /// After the daemon's restart, whose start withdrew the task's questions: a 2025-11-25 task
    /// its first answered poll reads waiting on input is canceled before anything is held.
    AfterRestart,
}

/// A dispatch whose acceptance carried a receiver-generated task id, ready to be recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskHandleObservation {
    /// The dispatch the handle belongs to.
    pub(crate) dispatch: McpTaskDispatchIdentity,
    /// The task id the receiver generated.
    pub(crate) mcp_task_id: String,
    /// The protocol of the server that accepted the task.
    pub(crate) mcp_task_generation: McpTaskGeneration,
    /// The name of the server that accepted the task.
    pub(crate) server_name: McpServerName,
    /// Which server accepted the task, so it is resumed only there.
    pub(crate) endpoint: McpServerEndpoint,
}

/// Where an observed task handle lands: the task handle recorder, which stores it on the
/// dispatch's command receipt row.
pub(crate) trait McpTaskHandleSink: Send + Sync {
    /// Records `observation`; resolves once it is stored or diagnosed, since a store failure
    /// cannot fail a turn.
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()>;
}

/// The `task.taskId` of an untrusted 2025-11-25 acceptance result; `None` for anything but a
/// non-empty string there, never an invented handle.
pub(crate) fn extract_mcp_task_id(acceptance_result: &Map<String, Value>) -> Option<&str> {
    read_non_empty_string(acceptance_result.get("task")?.as_object()?, "taskId")
}

/// Hands `sink` the handle `mcp_task_id` a server accepted the dispatch under, with the
/// generation of the server that sent it and `connection`'s server name and endpoint, and resolves
/// once the sink has settled it.
pub(crate) async fn observe_mcp_task_acceptance(
    sink: &dyn McpTaskHandleSink,
    connection: &McpServerConnection,
    dispatch: McpTaskDispatchIdentity,
    mcp_task_generation: McpTaskGeneration,
    mcp_task_id: &str,
) {
    sink.record(McpTaskHandleObservation {
        dispatch,
        mcp_task_id: mcp_task_id.to_owned(),
        mcp_task_generation,
        server_name: connection.scope.server_name.clone(),
        endpoint: connection.task_endpoint().clone(),
    })
    .await;
}

/// One tool call, with the run its questions are asked in, in its connection's session.
#[derive(Clone, Debug)]
pub(crate) struct McpToolCall {
    /// The dispatch.
    pub(crate) dispatch: McpTaskDispatchIdentity,
    /// The call's arguments.
    pub(crate) arguments: Option<Map<String, Value>>,
    /// The run that calls.
    pub(crate) run_id: RunId,
}

/// How a tool call ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum McpToolCallEnd {
    /// The server's `CallToolResult`, as it sent it.
    Answered {
        /// The result.
        result: Map<String, Value>,
    },
    /// The task failed with this JSON-RPC error.
    Failed {
        /// The error object.
        error: Map<String, Value>,
    },
    /// The task was canceled.
    Canceled,
    /// The server can no longer give the task's end, as a permanent error said, so the outcome
    /// is unknown.
    TaskUnknown {
        /// The JSON-RPC error object that said so, as sent.
        error: Map<String, Value>,
    },
    /// The connection closed under the follow, and the task may run on, so the dispatch binds it
    /// to a new connection or reads its end unknown.
    ConnectionClosed,
    /// The task waited on input its server did not ask for again in the 300 s after a re-bind, or
    /// that the daemon's restart withdrew, and was canceled, so its outcome is unknown.
    InputLost,
}

/// What a server did with a request to cancel a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskCancelOutcome {
    /// The server took the cancel, and the task's poll reads where it ended.
    Taken,
    /// The server cancels no task: it declares no `tasks.cancel`, so nothing was sent, or it
    /// answered `-32601`. The task runs on, and its follow goes on.
    Refused,
}

/// Whether a followed task's server still reads the task, and why not when it does not: no
/// answer, an error answer, a refused sign-in or a rejected task id, each also read once it has
/// stood for 300 s. A failed poll that says why replaces the cause that stood, and the task is
/// left alone either way. A standing arm says what the task did and holds to the end in place of
/// `Reached`: a poll's cause shows over it while that cause holds, and an answered poll restores
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskContact {
    /// A poll read the task, and no failed poll since said why it could not.
    Reached,
    /// No poll read the task or answered `-32602` for 300 s; until one does.
    Lost,
    /// The server answered a poll with an error; until a poll reads the task or answers `-32602`,
    /// or `ErrorsPersisted` 300 s after the last that did.
    AnsweredWithErrors,
    /// The server refused the poll's sign-in; until a poll reads the task or answers `-32602`, or
    /// `SignInNotAccepted` 300 s after the last that did.
    NeedsSignIn,
    /// The server answered `-32602`, rejecting the task's id, inside the grace; until a poll reads
    /// the task, another failure says why, or `Lost` 300 s after the last `-32602`.
    TaskIdRejected,
    /// No sign-in was accepted in the 300 s since a poll last read the task or answered `-32602`;
    /// until one does.
    SignInNotAccepted,
    /// The polls came back with errors for the 300 s since one last read the task or answered
    /// `-32602`; until one does.
    ErrorsPersisted,
    /// The task's connection closed and no connection to its server is live in the session, as
    /// when the server was removed or disabled; until a connection of the task's endpoint
    /// replaces it.
    NotConfigured,
    /// The task's connection closed and the session's connection to its server now reaches
    /// another address; until a connection of the task's endpoint replaces it.
    Reconfigured,
    /// A 2025-11-25 task re-bound with a question kept did not ask it again: another status or
    /// form came first, or its bound ran out; a standing arm.
    DidNotAskAgain {
        /// Whether an answer the person gave was kept and withdrawn undelivered.
        has_undelivered_answer: bool,
    },
    /// The server refused to cancel the task, which runs on and is followed to its end; a
    /// standing arm.
    CancelRefused {
        /// Whether the cancel was the person's or the agent's stop, which the row reads as refused,
        /// rather than the cancel of a task the restart found waiting on input.
        is_from_stop: bool,
    },
}

impl McpTaskContact {
    /// Whether this arm says what the task did, so it holds to the follow's end in place of
    /// `Reached`, the latest written winning.
    pub(crate) fn is_standing(self) -> bool {
        matches!(
            self,
            Self::DidNotAskAgain { .. } | Self::CancelRefused { .. }
        )
    }
}

/// Why a tool call has no end.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpToolCallError {
    /// A request the client reads raw failed.
    #[error(transparent)]
    Request(#[from] McpRequestError),
    /// A request through rmcp's own types failed.
    #[error("the tool server did not answer the call")]
    Service(#[source] ServiceError),
    /// The server accepted the call as a task but named no task.
    #[error("the tool server accepted the call as a task without naming the task")]
    AcceptanceWithoutHandle,
    /// The server asked the call for input the client does not take, such as sampling.
    #[error("the tool server asked for input the client does not take")]
    UnsupportedInputRequest,
    /// The server asked for input more rounds than a call drives.
    #[error("the tool server asked for input more than {max_rounds} times")]
    InputRoundsExceeded {
        /// The rounds a call drives.
        max_rounds: usize,
    },
    /// The server answered the call with a result of another request.
    #[error("the tool server answered the call with another request's result")]
    UnexpectedResult,
}

impl McpServerConnection {
    /// Calls a tool and follows it to its end: a task's handle reaches `sink` before the first
    /// poll, `contact` says whether its server still answers, and its questions, like any the
    /// call asks outside a task, are asked in the call's session and run. A 2026-07-28 task's
    /// answers go over `standing`'s live connection, so one given after a Reconnect reaches the
    /// new connection. The caller reads `is_task_tool` first, before anything is recorded, and
    /// passes its answer. Fails as the call or the acceptance fails.
    pub(crate) async fn call_tool(
        &self,
        standing: &McpStandingConnection,
        call: McpToolCall,
        is_task_tool: bool,
        sink: &dyn McpTaskHandleSink,
        contact: &watch::Sender<McpTaskContact>,
    ) -> Result<McpToolCallEnd, McpToolCallError> {
        // Dropped, never awaited, once the call ends: nothing then waits between a follow cut by
        // the connection's close leaving its task's watch and the re-bind adopting it.
        let in_flight = self.calls.track(&call, &self.scope);
        if is_task_tool {
            revision_2025_11_25::call_task_tool(self, call, sink, contact).await
        } else {
            revision_2026_07_28::call_tool(self, standing, &in_flight, call, sink, contact).await
        }
    }

    /// Follows run `run_id`'s recorded task `mcp_task_id`, accepted under `mcp_task_generation`,
    /// to its end, as `resumption` says: polled at once, `contact` saying whether its server
    /// answers, and a 2026-07-28 task's answers going over `standing`'s live connection. The watch
    /// a follow cut by an earlier connection's close left is adopted with its questions and asked
    /// keys; else its questions are asked anew in the run's session and run. Never fails: a failed
    /// poll is polled again or read as the end it says.
    pub(crate) async fn resume_task(
        &self,
        standing: &McpStandingConnection,
        run_id: RunId,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
        resumption: McpTaskResumption,
        contact: &watch::Sender<McpTaskContact>,
    ) -> McpToolCallEnd {
        match mcp_task_generation {
            McpTaskGeneration::V1 => {
                revision_2025_11_25::follow_task(
                    self,
                    run_id,
                    mcp_task_id,
                    Some(resumption),
                    contact,
                )
                .await
            }
            McpTaskGeneration::V2 => {
                revision_2026_07_28::follow_task(self, standing, run_id, mcp_task_id, contact).await
            }
        }
    }

    /// Asks the server to cancel task `mcp_task_id`, in the protocol of the `mcp_task_generation`
    /// it was accepted under: `Taken` when the server took it, and the task's poll then reads its
    /// end. `Refused`, with the task's follow going on, when the server declares no
    /// `tasks.cancel`, so nothing is sent, or answers `-32601` on either protocol. Fails as the
    /// request fails otherwise, a `-32602` for a task that ended or that the server does not know
    /// included.
    pub(crate) async fn cancel_task(
        &self,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
    ) -> Result<McpTaskCancelOutcome, McpToolCallError> {
        if !self.can_cancel_tasks {
            return Ok(McpTaskCancelOutcome::Refused);
        }
        match mcp_task_generation {
            McpTaskGeneration::V1 => match self
                .requests
                .send_raw(
                    "tasks/cancel",
                    Some(serde_json::json!({ "taskId": mcp_task_id })),
                    RequestWait::Ordinary,
                )
                .await
            {
                Ok(_) => Ok(McpTaskCancelOutcome::Taken),
                Err(McpRequestError::Refused { code, .. })
                    if code == i64::from(ErrorCode::METHOD_NOT_FOUND.0) =>
                {
                    Ok(McpTaskCancelOutcome::Refused)
                }
                Err(error) => Err(error.into()),
            },
            McpTaskGeneration::V2 => match self.requests.cancel_v2_task(mcp_task_id).await {
                Ok(()) => Ok(McpTaskCancelOutcome::Taken),
                Err(ServiceError::McpError(error)) if error.code == ErrorCode::METHOD_NOT_FOUND => {
                    Ok(McpTaskCancelOutcome::Refused)
                }
                Err(error) => Err(McpToolCallError::Service(error)),
            },
        }
    }

    /// The end of task `mcp_task_id`, accepted under `mcp_task_generation`, from one read of it: a
    /// terminal status read as the task's follow reads it, a 2025-11-25 result through
    /// `tasks/result`. `None`, the end unknown, for any other status or a failed read, which is
    /// logged.
    pub(crate) async fn read_task_end(
        &self,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
    ) -> Option<McpToolCallEnd> {
        let read: Result<_, Box<dyn Error + Send + Sync>> = match mcp_task_generation {
            McpTaskGeneration::V1 => revision_2025_11_25::read_task_end(self, mcp_task_id)
                .await
                .map_err(Into::into),
            McpTaskGeneration::V2 => revision_2026_07_28::read_task_end(self, mcp_task_id)
                .await
                .map_err(Into::into),
        };
        read.unwrap_or_else(|error| {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                server = self.scope.server_name.as_str(),
                "a tool server task's end could not be read; it reads unknown"
            );
            None
        })
    }
}

impl PollError for McpToolCallError {
    fn poll_failure(&self) -> PollFailure {
        match self {
            Self::Request(error) => error.poll_failure(),
            Self::Service(error) => error.poll_failure(),
            // The server answered, with something the call cannot take.
            Self::AcceptanceWithoutHandle
            | Self::UnsupportedInputRequest
            | Self::InputRoundsExceeded { .. }
            | Self::UnexpectedResult => PollFailure::ErrorAnswer,
        }
    }
}
