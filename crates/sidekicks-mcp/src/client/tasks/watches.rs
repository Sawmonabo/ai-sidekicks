//! The tasks a client follows and their questions on the questions card: each task's watch, the
//! takes that hand a question to the card, and the answers a server's request waits on.

pub(in crate::client) mod answers;

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Map, Value};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::mcp::elicitation_form::read_elicitation_questions;
use sidekicks_provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionLinePlace, QuestionPort, QuestionTurnEnd,
    QuestionTurnError, ToolServerQuestionAnswer, mint_tool_server_request_id,
    take_question_in_turn,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{Notify, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpConnectionScope;
use crate::client::poll::TaskContact;
use crate::client::tasks::watches::answers::{V1TaskAnswer, V1TaskAnswerState};
use crate::client::tasks::{McpServerEndpoint, McpTaskContact, McpToolCallEnd};

/// A followed task's key: its session, its server's name and its id.
type WatchKey = (SessionId, String, String);

/// The tasks a client follows, across its connections, each one's early-poll wake and the run its
/// questions are asked in; and the questions card every tool-server question goes to. It holds one
/// entry per followed task, each until the task's poll ends, and in it each of the task's
/// questions still open: a 2025-11-25 one until it settles, a 2026-07-28 one, at most 16 a poll,
/// until the task ends. A follow on a server at an address that its connection's close cut leaves
/// its entry for the follow a Reconnect re-binds, which adopts it.
pub(crate) struct TaskWatches {
    questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    watched: Mutex<HashMap<WatchKey, WatchedTask>>,
}

struct WatchedTask {
    wake: Arc<Notify>,
    run_id: RunId,
    /// The task's contact and its standing arm, which a re-bound follow adopts with the entry.
    contact: TaskContact,
    /// Canceled once the task stops being followed, which ends its questions' waits for the run.
    ended: CancellationToken,
    /// The request ids of the task's questions taken by the card.
    open_questions: Vec<String>,
    /// The 2025-11-25 question a closing connection's request left open, for the server's next
    /// ask on another connection.
    kept_question: Option<KeptQuestion>,
    /// Whether the card took each question a closing connection's request left, held so each take
    /// goes on in its run's turn rather than reading its asker as gone.
    detached_takes: Vec<oneshot::Receiver<bool>>,
    /// The keys of a 2026-07-28 task's input requests the card took, never asked again.
    asked: HashSet<String>,
    /// Whether a follow that adopted the entry still waits for the server to ask a 2025-11-25
    /// task's question again, which any ask ends.
    is_awaiting_reask: bool,
    /// Whether a 2025-11-25 task resumed after a restart is still to be canceled at the first
    /// answered poll that reads it waiting on input, across a re-bind too.
    is_restart_cancel_owed: bool,
}

/// A 2025-11-25 task's question left open when the connection its request came on closed.
struct KeptQuestion {
    request_id: String,
    /// Its answerer, while the card holds the question.
    answer: Weak<V1TaskAnswer>,
}

/// What lets a 2025-11-25 task's question outlive its request when the connection the request
/// came on closes: that connection's closing mark, the task's key and the question's answerer.
#[derive(Clone)]
pub(in crate::client) struct TaskQuestionDetach {
    /// The closing mark of the connection the request came on.
    closing: CancellationToken,
    /// The task's key.
    key: WatchKey,
    /// The question's answerer, held weakly so a question the card lets go reads as withdrawn.
    answer: Weak<V1TaskAnswer>,
}

impl TaskQuestionDetach {
    /// Leaves question `request_id` open in its task's entry, kept for the server's next ask, and
    /// lets `leave` add to the entry; false when the connection is not closing or the task is no
    /// longer followed, so the question is withdrawn as any.
    fn keep(
        &self,
        watches: &TaskWatches,
        request_id: &str,
        leave: impl FnOnce(&mut WatchedTask),
    ) -> bool {
        if !self.closing.is_cancelled() {
            return false;
        }
        let mut watched = lock(&watches.watched);
        let Some(task) = watched.get_mut(&self.key) else {
            return false;
        };
        task.kept_question = Some(KeptQuestion {
            request_id: request_id.to_owned(),
            answer: self.answer.clone(),
        });
        leave(task);
        true
    }
}

/// One task while it is followed; finished or dropped, it stops following and withdraws its
/// questions still open, unless it was left for a re-bind to adopt.
pub(in crate::client) struct TaskWatch<'watches> {
    watches: &'watches TaskWatches,
    key: WatchKey,
    pub(super) wake: Arc<Notify>,
    /// The task's contact, shared with every other writer of it.
    pub(in crate::client) contact: TaskContact,
    /// Whether the follow left its entry in place, so its drop removes nothing.
    is_left: bool,
}

