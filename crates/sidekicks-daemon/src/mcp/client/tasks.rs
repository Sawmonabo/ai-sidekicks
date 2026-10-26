//! A tool call that may become a task, on either MCP Tasks protocol: the task's handle goes to the
//! task handle sink before the first poll, so recovery can poll it again; the task is then polled
//! to its end, its questions asked on the questions card and answered back to the server.
//!
//! - A 2025-11-25 server takes a task only on a tool whose `execution.taskSupport` allows it, and
//!   its replies are read raw ([`v1`]); a 2026-07-28 server decides per call and is read through
//!   rmcp's own types ([`v2`]).
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
mod v1;
mod v2;

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rmcp::service::ServiceError;
use serde_json::{Map, Value};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use strum::{IntoStaticStr, VariantArray};
use tokio::sync::{Notify, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::mcp::client::connection::{McpConnectionScope, McpServerConnection};
use crate::mcp::client::requests::{McpRequestError, RequestWait};
use crate::mcp::elicitation_form::{compose_elicitation_content, read_elicitation_questions};
use crate::mutex_lock::lock;
use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionLinePlace, QuestionPort, QuestionTurnEnd,
    QuestionTurnError, ToolServerQuestionAnswer, take_question_in_turn,
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
}

/// Whether a followed task's server still answers its polls: `Lost` once no poll was answered for
/// 300 s, back to `Reached` at the next answered poll. The task is left alone either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskContact {
    /// The last poll, or one within the last 300 s, was answered.
    Reached,
    /// No poll was answered for 300 s.
    Lost,
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
    /// call asks outside a task, are asked in the call's session and run. Fails as the call or
    /// the acceptance fails.
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
        contact: &watch::Sender<McpTaskContact>,
    ) -> Result<McpToolCallEnd, McpToolCallError> {
        let in_flight = self.calls.track(&call, &self.scope);
        let ended = if self.task_generation == Some(McpTaskGeneration::V1)
            && self.is_task_tool(&call.dispatch.tool_name).await?
        {
            v1::call_task_tool(self, call, sink, contact).await
        } else {
            v2::call_tool(self, &in_flight, call, sink, contact).await
        };
        in_flight.finish().await;
        ended
    }

    /// Follows the recorded task `mcp_task_id` of `call`, accepted under `mcp_task_generation`,
    /// to its end, as after a restart: polled at once, its questions asked again in the call's
    /// session and run, `contact` saying whether its server answers. Never fails: a poll that
    /// fails is polled again.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, \
                  resume a recorded task through it"
    )]
    pub(crate) async fn resume_task(
        &self,
        call: McpToolCall,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
        contact: &watch::Sender<McpTaskContact>,
    ) -> McpToolCallEnd {
        match mcp_task_generation {
            McpTaskGeneration::V1 => v1::follow_task(self, &call, mcp_task_id, contact).await,
            McpTaskGeneration::V2 => v2::follow_task(self, &call, mcp_task_id, contact).await,
        }
    }

    /// Asks the server to cancel task `mcp_task_id`, in the protocol of the `mcp_task_generation`
    /// it was accepted under; the task's poll then reads its end. Fails as the request fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      cancel a stopped run's tasks through it"
        )
    )]
    pub(crate) async fn cancel_task(
        &self,
        mcp_task_generation: McpTaskGeneration,
        mcp_task_id: &str,
    ) -> Result<(), McpToolCallError> {
        match mcp_task_generation {
            McpTaskGeneration::V1 => {
                self.requests
                    .send_raw(
                        "tasks/cancel",
                        Some(serde_json::json!({ "taskId": mcp_task_id })),
                        RequestWait::Ordinary,
                    )
                    .await?;
            }
            McpTaskGeneration::V2 => self
                .requests
                .cancel_v2_task(mcp_task_id)
                .await
                .map_err(McpToolCallError::Service)?,
        }
        Ok(())
    }
}

/// A followed task's key: its session, its server's name and its id.
type WatchKey = (SessionId, String, String);

