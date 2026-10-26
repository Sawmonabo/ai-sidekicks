//! A questions card for tests: it takes one open question per run at a time, as a run waiting on
//! one does, keeps the rest waiting for their run until it reads running again, and can hold back
//! its record writes, its takes' outcomes and its withdrawals.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::question::{QuestionAnswer, QuestionAskedState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{Notify, Semaphore};
use tokio::time::{Duration, timeout};

use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionPort, ToolServerQuestionAnswer,
    WaitingQuestionOpening,
};

/// One question on the card with its answerer, a tool server's, or none for a driver's.
type CardQuestion = (ProviderQuestion, Option<Arc<dyn ToolServerQuestionAnswer>>);

/// A questions card that holds one open question per run, as a run waiting on one refuses a
/// second, its run reading running again once none is open: each question opened, those still
/// open with their answerers until answered or withdrawn, and those waiting for their run. A
/// withdrawal of a question it does not hold leaves the card as it is.
#[derive(Default)]
pub(crate) struct QuestionCard {
    taken: Mutex<Vec<ProviderQuestion>>,
    open: Mutex<Vec<CardQuestion>>,
    waiting: Mutex<Vec<CardQuestion>>,
    asked: Notify,
    /// Notified whenever an open question is answered or withdrawn, as its run reads running.
    closed: Notify,
    take_gate: Mutex<Option<Arc<Notify>>>,
    withdraw_gate: Mutex<Option<Arc<Notify>>>,
    /// Shut while it holds `Some`: each record write waits on it before the question reaches the
    /// card, counted in `held_records`.
    record_gate: Mutex<Option<Arc<Semaphore>>>,
    held_records: Mutex<usize>,
    /// The request id of every withdrawal taken, in order.
    withdrawals: Mutex<Vec<String>>,
}

impl QuestionCard {
    /// Every question the card opened, in order.
    pub(crate) fn taken(&self) -> Vec<ProviderQuestion> {
        self.taken.lock().expect("never poisoned").clone()
    }

    /// The questions on the card waiting for their run, in the order they came.
    pub(crate) fn waiting(&self) -> Vec<ProviderQuestion> {
        self.waiting
            .lock()
            .expect("never poisoned")
            .iter()
            .map(|(question, _)| question.clone())
            .collect()
    }

    // Opens `question` with `answer`; the open list's lock is held by the caller.
    fn open_question(
        &self,
        open: &mut Vec<CardQuestion>,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
    ) {
        self.taken
            .lock()
            .expect("never poisoned")
            .push(question.clone());
        open.push((question, answer));
        self.asked.notify_waiters();
    }

    // Places `question` on the card as its record's write does, open when `may_open` and its run
    // has none open, else waiting for its run, then answers once the take gate lets it.
    async fn record(
        &self,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
        may_open: bool,
    ) -> Result<QuestionAskedState, Box<dyn Error + Send + Sync>> {
        let taking = {
            let mut open = self.open.lock().expect("never poisoned");
            if may_open && !Self::is_waiting_on_question(&open, question.run_id) {
                self.open_question(&mut open, question, answer);
                QuestionAskedState::Open
            } else {
                self.waiting
                    .lock()
                    .expect("never poisoned")
                    .push((question, answer));
                QuestionAskedState::WaitingForRun
            }
        };
        let gate = self.take_gate.lock().expect("never poisoned").clone();
        if let Some(gate) = gate {
            gate.notified().await;
        }
        Ok(taking)
    }

    // Whether `run_id` has a question open, so the run does not read running.
    fn is_waiting_on_question(open: &[CardQuestion], run_id: RunId) -> bool {
        open.iter().any(|(held, _)| held.run_id == run_id)
    }

