//! A tool call that may become a task, on either MCP Tasks protocol: the task's handle goes to the
//! task handle sink before the first poll, so recovery can poll it instead of halting the call;
//! the task is then polled to its end, its questions asked on the questions card and answered
//! back to the server.
//!
//! - A 2025-11-25 server takes a task only on a tool whose `execution.taskSupport` allows it, and
//!   its replies are read raw ([`v1`]); a 2026-07-28 server decides per call and is read through
//!   rmcp's own types ([`v2`]).
//! - A task's question is held under its own request id, and its answer goes back to the server
//!   that asked, never to the run's driver.

pub(crate) mod recorder;
mod v1;
mod v2;

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rmcp::service::ServiceError;
use serde_json::{Map, Value};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use strum::{IntoStaticStr, VariantArray};
use tokio::sync::{Notify, oneshot};

use crate::mcp::client::connection::{McpConnectionScope, McpRequestError, McpServerConnection};
use crate::mcp::elicitation_form::{compose_elicitation_content, read_elicitation_questions};
use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionPort, ToolServerQuestionAnswer,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::record_readers::read_non_empty_string;

/// The identity of one task-augmented MCP dispatch. `command_id` is the client-supplied
/// idempotency key on the dispatch's command receipt row; the server and tool name no stored row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskDispatchIdentity {
    /// The dispatch's idempotency key.
    pub(crate) command_id: String,
    /// The tool server the call went to.
    pub(crate) server_name: String,
    /// The tool called.
    pub(crate) tool_name: String,
}

/// Which MCP Tasks protocol a task handle belongs to, stored beside the handle so recovery polls
/// it the way its server answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr, VariantArray)]
#[strum(serialize_all = "lowercase")]
pub(crate) enum McpTaskGeneration {
    /// A task on a 2025-11-25 server, whose result `tasks/result` reads.
    V1,
    /// A task on a 2026-07-28 server, whose result `tasks/get` carries inline.
    V2,
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
/// generation of the server that sent it, and resolves once the sink has settled it.
pub(crate) async fn observe_mcp_task_acceptance(
    sink: &dyn McpTaskHandleSink,
    dispatch: McpTaskDispatchIdentity,
    mcp_task_generation: McpTaskGeneration,
    mcp_task_id: &str,
) {
    sink.record(McpTaskHandleObservation {
        dispatch,
        mcp_task_id: mcp_task_id.to_owned(),
        mcp_task_generation,
    })
    .await;
}

/// One tool call, with the session and run a task's questions are asked in.
#[derive(Clone, Debug)]
pub(crate) struct McpToolCall {
    /// The dispatch.
    pub(crate) dispatch: McpTaskDispatchIdentity,
    /// The call's arguments.
    pub(crate) arguments: Option<Map<String, Value>>,
    /// The session.
    pub(crate) session_id: SessionId,
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
    Canceled {},
    /// Five polls in a row failed; the handle stays recorded for recovery.
    Halted {
        /// The task's handle.
        mcp_task_id: String,
    },
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
    /// The server asked for input before materializing a task, a round the client does not take.
    #[error("the tool server asked for input before accepting the call")]
    InputRequiredBeforeTask,
    /// The server answered the call with a result of another request.
    #[error("the tool server answered the call with another request's result")]
    UnexpectedResult,
}

impl McpServerConnection {
    /// Calls a tool and follows it to its end: a task's handle reaches `sink` before the first
    /// poll, and its questions are asked in the call's session and run. Fails as the call or the
    /// acceptance fails; a task whose polls fail five times in a row ends `Halted`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      call tools through it"
        )
    )]
    pub(crate) async fn call_tool(
        &self,
        call: McpToolCall,
        sink: &dyn McpTaskHandleSink,
    ) -> Result<McpToolCallEnd, McpToolCallError> {
        if self.task_generation == Some(McpTaskGeneration::V1)
            && self.is_task_tool(&call.dispatch.tool_name).await?
        {
            return v1::call_task_tool(self, call, sink).await;
        }
        v2::call_tool(self, call, sink).await
    }

    /// Asks the server to cancel task `mcp_task_id`, in the protocol of the `mcp_task_generation`
    /// it was accepted under; the task's poll then reads its end. Fails as the request fails.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, cancel \
                  a stopped run's tasks through it"
    )]
    pub(crate) async fn cancel_task(
        &self,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
    ) -> Result<(), McpToolCallError> {
        match mcp_task_generation {
            McpTaskGeneration::V1 => {
                self.send_raw(
                    "tasks/cancel",
                    Some(serde_json::json!({ "taskId": mcp_task_id })),
                )
                .await?;
            }
            McpTaskGeneration::V2 => self
                .peer()
                .cancel_task(rmcp::model::CancelTaskParams::new(mcp_task_id))
                .await
                .map_err(McpToolCallError::Service)?,
        }
        Ok(())
    }
}

/// The tasks a client follows, across its connections: each one's early-poll wake and the
/// session and run its questions are asked in.
pub(crate) struct TaskWatches {
    questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    watched: Mutex<HashMap<(String, String), WatchedTask>>,
    /// Numbers each question a task asks, so its request id is never another's.
    next_question: AtomicU64,
}

struct WatchedTask {
    wake: Arc<Notify>,
    session_id: SessionId,
    run_id: RunId,
    /// The request ids of the task's questions still open on the card.
    open_questions: Vec<String>,
}