/// The tasks a client follows, across its connections, each one's early-poll wake and the run its
/// questions are asked in; and the questions card every tool-server question goes to. It holds one
/// entry per followed task, each until the task's poll ends, and in it each of the task's
/// questions still open: a 2025-11-25 one until it settles, a 2026-07-28 one, at most 16 a poll,
/// until the task ends.
pub(crate) struct TaskWatches {
    questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    watched: Mutex<HashMap<WatchKey, WatchedTask>>,
    /// Numbers each question a server asks, so its request id is never another's.
    next_question: AtomicU64,
}

struct WatchedTask {
    wake: Arc<Notify>,
    run_id: RunId,
    /// Canceled once the task stops being followed, which ends its questions' waits for the run.
    ended: CancellationToken,
    /// The request ids of the task's questions taken by the card.
    open_questions: Vec<String>,
}

/// One task while it is followed; finished or dropped, it stops following and withdraws its
/// questions still open.
pub(super) struct TaskWatch<'watches> {
    watches: &'watches TaskWatches,
    key: WatchKey,
    pub(super) wake: Arc<Notify>,
}

/// When the card takes a question: at once, refused while its run waits on something else; or in
/// its run's turn, waiting for the run to read running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QuestionTake {
    /// At once, as a task's poll asks, which asks again later.
    Now,
    /// In its run's turn, as a server's request waiting on the answer asks.
    InRunTurn,
}

/// What a question came to.
pub(super) enum QuestionOutcome {
    /// The person answered; the form's content.
    Answered(Map<String, Value>),
    /// The card did not take the question, or it was withdrawn before an answer.
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

