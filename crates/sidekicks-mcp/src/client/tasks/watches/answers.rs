//! The answers a tool server's question takes: a plain call's, sent once to the request waiting
//! on it, and a 2025-11-25 task's, kept for the task's next ask when no request waits.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_provider::mcp::elicitation_form::compose_elicitation_content;
use sidekicks_provider::port::question::{ToolServerAnswerDelivery, ToolServerQuestionAnswer};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use crate::client::tasks::watches::QuestionOutcome;

/// The answer to an elicitation a plain call's request waits on: the form's content, sent to the
/// waiting request once.
pub(in crate::client) struct ElicitationAnswer {
    params: Value,
    sender: Mutex<Option<oneshot::Sender<Map<String, Value>>>>,
}

impl ElicitationAnswer {
    /// An answer to the elicitation `params`, and what it comes to: the content once answered, or
    /// withdrawn when the answer is dropped unsent.
    pub(in crate::client) fn open(
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
        (answer, question_outcome(answered))
    }
}

/// What a question comes to: the content `answered` receives, or withdrawn when its sender is
/// dropped unsent.
async fn question_outcome(answered: oneshot::Receiver<Map<String, Value>>) -> QuestionOutcome {
    match answered.await {
        Ok(content) => QuestionOutcome::Answered(content),
        Err(_withdrawn) => QuestionOutcome::Withdrawn,
    }
}

impl ToolServerQuestionAnswer for ElicitationAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<ToolServerAnswerDelivery, Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let sender = lock(&self.sender).take();
        let sent = match sender {
            Some(sender) => sender
                .send(content)
                .map(|()| ToolServerAnswerDelivery::Delivered)
                .map_err(|_unsent| "the tool server's request no longer waits".into()),
            None => Err("the question was answered already".into()),
        };
        async move { sent }.boxed()
    }
}

/// The answer to a 2025-11-25 task's question: the form's content, sent to the server's request
/// waiting on it, or kept for the task's next ask of the same form when none waits.
pub(super) struct V1TaskAnswer {
    /// The question's form, without its `_meta`.
    pub(super) params: Value,
    /// Where the answer goes, or is kept.
    pub(super) state: Mutex<V1TaskAnswerState>,
}

/// Where a 2025-11-25 task's answer goes: the request waiting on it, or kept for the next ask.
#[derive(Default)]
pub(super) struct V1TaskAnswerState {
    /// The request waiting on the answer, while one does.
    waiting: Option<oneshot::Sender<Map<String, Value>>>,
    /// The content no request waited on, kept for the next ask.
    kept: Option<Map<String, Value>>,
    /// Whether the content went to a request, after which no answer is taken.
    is_sent: bool,
}

impl V1TaskAnswerState {
    /// What the answer still to come comes to, a request now waiting on it.
    pub(super) fn wait(&mut self) -> impl Future<Output = QuestionOutcome> + use<> {
        let (sender, answered) = oneshot::channel();
        self.waiting = Some(sender);
        question_outcome(answered)
    }
}

impl V1TaskAnswer {
    /// Whether the person's answer is kept, no request having taken it.
    pub(super) fn has_kept_answer(&self) -> bool {
        lock(&self.state).kept.is_some()
    }

    /// The kept content, now taken as sent; else what the answer still to come comes to, a
    /// request now waiting on it.
    pub(super) fn take_kept_or_wait(
        &self,
    ) -> Result<Map<String, Value>, impl Future<Output = QuestionOutcome> + use<>> {
        let mut state = lock(&self.state);
        match state.kept.take() {
            Some(content) => {
                state.is_sent = true;
                Ok(content)
            }
            None => Err(state.wait()),
        }
    }
}

impl ToolServerQuestionAnswer for V1TaskAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<ToolServerAnswerDelivery, Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let mut state = lock(&self.state);
        let delivery = if state.is_sent {
            Err("the question was answered already".into())
        } else {
            let unsent = match state.waiting.take() {
                Some(waiting) => waiting.send(content).err(),
                None => Some(content),
            };
            match unsent {
                None => {
                    state.is_sent = true;
                    Ok(ToolServerAnswerDelivery::Delivered)
                }
                // No request waits; a newer answer replaces a kept one.
                Some(content) => {
                    state.kept = Some(content);
                    Ok(ToolServerAnswerDelivery::Kept)
                }
            }
        };
        drop(state);
        async move { delivery }.boxed()
    }
}