/// When the card takes a question: at once, refused while its run waits on something else; or in
/// its run's turn, waiting for the run to read running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::client) enum QuestionTake {
    /// At once, as a task's poll asks, which asks again later.
    Now,
    /// In its run's turn, as a server's request waiting on the answer asks.
    InRunTurn,
}

/// What a question came to.
pub(in crate::client) enum QuestionOutcome {
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
        }
    }

    /// Follows `mcp_task_id` on `scope`'s server for run `run_id`, `contact` saying whether its
    /// server answers, adopting the entry a follow its connection's close cut left, with its
    /// questions, asked keys and standing arm, which then waits for the server to ask again.
    pub(in crate::client) fn watch(
        &self,
        scope: &McpConnectionScope,
        run_id: RunId,
        mcp_task_id: &str,
        contact: &watch::Sender<McpTaskContact>,
    ) -> TaskWatch<'_> {
        let key = watch_key(scope, mcp_task_id);
        let (wake, contact) = match lock(&self.watched).entry(key.clone()) {
            Entry::Occupied(mut left) => {
                let left = left.get_mut();
                left.is_awaiting_reask = true;
                (Arc::clone(&left.wake), left.contact.clone())
            }
            Entry::Vacant(vacant) => {
                let wake = Arc::new(Notify::new());
                let contact = TaskContact::new(contact.clone());
                vacant.insert(WatchedTask {
                    wake: Arc::clone(&wake),
                    run_id,
                    contact: contact.clone(),
                    ended: CancellationToken::new(),
                    open_questions: Vec::new(),
                    kept_question: None,
                    detached_takes: Vec::new(),
                    asked: HashSet::new(),
                    is_awaiting_reask: false,
                    is_restart_cancel_owed: false,
                });
                (wake, contact)
            }
        };
        TaskWatch {
            watches: self,
            key,
            wake,
            contact,
            is_left: false,
        }
    }

    /// Takes `arm` as the standing arm of `scope`'s task `mcp_task_id`, as its contact's
    /// [`TaskContact::write_standing`] does; shown on `contact` at once while the task has no
    /// watch yet, whose follow then takes it from there.
    pub(in crate::client) fn write_standing_arm(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        contact: &watch::Sender<McpTaskContact>,
        arm: McpTaskContact,
    ) {
        // Held across the write, so a watch made meanwhile reads the arm from `contact`.
        let watched = lock(&self.watched);
        match watched.get(&watch_key(scope, mcp_task_id)) {
            Some(task) => task.contact.write_standing(arm),
            None => contact.send_modify(|state| *state = arm),
        }
    }

    /// Settles the cancel `scope`'s task `mcp_task_id` owed after a restart: its follow sends none
    /// once a stop's cancel was sent, the cancel was refused, or the task no longer waits on input.
    pub(in crate::client) fn settle_restart_cancel(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
    ) {
        if let Some(watched) = lock(&self.watched).get_mut(&watch_key(scope, mcp_task_id)) {
            watched.is_restart_cancel_owed = false;
        }
    }

    /// Wakes the poll of `scope`'s task `mcp_task_id` early, as a status notification asks; the
    /// poll still decides the task's state.
    pub(in crate::client) fn wake(&self, scope: &McpConnectionScope, mcp_task_id: &str) {
        if let Some(watched) = lock(&self.watched).get(&watch_key(scope, mcp_task_id)) {
            watched.wake.notify_one();
        }
    }

    /// Asks the elicitation `params` a 2025-11-25 task sent during its `tasks/result`, on a
    /// connection whose close cancels `closing`, and waits for the person's answer. The task's
    /// question a closed connection left open takes an ask of its form, `_meta` aside: its kept
    /// answer is the response, else the ask waits on it; an ask of another form withdraws it
    /// first, a kept answer then lost, which the task's contact reads at once. Any ask ends a
    /// re-bound follow's wait for it. `None` when the client follows no such task on the server.
    pub(in crate::client) async fn ask_v1_task_question(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: Value,
        closing: &CancellationToken,
    ) -> Option<QuestionOutcome> {
        let params = strip_meta(params);
        let key = watch_key(scope, mcp_task_id);
        let kept = {
            let mut watched = lock(&self.watched);
            let task = watched.get_mut(&key)?;
            task.is_awaiting_reask = false;
            task.kept_question.take()
        };
        if let Some(kept) = kept {
            let same_form = kept
                .answer
                .upgrade()
                .filter(|answer| answer.params == params);
            let Some(answer) = same_form else {
                if self.withdraw_kept_question(&key, kept).await {
                    let contact = lock(&self.watched)
                        .get(&key)
                        .map(|task| task.contact.clone());
                    if let Some(contact) = contact {
                        contact.write_standing(McpTaskContact::DidNotAskAgain {
                            has_undelivered_answer: true,
                        });
                    }
                }
                return self
                    .ask_v1_task_question_anew(scope, mcp_task_id, params, closing, key)
                    .await;
            };
            let taken = answer.take_kept_or_wait();
            // Not held while waiting, so a question the card lets go reads as withdrawn.
            drop(answer);
            return Some(match taken {
                Ok(content) => {
                    self.forget_open_question(&key, &kept.request_id);
                    self.settle_kept_answer_later(scope.session_id, kept.request_id);
                    QuestionOutcome::Answered(content)
                }
                Err(answered) => {
                    let detach = TaskQuestionDetach {
                        closing: closing.clone(),
                        key: key.clone(),
                        answer: kept.answer,
                    };
                    self.await_task_answer(
                        scope.session_id,
                        &key,
                        kept.request_id,
                        detach,
                        answered,
                    )
                    .await
                }
            });
        }
        self.ask_v1_task_question_anew(scope, mcp_task_id, params, closing, key)
            .await
    }

    /// Asks `params` as a new question of `scope`'s task `mcp_task_id`, keyed `key`, as
    /// [`Self::ask_v1_task_question`] does when no kept question takes it.
    async fn ask_v1_task_question_anew(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: Value,
        closing: &CancellationToken,
        key: WatchKey,
    ) -> Option<QuestionOutcome> {
        let answer = Arc::new(V1TaskAnswer {
            params: params.clone(),
            state: Mutex::new(V1TaskAnswerState::default()),
        });
        let answered = lock(&answer.state).wait();
        let detach = TaskQuestionDetach {
            closing: closing.clone(),
            key: key.clone(),
            answer: Arc::downgrade(&answer),
        };
        let asked = self
            .ask(
                scope,
                mcp_task_id,
                &params,
                answer,
                QuestionTake::InRunTurn,
                Some(detach.clone()),
            )
            .await?;
        let Some(request_id) = asked else {
            return Some(QuestionOutcome::Withdrawn);
        };
        Some(
            self.await_task_answer(scope.session_id, &key, request_id, detach, answered)
                .await,
        )
    }

    /// Waits for `answered`, the answer to question `request_id` of the task keyed `key`, which
    /// stays open if its request's connection closes first.
    async fn await_task_answer(
        &self,
        session_id: SessionId,
        key: &WatchKey,
        request_id: String,
        detach: TaskQuestionDetach,
        answered: impl Future<Output = QuestionOutcome>,
    ) -> QuestionOutcome {
        let outcome = AwaitedQuestion::hold(self, session_id, request_id.clone(), Some(detach))
            .answer(answered)
            .await;
        // Settled, it is no longer open, so the task's end has nothing to withdraw for it.
        self.forget_open_question(key, &request_id);
        outcome
    }

    /// Withdraws `kept`, the question kept for the next ask of the task keyed `key`; true when
    /// the person's answer was kept with it, never delivered.
    async fn withdraw_kept_question(&self, key: &WatchKey, kept: KeptQuestion) -> bool {
        let has_kept_answer = kept
            .answer
            .upgrade()
            .is_some_and(|answer| answer.has_kept_answer());
        self.forget_open_question(key, &kept.request_id);
        self.withdraw_questions(key.0, vec![kept.request_id]).await;
        has_kept_answer
    }

    /// Drops `request_id` from the open questions of the task keyed `key`, while it is followed.
    fn forget_open_question(&self, key: &WatchKey, request_id: &str) {
        if let Some(task) = lock(&self.watched).get_mut(key) {
            task.open_questions.retain(|open| open != request_id);
        }
    }

    /// Settles answered question `request_id` of `session_id`, whose kept answer a server's next
    /// ask took, in a task of its own beside that ask's response. A settle that fails is logged
    /// and the question withdrawn, so it is not left open with every later answer refused.
    fn settle_kept_answer_later(&self, session_id: SessionId, request_id: String) {
        let Some(port) = self.questions.port().cloned() else {
            return;
        };
        tokio::spawn(async move {
            if let Err(error) = port
                .settle_kept_answer(session_id, request_id.clone())
                .await
            {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    "a tool server's kept answer was not settled; its question is withdrawn"
                );
                withdraw_questions(port.as_ref(), session_id, vec![request_id]).await;
            }
        });
    }

    /// Hands the card one question of `scope`'s task `mcp_task_id`, answered through `answer`,
    /// taken as `take` says, and kept open as `detach` says if its request's connection closes
    /// during the take. `None` when the task is not followed, or stopped being followed before
    /// the card took it; `Some(None)` when the card did not take it, which is logged, so a later
    /// poll can ask it again; else the question's request id.
    pub(super) async fn ask(
        &self,
        scope: &McpConnectionScope,
        mcp_task_id: &str,
        params: &Value,
        answer: Arc<dyn ToolServerQuestionAnswer>,
        take: QuestionTake,
        detach: Option<TaskQuestionDetach>,
    ) -> Option<Option<String>> {
        let key = watch_key(scope, mcp_task_id);
        let (run_id, ended) = {
            let watched = lock(&self.watched);
            let task = watched.get(&key)?;
            (task.run_id, task.ended.clone())
        };
        let request_id = mint_tool_server_request_id();
        let question = compose_question(scope, run_id, request_id.clone(), params);
        if !self
            .take_question(scope, question, answer, take, &ended, detach)
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

    /// Hands the card `question`, answered through `answer` and taken as `take` says; false when
    /// the card did not take it, which the take logs, when it was settled before its run's turn
    /// came, or when `owner_ended`, its call's or task's end, came first. The take runs in a task
    /// of its own, so one whose asker or owner stops waiting still completes and its question is
    /// withdrawn, never left open with nobody to answer it; a question waiting its turn stops
    /// waiting with its asker or its owner and is withdrawn. An asker cut by its connection's close
    /// leaves a task's question to `detach`, its take going on. Until the card's intake is
    /// registered this reads as taken while nobody holds `answer`: a 2025-11-25 question is then
    /// answered `cancel`, and a 2026-07-28 one is never asked again.
    pub(in crate::client) async fn take_question(
        &self,
        scope: &McpConnectionScope,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
        take: QuestionTake,
        owner_ended: &CancellationToken,
        detach: Option<TaskQuestionDetach>,
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
            let server = scope.server_name.clone();
            async move {
                // Whether the card took it; false when it was settled before its run's turn came,
                // or refused, which is logged here whether or not its asker still waits.
                let took = match place {
                    None => match port.take_tool_server_question(question, answer).await {
                        Ok(()) => true,
                        Err(error) => {
                            log_untaken(server.as_str(), &*error);
                            false
                        }
                    },
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
                            Ok(QuestionTurnEnd::Taken) => true,
                            Ok(QuestionTurnEnd::Settled) => false,
                            // Withdrawn already, its asker gone.
                            Ok(QuestionTurnEnd::AskerLeft) => return,
                            // Its asker gone, so no one else logs it.
                            Err(QuestionTurnError::Withdrawal(error)) => {
                                tracing::warn!(
                                    error = &*error as &(dyn Error + 'static),
                                    server = server.as_str(),
                                    "a tool server's question was not withdrawn"
                                );
                                return;
                            }
                            Err(error @ QuestionTurnError::Take { .. }) => {
                                log_untaken(server.as_str(), &error);
                                false
                            }
                        }
                    }
                };
                // The asker stopped waiting while the card took the question.
                if let Err(true) = sender.send(took) {
                    withdraw_questions(port.as_ref(), session_id, vec![request_id]).await;
                }
            }
        });
        let mut pending = PendingTake {
            watches: self,
            session_id,
            request_id,
            taken: Some(taken),
            detach,
        };
        let took = tokio::select! {
            took = pending.taken.as_mut().expect("the take's outcome is read once") => took,
            // Its call or task ended first; the pending take, dropped, has the question withdrawn.
            () = owner_ended.cancelled() => return false,
        };
        // Read, so the pending take's drop leaves the question to this asker.
        pending.taken = None;
        took.unwrap_or_else(|error| {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                server = scope.server_name.as_str(),
                "a tool server question's take ended without an outcome"
            );
            false
        })
    }

    /// Withdraws each of `request_ids` in `session_id` still open on the card, logging any the
    /// card could not settle.
    pub(in crate::client) async fn withdraw_questions(
        &self,
        session_id: SessionId,
        request_ids: Vec<String>,
    ) {
        if let Some(port) = self.questions.port() {
            withdraw_questions(port.as_ref(), session_id, request_ids).await;
        }
    }

    /// Withdraws `request_ids` as [`Self::withdraw_questions`] does, in a task of its own, for an
    /// owner dropped where it cannot wait.
    pub(in crate::client) fn withdraw_questions_later(
        &self,
        session_id: SessionId,
        request_ids: Vec<String>,
    ) {
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

/// Logs that the questions card did not take a question of `server`, refused with `error`.
fn log_untaken(server: &str, error: &(dyn Error + 'static)) {
    tracing::warn!(
        error,
        server,
        "the questions card did not take a tool server's question"
    );
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
/// A task's question whose asker its connection's close cut is left open instead, its take going
/// on in its run's turn.
struct PendingTake<'watches> {
    watches: &'watches TaskWatches,
    session_id: SessionId,
    request_id: String,
    /// Whether the card took the question, until it is read.
    taken: Option<oneshot::Receiver<bool>>,
    detach: Option<TaskQuestionDetach>,
}

impl Drop for PendingTake<'_> {
    fn drop(&mut self) {
        if self.taken.is_none() {
            return;
        }
        if let Some(detach) = &self.detach {
            detach.keep(self.watches, &self.request_id, |task| {
                // Held, so the take neither reads its asker as gone nor withdraws what it took.
                task.detached_takes.extend(self.taken.take());
                task.open_questions.push(self.request_id.clone());
            });
        }
        // Left in place when the question was not kept.
        let Some(mut taken) = self.taken.take() else {
            return;
        };
        // Closed first, so the take's own task withdraws any outcome that comes after.
        taken.close();
        if let Ok(true) = taken.try_recv() {
            let request_id = std::mem::take(&mut self.request_id);
            self.watches
                .withdraw_questions_later(self.session_id, vec![request_id]);
        }
    }
}

/// A question the card took whose answer a server's request waits on; dropped before the answer
/// comes, as when the server canceled its request, it is withdrawn from the card. A task's
/// question whose request its connection's close cut is left open for the server's next ask.
pub(in crate::client) struct AwaitedQuestion<'watches> {
    watches: &'watches TaskWatches,
    session_id: SessionId,
    request_id: Option<String>,
    detach: Option<TaskQuestionDetach>,
}