    /// Follows `mcp_task_id` on `scope`'s server for `call`'s run.
    pub(super) fn watch(
        &self,
        scope: &McpConnectionScope,
        call: &McpToolCall,
        mcp_task_id: &str,
    ) -> TaskWatch<'_> {
        let key = watch_key(scope, mcp_task_id);
        let wake = Arc::new(Notify::new());
        lock(&self.watched).insert(
            key.clone(),
            WatchedTask {
                wake: Arc::clone(&wake),
                run_id: call.run_id,
                ended: CancellationToken::new(),
                open_questions: Vec::new(),
            },
        );
        TaskWatch {
            watches: self,
            key,
            wake,
        }
    }

    /// Wakes the poll of `scope`'s task `mcp_task_id` early, as a status notification asks; the
    /// poll still decides the task's state.
    pub(super) fn wake(&self, scope: &McpConnectionScope, mcp_task_id: &str) {
        if let Some(watched) = lock(&self.watched).get(&watch_key(scope, mcp_task_id)) {
            watched.wake.notify_one();
        }
    }

    /// Asks the elicitation `params` a 2025-11-25 task sent during its `tasks/result`, and waits
    /// for the person's answer. `None` when the client follows no such task on the server.
    pub(super) async fn ask_v1_task_question(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: Value,
    ) -> Option<QuestionOutcome> {
        let (answer, answered) = ElicitationAnswer::open(params.clone());
        let asked = self
            .ask(scope, mcp_task_id, &params, answer, QuestionTake::InRunTurn)
            .await?;
        let Some(request_id) = asked else {
            return Some(QuestionOutcome::Withdrawn);
        };
        let outcome = AwaitedQuestion::hold(self, scope.session_id, request_id.clone())
            .answer(answered)
            .await;
        // Settled, it is no longer open, so the task's end has nothing to withdraw for it.
        if let Some(task) = lock(&self.watched).get_mut(&watch_key(scope, mcp_task_id)) {
            task.open_questions.retain(|open| *open != request_id);
        }
        Some(outcome)
    }

    /// Hands the card one question of `scope`'s task `mcp_task_id`, answered through `answer`,
    /// taken as `take` says. `None` when the task is not followed, or stopped being followed before
    /// the card took it; `Some(None)` when the card did not take it, which is logged, so a later
    /// poll can ask it again; else the question's request id.
    pub(super) async fn ask(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: &Value,
        answer: Arc<dyn ToolServerQuestionAnswer>,
        take: QuestionTake,
    ) -> Option<Option<String>> {
        let key = watch_key(scope, mcp_task_id);
        let (run_id, ended) = {
            let watched = lock(&self.watched);
            let task = watched.get(&key)?;
            (task.run_id, task.ended.clone())
        };
        let request_id = self.mint_request_id(scope, mcp_task_id);
        let question = compose_question(scope, run_id, request_id.clone(), params);
        if !self
            .take_question(scope, question, answer, take, &ended)
            .await
        {
            return (!ended.is_cancelled()).then_some(None);
        }
        let is_followed = lock(&self.watched)
            .get_mut(&key)
            .map(|task| task.open_questions.push(request_id.clone()))
            .is_some();
        // A task that ended while its question was taken leaves nothing to answer it.
        if !is_followed {
            self.withdraw_questions_later(scope.session_id, vec![request_id.clone()]);
        }
        Some(Some(request_id))
    }

    /// A request id for one question `scope`'s server asks under `owner`, a task's id or a call.
    pub(super) fn mint_request_id(&self, scope: &McpConnectionScope, owner: &str) -> String {
        let number = self.next_question.fetch_add(1, Ordering::Relaxed);
        format!("mcp:{}:{owner}:{number}", scope.server_name.as_str())
    }

    /// Hands the card `question`, answered through `answer` and taken as `take` says; false when
    /// the card did not take it, which is logged, when it was settled before its run's turn came,
    /// or when `owner_ended`, its call's or task's end, came first. The take runs in a task of its
    /// own, so one whose asker or owner stops waiting still completes and its question is
    /// withdrawn, never left open with nobody to answer it; a question waiting its turn stops
    /// waiting with its asker or its owner and is withdrawn. Until the card's intake is registered
    /// this reads as taken while nobody holds `answer`: a 2025-11-25 question is then answered
    /// `cancel`, and a 2026-07-28 one is never asked again.
    pub(super) async fn take_question(
        &self,
        scope: &McpConnectionScope,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
        take: QuestionTake,
        owner_ended: &CancellationToken,
    ) -> bool {
        let Some(port) = self.questions.port().cloned() else {
            return true;
        };
        let (session_id, request_id) = (question.session_id, question.request_id.clone());
        let (mut sender, taken) = oneshot::channel();
        // Its place in its run's line is taken as it arrives, before the take's own task runs.
        let place =
            (take == QuestionTake::InRunTurn).then(|| QuestionLinePlace::line_up(question.run_id));
        tokio::spawn({
            let request_id = request_id.clone();
            async move {
                let took = match place {
                    None => port.take_tool_server_question(question, answer).await,
                    Some(place) => {
                        let ended = take_question_in_turn(
                            port.as_ref(),
                            question,
                            Some(answer),
                            place,
                            sender.closed(),
                        )
                        .await;
                        match ended {
                            Ok(QuestionTurnEnd::Taken) => Ok(()),
                            Ok(QuestionTurnEnd::Settled) => {
                                Err("the question was settled before its run's turn came".into())
                            }
                            // Withdrawn already, its asker gone.
                            Ok(QuestionTurnEnd::AskerLeft) => return,
                            // Its asker gone, so no one else logs it.
                            Err(QuestionTurnError::Withdrawal(error)) => {
                                tracing::warn!(
                                    error = &*error as &(dyn Error + 'static),
                                    "a tool server's question was not withdrawn"
                                );
                                return;
                            }
                            Err(error @ QuestionTurnError::Take { .. }) => Err(Box::new(error)),
                        }
                    }
                };
                match sender.send(took) {
                    Ok(()) => {}
                    // The asker stopped waiting while the card took the question.
                    Err(Ok(())) => {
                        withdraw_questions(port.as_ref(), session_id, vec![request_id]).await;
                    }
                    // Its asker gone, so no one else logs it.
                    Err(Err(error)) => tracing::warn!(
                        error = &*error as &(dyn Error + 'static),
                        "the questions card did not take a tool server's question"
                    ),
                }
            }
        });
        let mut pending = PendingTake {
            watches: self,
            session_id,
            request_id,
            taken,
        };
        let took = tokio::select! {
            took = &mut pending.taken => match took {
                Ok(took) => took,
                Err(_ended) => Err("the take ended without an outcome".into()),
            },
            // Its call or task ended first; the pending take, dropped, has the question withdrawn.
            () = owner_ended.cancelled() => return false,
        };
        if let Err(error) = took {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                server = scope.server_name.as_str(),
                "the questions card did not take a tool server's question"
            );
            return false;
        }
        true
    }

    /// Withdraws each of `request_ids` in `session_id` still open on the card, logging any the
    /// card could not settle.
    pub(super) async fn withdraw_questions(&self, session_id: SessionId, request_ids: Vec<String>) {
        if let Some(port) = self.questions.port() {
            withdraw_questions(port.as_ref(), session_id, request_ids).await;
        }
    }

    /// Withdraws `request_ids` as [`Self::withdraw_questions`] does, in a task of its own, for an
    /// owner dropped where it cannot wait.
    pub(super) fn withdraw_questions_later(&self, session_id: SessionId, request_ids: Vec<String>) {
        if request_ids.is_empty() {
            return;
        }
        let (Some(port), Ok(runtime)) = (
            self.questions.port().cloned(),
            tokio::runtime::Handle::try_current(),
        ) else {
            return;
        };
        runtime
            .spawn(async move { withdraw_questions(port.as_ref(), session_id, request_ids).await });
    }
}