/// One task while it is followed; dropping it stops following, and [`Self::finish`] also
/// withdraws its questions still open.
pub(super) struct TaskWatch<'watches> {
    watches: &'watches TaskWatches,
    key: (String, String),
    pub(super) wake: Arc<Notify>,
}

/// What a task question came to.
pub(super) enum TaskQuestionAnswer {
    /// The person answered; the form's content.
    Answered(Map<String, Value>),
    /// The question was withdrawn before an answer.
    Withdrawn,
}

impl TaskWatches {
    /// Watches asking each task's questions through `questions`.
    pub(crate) fn new(questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>) -> Self {
        Self {
            questions,
            watched: Mutex::new(HashMap::new()),
            next_question: AtomicU64::new(1),
        }
    }

    /// Follows `mcp_task_id` on `scope`'s server for `call`'s session and run.
    pub(super) fn watch(
        &self,
        scope: &McpConnectionScope,
        call: &McpToolCall,
        mcp_task_id: &str,
    ) -> TaskWatch<'_> {
        let key = (
            scope.server_name.as_str().to_owned(),
            mcp_task_id.to_owned(),
        );
        let wake = Arc::new(Notify::new());
        self.lock().insert(
            key.clone(),
            WatchedTask {
                wake: Arc::clone(&wake),
                session_id: call.session_id,
                run_id: call.run_id,
                open_questions: Vec::new(),
            },
        );
        TaskWatch {
            watches: self,
            key,
            wake,
        }
    }

    /// Wakes the poll of `mcp_task_id` on any server early, as a status notification asks; the
    /// poll still decides the task's state.
    pub(super) fn wake(&self, mcp_task_id: &str) {
        for ((_, task_id), watched) in self.lock().iter() {
            if task_id == mcp_task_id {
                watched.wake.notify_one();
            }
        }
    }

    /// Asks the elicitation `params` a 2025-11-25 task sent during its `tasks/result`, and waits
    /// for the person's answer. `None` when the client follows no such task on the server.
    pub(super) async fn ask_v1_task_question(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: Value,
    ) -> Option<TaskQuestionAnswer> {
        let (sender, answered) = oneshot::channel();
        let answer = Arc::new(V1TaskAnswer {
            params: params.clone(),
            sender: Mutex::new(Some(sender)),
        });
        if !self.ask(scope, mcp_task_id, &params, answer).await? {
            return Some(TaskQuestionAnswer::Withdrawn);
        }
        Some(match answered.await {
            Ok(content) => TaskQuestionAnswer::Answered(content),
            Err(_withdrawn) => TaskQuestionAnswer::Withdrawn,
        })
    }

    /// Hands the card one question of `scope`'s task `mcp_task_id`, answered through `answer`.
    /// `None` when the task is not followed; `Some(false)` when the card could not take it, which
    /// is logged.
    pub(super) async fn ask(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: &Value,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) -> Option<bool> {
        let key = (
            scope.server_name.as_str().to_owned(),
            mcp_task_id.to_owned(),
        );
        let number = self.next_question.fetch_add(1, Ordering::Relaxed);
        let request_id = format!("mcp-task:{}:{mcp_task_id}:{number}", key.0);
        let (session_id, run_id) = {
            let mut watched = self.lock();
            let task = watched.get_mut(&key)?;
            task.open_questions.push(request_id.clone());
            (task.session_id, task.run_id)
        };
        let header = NonEmptyText::new(scope.server_name.as_str().to_owned());
        let question = ProviderQuestion {
            session_id,
            run_id,
            request_id,
            questions: read_elicitation_questions(params, header),
            is_agent_waiting: true,
        };
        // Until the card's intake is registered, the question stays pending at the server.
        let Some(port) = self.questions.port() else {
            return Some(true);
        };
        if let Err(error) = port.take_tool_server_question(question, answer).await {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                server = scope.server_name.as_str(),
                "the questions card did not take a tool server task's question"
            );
            return Some(false);
        }
        Some(true)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<(String, String), WatchedTask>> {
        self.watched.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl TaskWatch<'_> {
    /// Stops following the task, withdrawing each of its questions still open on the card.
    pub(super) async fn finish(self) {
        let removed = self.watches.lock().remove(&self.key);
        let (Some(task), Some(port)) = (removed, self.watches.questions.port()) else {
            return;
        };
        for request_id in task.open_questions {
            let withdrawal = ProviderQuestionWithdrawal {
                session_id: task.session_id,
                request_id,
            };
            if let Err(error) = port.withdraw_question(withdrawal).await {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    "a finished tool server task's question was not withdrawn"
                );
            }
        }
    }
}

impl Drop for TaskWatch<'_> {
    fn drop(&mut self) {
        self.watches.lock().remove(&self.key);
    }
}

/// The answer to a 2025-11-25 task's question: the `elicitation/create` reply the server's
/// request waits on.
struct V1TaskAnswer {
    params: Value,
    sender: Mutex<Option<oneshot::Sender<Map<String, Value>>>>,
}

impl ToolServerQuestionAnswer for V1TaskAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let sent = match sender {
            Some(sender) => sender
                .send(content)
                .map_err(|_unsent| "the tool server's request no longer waits".into()),
            None => Err("the question was answered already".into()),
        };
        async move { sent }.boxed()
    }
}