impl<'watches> AwaitedQuestion<'watches> {
    /// Holds question `request_id` of `session_id` until it is answered, kept open as `detach`
    /// says if its request's connection closes first.
    pub(in crate::client) fn hold(
        watches: &'watches TaskWatches,
        session_id: SessionId,
        request_id: String,
        detach: Option<TaskQuestionDetach>,
    ) -> Self {
        Self {
            watches,
            session_id,
            request_id: Some(request_id),
            detach,
        }
    }

    /// What `answered`, the question's outcome, comes to.
    pub(in crate::client) async fn answer(
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
        let Some(request_id) = self.request_id.take() else {
            return;
        };
        let is_kept = self
            .detach
            .as_ref()
            .is_some_and(|detach| detach.keep(self.watches, &request_id, |_| {}));
        if !is_kept {
            self.watches
                .withdraw_questions_later(self.session_id, vec![request_id]);
        }
    }
}

/// The card's question for the elicitation `params` of `scope`'s server, asked in `run_id`
/// under `request_id`; the run waits on it.
pub(in crate::client) fn compose_question(
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

/// `params` without its `_meta`, which differs between a server's asks of one form.
fn strip_meta(mut params: Value) -> Value {
    if let Some(members) = params.as_object_mut() {
        members.remove("_meta");
    }
    params
}

fn watch_key(scope: &McpConnectionScope, mcp_task_id: &str) -> WatchKey {
    (
        scope.session_id,
        scope.server_name.as_str().to_owned(),
        mcp_task_id.to_owned(),
    )
}

impl TaskWatch<'_> {
    /// Ends the follow at `end` on the server at `endpoint`: a follow on a server at an address
    /// that its connection's close cut leaves its entry, questions and asked keys in place for the
    /// re-bind to adopt, or for the dispatch to end when it re-binds nothing; any other end
    /// finishes it.
    pub(super) async fn end(self, end: &McpToolCallEnd, endpoint: &McpServerEndpoint) {
        if *end == McpToolCallEnd::ConnectionClosed && endpoint.is_address() {
            self.leave();
        } else {
            self.finish().await;
        }
    }

    /// Stops following the task here, leaving its entry with its questions still open, for a
    /// follow on another connection to adopt.
    pub(in crate::client) fn leave(mut self) {
        self.is_left = true;
    }

    /// Whether the card took the task's input request `input_key`.
    pub(super) fn is_asked(&self, input_key: &str) -> bool {
        lock(&self.watches.watched)
            .get(&self.key)
            .is_some_and(|task| task.asked.contains(input_key))
    }

    /// Whether the follow, re-bound after its connection's close, still waits for the server to
    /// ask the task's question again.
    pub(super) fn is_awaiting_reask(&self) -> bool {
        lock(&self.watches.watched)
            .get(&self.key)
            .is_some_and(|task| task.is_awaiting_reask)
    }

    /// Stops waiting for the server's next ask, withdrawing the question kept for it; true when
    /// the person's answer was kept with it, never delivered.
    pub(super) async fn end_reask_wait(&self) -> bool {
        let kept = lock(&self.watches.watched)
            .get_mut(&self.key)
            .and_then(|task| {
                task.is_awaiting_reask = false;
                task.kept_question.take()
            });
        match kept {
            Some(kept) => self.watches.withdraw_kept_question(&self.key, kept).await,
            None => false,
        }
    }

    /// Records that the task, resumed after a restart, is to be canceled at the first answered poll
    /// that reads it waiting on input.
    pub(super) fn mark_restart_cancel_owed(&self) {
        if let Some(task) = lock(&self.watches.watched).get_mut(&self.key) {
            task.is_restart_cancel_owed = true;
        }
    }

    /// Whether the task, resumed after a restart, is still to be canceled at the next answered poll
    /// that reads it waiting on input.
    pub(super) fn is_restart_cancel_owed(&self) -> bool {
        lock(&self.watches.watched)
            .get(&self.key)
            .is_some_and(|task| task.is_restart_cancel_owed)
    }

    /// Records that the card took the task's input request `input_key`, so it is never asked
    /// again, across a re-bind too.
    pub(super) fn mark_asked(&self, input_key: &str) {
        if let Some(task) = lock(&self.watches.watched).get_mut(&self.key) {
            task.asked.insert(input_key.to_owned());
        }
    }

    /// Stops following the task, withdrawing each of its questions still open on the card.
    async fn finish(self) {
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
        if self.is_left {
            return;
        }
        let removed = lock(&self.watches.watched).remove(&self.key);
        if let Some(task) = removed {
            task.ended.cancel();
            self.watches
                .withdraw_questions_later(self.key.0, task.open_questions);
        }
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_provider::port::question::{QuestionPort as _, mint_tool_server_request_id};
    use tokio::sync::oneshot;

    use super::answers::ElicitationAnswer;
    use super::{PendingTake, compose_question};
    use crate::client::test_server::{board_form, test_client, test_scope, track_call};

    // Mutation: in `PendingTake::drop`, leave out the withdrawal of an outcome sent but not read.
    #[tokio::test(start_paused = true)]
    async fn a_take_whose_outcome_came_but_was_never_read_withdraws_its_question() {
        let (client, card) = test_client();
        let scope = test_scope(&client);
        let request_id = mint_tool_server_request_id();
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
        sender.send(true).expect("the take's outcome is sent");

        drop(PendingTake {
            watches: &scope.task_watches,
            session_id: scope.session_id,
            request_id,
            taken: Some(taken),
            detach: None,
        });

        card.wait_until_none_open().await;
    }
}