/// Withdraws each of `request_ids` in `session_id` through `port`, logging any the card could not
/// settle.
async fn withdraw_questions(
    port: &dyn QuestionPort,
    session_id: SessionId,
    request_ids: Vec<String>,
) {
    for request_id in request_ids {
        let withdrawal = ProviderQuestionWithdrawal {
            session_id,
            request_id,
        };
        if let Err(error) = port.withdraw_question(withdrawal).await {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                "a tool server's question was not withdrawn"
            );
        }
    }
}

/// What a take running in its own task came to; dropped before it was read, it withdraws a
/// question the card took after all, so a take whose asker stopped waiting leaves nothing open.
struct PendingTake<'watches> {
    watches: &'watches TaskWatches,
    session_id: SessionId,
    request_id: String,
    taken: oneshot::Receiver<Result<(), Box<dyn Error + Send + Sync>>>,
}

impl Drop for PendingTake<'_> {
    fn drop(&mut self) {
        // Closed first, so the take's own task withdraws any outcome that comes after.
        self.taken.close();
        if let Ok(Ok(())) = self.taken.try_recv() {
            let request_id = std::mem::take(&mut self.request_id);
            self.watches
                .withdraw_questions_later(self.session_id, vec![request_id]);
        }
    }
}

/// A question the card took whose answer a server's request waits on; dropped before the answer
/// comes, as when the server canceled its request, it is withdrawn from the card.
pub(super) struct AwaitedQuestion<'watches> {
    watches: &'watches TaskWatches,
    session_id: SessionId,
    request_id: Option<String>,
}

impl<'watches> AwaitedQuestion<'watches> {
    /// Holds question `request_id` of `session_id` until it is answered.
    pub(super) fn hold(
        watches: &'watches TaskWatches,
        session_id: SessionId,
        request_id: String,
    ) -> Self {
        Self {
            watches,
            session_id,
            request_id: Some(request_id),
        }
    }

    /// What `answered`, the question's outcome, comes to.
    pub(super) async fn answer(
        mut self,
        answered: impl Future<Output = QuestionOutcome>,
    ) -> QuestionOutcome {
        let outcome = answered.await;
        self.request_id = None;
        outcome
    }
}

impl Drop for AwaitedQuestion<'_> {
    fn drop(&mut self) {
        if let Some(request_id) = self.request_id.take() {
            self.watches
                .withdraw_questions_later(self.session_id, vec![request_id]);
        }
    }
}