    /// Waits until no question is open, as once every one was answered or withdrawn; fails the
    /// test past 60 s.
    pub(crate) async fn wait_until_none_open(&self) {
        let none_open = async {
            while !self.open.lock().expect("never poisoned").is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), none_open)
            .await
            .expect("every question is answered or withdrawn");
    }

    /// Waits until the card took `count` questions; fails the test past 60 s.
    pub(crate) async fn wait_until_taken(&self, count: usize) {
        let taken = async {
            while self.taken().len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), taken)
            .await
            .expect("the card takes the questions");
    }

    /// Waits until `count` questions wait for their run on the card; fails the test past 60 s.
    pub(crate) async fn wait_until_waiting(&self, count: usize) {
        let waiting = async {
            while self.waiting().len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), waiting)
            .await
            .expect("the card holds the questions waiting for their run");
    }

    /// Waits until no question waits for its run on the card, as once each was opened or
    /// withdrawn; fails the test past 60 s.
    pub(crate) async fn wait_until_none_waiting(&self) {
        let none_waiting = async {
            while !self.waiting().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), none_waiting)
            .await
            .expect("no question waits for its run");
    }

    /// Holds back the outcome of each later take until the returned gate is notified, the question
    /// already on the card, as a take whose write is enqueued before it answers.
    pub(crate) fn hold_takes(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.take_gate.lock().expect("never poisoned") = Some(Arc::clone(&gate));
        gate
    }

    /// Holds back each later record write, the question not yet on the card, until
    /// [`Self::land_records`], as a write queued behind another.
    pub(crate) fn hold_records(&self) {
        *self.record_gate.lock().expect("never poisoned") = Some(Arc::new(Semaphore::new(0)));
    }

    /// Lets every record write held back land.
    pub(crate) fn land_records(&self) {
        if let Some(gate) = self.record_gate.lock().expect("never poisoned").take() {
            gate.close();
        }
    }

    /// Waits until `count` record writes wait at the gate of [`Self::hold_records`]; fails the
    /// test past 60 s.
    pub(crate) async fn wait_until_records_held(&self, count: usize) {
        let held = async {
            while *self.held_records.lock().expect("never poisoned") < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), held)
            .await
            .expect("the record writes wait at the gate");
    }

    /// Waits until the card took `count` withdrawals, of questions it held or not; fails the test
    /// past 60 s.
    pub(crate) async fn wait_until_withdrawals(&self, count: usize) {
        let withdrawn = async {
            while self.withdrawals.lock().expect("never poisoned").len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), withdrawn)
            .await
            .expect("the card takes the withdrawals");
    }

    /// Holds back each later withdrawal until the returned gate is notified, the question still
    /// open, as a withdrawal whose write waits behind another.
    pub(crate) fn hold_withdrawals(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.withdraw_gate.lock().expect("never poisoned") = Some(Arc::clone(&gate));
        gate
    }

    /// Waits for an open question, answers the oldest with `answers` through its answerer and
    /// closes it.
    pub(crate) async fn answer_open(&self, answers: Vec<QuestionAnswer>) -> ProviderQuestion {
        loop {
            let asked = self.asked.notified();
            let open = {
                let mut open = self.open.lock().expect("never poisoned");
                (!open.is_empty()).then(|| open.remove(0))
            };
            if let Some((question, answer)) = open {
                answer
                    .expect("a question answered on the card has a tool server's answerer")
                    .answer(answers)
                    .await
                    .expect("the answer is sent");
                self.closed.notify_waiters();
                return question;
            }
            asked.await;
        }
    }
}

impl QuestionPort for QuestionCard {
    fn take_tool_server_question(
        &self,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let taken = {
            let mut open = self.open.lock().expect("never poisoned");
            if Self::is_waiting_on_question(&open, question.run_id) {
                Err("the run already waits on a question".into())
            } else {
                self.open_question(&mut open, question, Some(answer));
                Ok(())
            }
        };
        let gate = self.take_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            taken
        }
        .boxed()
    }

    fn record_question_in_turn(
        &self,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
        may_open: bool,
    ) -> BoxFuture<'_, Result<QuestionAskedState, Box<dyn Error + Send + Sync>>> {
        let record_gate = self.record_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = record_gate {
                *self.held_records.lock().expect("never poisoned") += 1;
                let landed = gate.acquire().await;
                assert!(landed.is_err(), "the gate only ever closes");
            }
            self.record(question, answer, may_open).await
        }
        .boxed()
    }

    fn open_waiting_question(
        &self,
        _session_id: SessionId,
        request_id: String,
    ) -> BoxFuture<'_, Result<WaitingQuestionOpening, Box<dyn Error + Send + Sync>>> {
        let opening = {
            let mut open = self.open.lock().expect("never poisoned");
            let mut waiting = self.waiting.lock().expect("never poisoned");
            match waiting
                .iter()
                .position(|(held, _)| held.request_id == request_id)
            {
                None => WaitingQuestionOpening::Settled,
                Some(place) if Self::is_waiting_on_question(&open, waiting[place].0.run_id) => {
                    WaitingQuestionOpening::RunNotRunning
                }
                Some(place) => {
                    let (question, answer) = waiting.remove(place);
                    self.open_question(&mut open, question, answer);
                    WaitingQuestionOpening::Opened
                }
            }
        };
        async move { Ok(opening) }.boxed()
    }

    fn wait_until_running(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let mut closed = std::pin::pin!(self.closed.notified());
            closed.as_mut().enable();
            if Self::is_waiting_on_question(&self.open.lock().expect("never poisoned"), run_id) {
                closed.await;
            }
            Ok(())
        }
        .boxed()
    }

    fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let gate = self.withdraw_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.withdrawals
                .lock()
                .expect("never poisoned")
                .push(withdrawal.request_id.clone());
            self.open
                .lock()
                .expect("never poisoned")
                .retain(|(held, _)| held.request_id != withdrawal.request_id);
            self.waiting
                .lock()
                .expect("never poisoned")
                .retain(|(held, _)| held.request_id != withdrawal.request_id);
            self.closed.notify_waiters();
            Ok(())
        }
        .boxed()
    }
}