/// The card's question for the elicitation `params` of `scope`'s server, asked in `run_id`
/// under `request_id`; the run waits on it.
pub(super) fn compose_question(
    scope: &McpConnectionScope,
    run_id: RunId,
    request_id: String,
    params: &Value,
) -> ProviderQuestion {
    let header = NonEmptyText::new(scope.server_name.as_str().to_owned());
    ProviderQuestion {
        session_id: scope.session_id,
        run_id,
        request_id,
        questions: read_elicitation_questions(params, header),
        is_agent_waiting: true,
    }
}

fn watch_key(scope: &McpConnectionScope, mcp_task_id: &str) -> WatchKey {
    (
        scope.session_id,
        scope.server_name.as_str().to_owned(),
        mcp_task_id.to_owned(),
    )
}

impl TaskWatch<'_> {
    /// Stops following the task, withdrawing each of its questions still open on the card.
    pub(super) async fn finish(self) {
        let removed = lock(&self.watches.watched).remove(&self.key);
        if let Some(task) = removed {
            task.ended.cancel();
            self.watches
                .withdraw_questions(self.key.0, task.open_questions)
                .await;
        }
    }
}

impl Drop for TaskWatch<'_> {
    fn drop(&mut self) {
        let removed = lock(&self.watches.watched).remove(&self.key);
        if let Some(task) = removed {
            task.ended.cancel();
            self.watches
                .withdraw_questions_later(self.key.0, task.open_questions);
        }
    }
}

/// The answer to an elicitation the server's request waits on: the form's content, sent to the
/// waiting request once.
pub(super) struct ElicitationAnswer {
    params: Value,
    sender: Mutex<Option<oneshot::Sender<Map<String, Value>>>>,
}

impl ElicitationAnswer {
    /// An answer to the elicitation `params`, and what it comes to: the content once answered, or
    /// withdrawn when the answer is dropped unsent.
    pub(super) fn open(
        params: Value,
    ) -> (
        Arc<dyn ToolServerQuestionAnswer>,
        impl Future<Output = QuestionOutcome>,
    ) {
        let (sender, answered) = oneshot::channel();
        let answer = Arc::new(Self {
            params,
            sender: Mutex::new(Some(sender)),
        });
        let outcome = async move {
            match answered.await {
                Ok(content) => QuestionOutcome::Answered(content),
                Err(_withdrawn) => QuestionOutcome::Withdrawn,
            }
        };
        (answer, outcome)
    }
}

impl ToolServerQuestionAnswer for ElicitationAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let sender = lock(&self.sender).take();
        let sent = match sender {
            Some(sender) => sender
                .send(content)
                .map_err(|_unsent| "the tool server's request no longer waits".into()),
            None => Err("the question was answered already".into()),
        };
        async move { sent }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

    use super::{ElicitationAnswer, PendingTake, compose_question};
    use crate::mcp::client::test_server::{board_form, test_client, test_scope, track_call};
    use crate::provider::port::question::QuestionPort as _;

    // Mutation: in `PendingTake::drop`, leave out the withdrawal of an outcome sent but not read.
    #[tokio::test(start_paused = true)]
    async fn a_take_whose_outcome_came_but_was_never_read_withdraws_its_question() {
        let (client, card) = test_client();
        let scope = test_scope(&client);
        let request_id = scope.task_watches.mint_request_id(&scope, "task-1");
        let question = compose_question(
            &scope,
            track_call().run_id,
            request_id.clone(),
            &board_form(),
        );
        let (answer, _answered) = ElicitationAnswer::open(board_form());
        card.take_tool_server_question(question, answer)
            .await
            .expect("the card takes the question");
        let (sender, taken) = oneshot::channel();
        sender.send(Ok(())).expect("the take's outcome is sent");

        drop(PendingTake {
            watches: &scope.task_watches,
            session_id: scope.session_id,
            request_id,
            taken,
        });

        card.wait_until_none_open().await;
    }
}
