//! Each session's chain: the jobs that hand, withdraw and settle its messages, pushed in call order
//! under the delivery's mutex and run one at a time by one drain task, which lives only while the
//! chain holds a job. A job's failure is logged, since no caller waits for it, and the drain goes
//! on.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::join_all;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::bounded_wait::wait_within;
use crate::provider::driver::contract::{DriverError, ProviderDriver};
use crate::provider::driver::run_control::{
    WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::queue::delivery::hands::{DeliveryState, HandRoute};
use crate::queue::delivery::{
    DeliveryError, QueueDelivery, QueueWithdrawal, WITHDRAW_DEADLINE, steer_of,
};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::{QueueItemRecord, RecordedQueueItemState};

/// The answer a withdraw job sends its caller: each candidate's withdrawal, or the failure that
/// stopped them.
pub(super) type WithdrawReply = Result<HashMap<QueueItemId, QueueWithdrawal>, DeliveryError>;

/// One session's jobs in push order, and the run a `Hand` job is inside its driver call for.
pub(super) struct SessionChain {
    jobs: VecDeque<ChainJob>,
    in_flight: watch::Sender<Option<RunId>>,
}

impl SessionChain {
    /// Follows the run a `Hand` job is inside its driver call for; the follow closes once the
    /// chain ends, when nothing is in flight.
    pub(super) fn follow_in_flight(&self) -> watch::Receiver<Option<RunId>> {
        self.in_flight.subscribe()
    }

    fn mark_in_flight(&self, run_id: Option<RunId>) {
        self.in_flight.send_modify(|in_flight| *in_flight = run_id);
    }
}

/// A job on a session's chain.
pub(super) enum ChainJob {
    /// Steers each message, in order, into a run whose provider takes them at once.
    Hand {
        /// The run.
        run_id: RunId,
        /// The run's driver, resolved at the hand.
        driver: Arc<dyn ProviderDriver>,
        /// The messages, marked handed.
        items: Vec<QueueItemRecord>,
    },
    /// Steers every message at once, in order, at a tool boundary of the run's turn.
    ToolBoundary {
        /// The run.
        run_id: RunId,
        /// The run's driver, resolved at the boundary.
        driver: Arc<dyn ProviderDriver>,
        /// The messages, marked handed.
        items: Vec<QueueItemRecord>,
    },
    /// Takes messages back from their provider ahead of a change to them.
    Withdraw(WithdrawJob),
    /// Settles a message the provider recorded as taken by `run_id`.
    MessageTaken {
        /// The message.
        item_id: QueueItemId,
        /// The run whose turn took it.
        run_id: RunId,
    },
    /// Settles a withdraw the provider answered past the deadline.
    LateWithdraw(LateWithdraw),
    /// Gives a caller its turn between the jobs: `go` says it is its turn, and the drain waits
    /// until `done` closes.
    Gate {
        /// Sent when the caller's turn comes.
        go: oneshot::Sender<()>,
        /// Closes when the caller's turn is over.
        done: oneshot::Receiver<()>,
    },
}

/// A take-back's withdraws, run when the chain reaches them unless their deadline passed first.
pub(super) struct WithdrawJob {
    /// The messages to take back.
    pub(super) candidates: Vec<QueueItemRecord>,
    /// Cancelled once the caller stops waiting.
    pub(super) deadline: CancellationToken,
    /// Set when the withdraws start, under its lock, which the caller reads as it cancels.
    pub(super) has_started: Arc<Mutex<bool>>,
    /// Where the withdrawals go; dropped unsent when the deadline passed first.
    pub(super) reply: oneshot::Sender<WithdrawReply>,
}

/// A withdraw answered after the deadline, for the hand it was asked of.
pub(super) struct LateWithdraw {
    /// The message.
    item: QueueItemRecord,
    /// The run it was handed for.
    handed_run_id: RunId,
    /// The hand the withdraw was asked of.
    hand_number: u64,
    /// Whether the provider had taken it.
    is_delivered: bool,
}

/// Locks `flag`; it holds a plain boolean, which no holder leaves half-written.
pub(super) fn lock_flag(flag: &Mutex<bool>) -> std::sync::MutexGuard<'_, bool> {
    flag.lock().unwrap_or_else(PoisonError::into_inner)
}

impl QueueDelivery {
    /// Pushes `job` onto the chain of `session_id` in `state`, the caller's own hold on the
    /// delivery's mutex, and starts the chain's drain when it had none.
    pub(super) fn push_job(&self, state: &mut DeliveryState, session_id: SessionId, job: ChainJob) {
        match state.chains.entry(session_id) {
            Entry::Occupied(mut chain) => chain.get_mut().jobs.push_back(job),
            Entry::Vacant(vacant) => {
                vacant.insert(SessionChain {
                    jobs: VecDeque::from([job]),
                    in_flight: watch::Sender::new(None),
                });
                let delivery = self.clone();
                tokio::spawn(
                    async move { delivery.drain(session_id).await }
                        .instrument(tracing::Span::current()),
                );
            }
        }
    }

    /// Pushes `job` onto the chain of `session_id` as [`QueueDelivery::push_job`] does, taking the
    /// delivery's mutex itself.
    pub(super) fn push(&self, session_id: SessionId, job: ChainJob) {
        let mut state = self.lock_state();
        self.push_job(&mut state, session_id, job);
    }

    // Runs the chain's jobs in order and, finding it empty, removes it in the same critical
    // section, so a job pushed after that starts a new drain.
    async fn drain(self, session_id: SessionId) {
        loop {
            let job = {
                let mut state = self.lock_state();
                let job = state
                    .chains
                    .get_mut(&session_id)
                    .and_then(|chain| chain.jobs.pop_front());
                if job.is_none() {
                    state.chains.remove(&session_id);
                }
                job
            };
            let Some(job) = job else {
                return;
            };
            self.run_job(session_id, job).await;
        }
    }

    async fn run_job(&self, session_id: SessionId, job: ChainJob) {
        match job {
            ChainJob::Hand {
                run_id,
                driver,
                items,
            } => {
                for item in &items {
                    let handed = self.hand(session_id, run_id, driver.as_ref(), item).await;
                    log_job_failure(session_id, item.id, handed);
                }
            }
            ChainJob::ToolBoundary {
                run_id,
                driver,
                items,
            } => {
                self.steer_at_boundary(session_id, run_id, driver.as_ref(), &items)
                    .await
            }
            ChainJob::Withdraw(job) => self.withdraw_all(session_id, job).await,
            ChainJob::MessageTaken { item_id, run_id } => {
                let settled = self.settle_taken(session_id, item_id, run_id).await;
                log_job_failure(session_id, item_id, settled);
            }
            ChainJob::LateWithdraw(late) => {
                let item_id = late.item.id;
                let settled = self.settle_late_withdraw(session_id, late).await;
                log_job_failure(session_id, item_id, settled);
            }
            // A caller that left before its turn lets the chain go on at once.
            ChainJob::Gate { go, done } => {
                if go.send(()).is_ok() {
                    done.await.unwrap_or(());
                }
            }
        }
    }

    // Steers `item` into `run_id`, unless an interrupt now holds the run: its choice then decides
    // the message, which waits unhanded. The run is marked in flight for the driver call, which an
    // interrupt's hold waits out.
    async fn hand(
        &self,
        session_id: SessionId,
        run_id: RunId,
        driver: &dyn ProviderDriver,
        item: &QueueItemRecord,
    ) -> Result<(), DeliveryError> {
        let run = match self.read_run(run_id).await {
            Ok(Some(run)) => run,
            // A run gone with its session takes nothing.
            Ok(None) => {
                self.forget_hand(item.id);
                return Ok(());
            }
            Err(error) => {
                self.forget_hand(item.id);
                return Err(error);
            }
        };
        {
            let mut state = self.lock_state();
            if state.interrupt_holds.contains(&run_id) {
                state.handed.remove(&item.id);
                return Ok(());
            }
            chain_of(&state, session_id).mark_in_flight(Some(run_id));
        }
        let steered = driver
            .apply_intervention(steer_of(item, run_id, run.version))
            .await;
        chain_of(&self.lock_state(), session_id).mark_in_flight(None);
        match steered {
            // A message that settled a held choice started the next turn, which took it.
            Ok(response) => match response.delivered_run_id {
                Some(delivered_run_id) => self.record_admission(item, delivered_run_id).await,
                None => Ok(()),
            },
            Err(error) => {
                self.settle_failed_hand(session_id, item, run_id, error)
                    .await
            }
        }
    }

    // Makes every steer in send order before any is awaited, then settles each that failed; one
    // the driver sent stays handed and waiting until the provider's record of it.
    async fn steer_at_boundary(
        &self,
        session_id: SessionId,
        run_id: RunId,
        driver: &dyn ProviderDriver,
        items: &[QueueItemRecord],
    ) {
        let run = match self.read_run(run_id).await {
            Ok(Some(run)) => run,
            // Nothing was sent, so the messages wait for the run's next hand.
            read => {
                for item in items {
                    self.forget_hand(item.id);
                }
                if let Err(error) = read {
                    tracing::error!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &error as &(dyn Error + 'static),
                        "the messages held for a tool boundary could not be handed"
                    );
                }
                return;
            }
        };
        let answers = join_all(
            items
                .iter()
                .map(|item| driver.apply_intervention(steer_of(item, run_id, run.version))),
        )
        .await;
        for (item, answer) in items.iter().zip(answers) {
            if let Err(error) = answer {
                let settled = self
                    .settle_failed_hand(session_id, item, run_id, error)
                    .await;
                log_job_failure(session_id, item.id, settled);
            }
        }
    }

    // A hand that failed: a steer whose turn ended waits for the next turn quietly; any other
    // failure reads not delivered while the run has not ended. The hand is forgotten once the
    // write lands, so no hand in between sends the message again.
    async fn settle_failed_hand(
        &self,
        session_id: SessionId,
        item: &QueueItemRecord,
        run_id: RunId,
        error: DriverError,
    ) -> Result<(), DeliveryError> {
        if matches!(error, DriverError::SteerTurnEnded(_)) {
            self.forget_hand(item.id);
            return Ok(());
        }
        tracing::warn!(
            session_id = %session_id,
            queue_item_id = %item.id,
            run_id = %run_id,
            error = &error as &(dyn Error + 'static),
            "a queued message could not be handed to its run"
        );
        let recorded = self.record_failed_while_live(item, run_id).await;
        self.forget_hand(item.id);
        recorded
    }

    async fn record_failed_while_live(
        &self,
        item: &QueueItemRecord,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        match self.read_run(run_id).await? {
            Some(run) if !run.state.is_terminal() => self.record_failed(item).await,
            Some(_) | None => Ok(()),
        }
    }

    // Withdraws every candidate at once, unless the caller's deadline passed before the chain
    // reached the job: the caller has then answered for them, and nothing reaches the driver.
    async fn withdraw_all(&self, session_id: SessionId, job: WithdrawJob) {
        let WithdrawJob {
            candidates,
            deadline,
            has_started,
            reply,
        } = job;
        {
            let mut is_started = lock_flag(&has_started);
            if deadline.is_cancelled() {
                return;
            }
            *is_started = true;
        }
        let withdrawals = join_all(
            candidates
                .iter()
                .map(|item| self.withdraw(session_id, item, &deadline)),
        )
        .await;
        let answer: WithdrawReply = candidates
            .iter()
            .zip(withdrawals)
            .map(|(item, withdrawal)| withdrawal.map(|withdrawal| (item.id, withdrawal)))
            .collect();
        // A caller that left reads no failure, so the log keeps it.
        if let Err(Err(error)) = reply.send(answer) {
            tracing::error!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "taking queued messages back from their provider failed"
            );
        }
    }

    // One withdraw of a take-back, bounded by the take-back's deadline. A message the provider
    // does not answer for in time stays handed, since the provider may still start a turn with
    // it, and its late answer is settled on the chain.
    async fn withdraw(
        &self,
        session_id: SessionId,
        item: &QueueItemRecord,
        deadline: &CancellationToken,
    ) -> Result<QueueWithdrawal, DeliveryError> {
        let handed = self.lock_state().handed.get(&item.id).copied();
        let Some(handed) = handed else {
            return Ok(QueueWithdrawal::Returned);
        };
        let can_withdraw = match handed.route {
            HandRoute::Driver(handing) => handing.can_withdraw,
            HandRoute::Continue => false,
        };
        if !can_withdraw {
            return Ok(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        }
        let driver = self.driver_of(handed.run_id).await?;
        let params = WithdrawQueuedMessageParams {
            session_id,
            run_id: handed.run_id,
            client_idempotency_key: item.id,
        };
        let mut withdrawing = Box::pin(async move { driver.withdraw_queued_message(params).await });
        match wait_within(withdrawing.as_mut(), WITHDRAW_DEADLINE, Some(deadline)).await {
            None => {
                let delivery = self.clone();
                let late_item = item.clone();
                tokio::spawn(
                    async move {
                        let is_delivered = match withdrawing.await {
                            Ok(answer) => {
                                tracing::info!(
                                    session_id = %session_id,
                                    queue_item_id = %late_item.id,
                                    answer = ?answer,
                                    "the provider answered a withdraw after the deadline"
                                );
                                matches!(answer, WithdrawQueuedMessageResult::AlreadyDelivered {})
                            }
                            Err(error) => {
                                tracing::warn!(
                                    session_id = %session_id,
                                    queue_item_id = %late_item.id,
                                    error = &error as &(dyn Error + 'static),
                                    "a withdraw failed after the deadline"
                                );
                                false
                            }
                        };
                        let late = LateWithdraw {
                            item: late_item,
                            handed_run_id: handed.run_id,
                            hand_number: handed.hand_number,
                            is_delivered,
                        };
                        delivery.push(session_id, ChainJob::LateWithdraw(late));
                    }
                    .instrument(tracing::Span::current()),
                );
                self.record_unreturned(item, "was not answered within the deadline")
                    .await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
            }
            Some(Err(error)) => {
                self.forget_hand(item.id);
                tracing::warn!(
                    session_id = %session_id,
                    queue_item_id = %item.id,
                    error = &error as &(dyn Error + 'static),
                    "a withdraw of a queued message failed"
                );
                self.record_unreturned(item, "failed").await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
            }
            Some(Ok(WithdrawQueuedMessageResult::AlreadyDelivered {})) => {
                self.record_admission(item, handed.run_id).await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::Taken))
            }
            Some(Ok(WithdrawQueuedMessageResult::Withdrawn {})) => {
                self.forget_hand(item.id);
                Ok(QueueWithdrawal::Returned)
            }
        }
    }

    // A message the provider recorded as taken by `run_id`. One the driver handed is admitted
    // while it waits, else, reading not delivered, admitted late; its interrupted run is then
    // continued, as the provider keeps no turn for it. One not handed that reads not delivered in
    // this session is admitted late.
    async fn settle_taken(
        &self,
        session_id: SessionId,
        item_id: QueueItemId,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let item = self.read_item(item_id).await?;
        let handed = self.lock_state().handed.get(&item_id).copied();
        match handed {
            Some(handed) => match handed.route {
                HandRoute::Driver(_) => {
                    match item {
                        Some(item) if item.state == RecordedQueueItemState::Queued => {
                            self.record_admission(&item, run_id).await?;
                        }
                        Some(_) | None => {
                            self.forget_hand(item_id);
                            self.admit_undelivered(item_id, run_id).await?;
                        }
                    }
                    self.continue_if_interrupted(session_id, handed.run_id)
                        .await
                }
                HandRoute::Continue => Ok(()),
            },
            None => match item {
                Some(item) if item.session_id == session_id => {
                    self.admit_undelivered(item_id, run_id).await
                }
                Some(_) | None => Ok(()),
            },
        }
    }

    // Settles a withdraw answered past the deadline, unless the message's hand changed since the
    // withdraw saw it: one the provider had taken is admitted late, and with the message no longer
    // the provider's to keep, its interrupted run is continued.
    async fn settle_late_withdraw(
        &self,
        session_id: SessionId,
        late: LateWithdraw,
    ) -> Result<(), DeliveryError> {
        {
            let mut state = self.lock_state();
            let is_same_hand = state
                .handed
                .get(&late.item.id)
                .is_some_and(|handed| handed.hand_number == late.hand_number);
            if !is_same_hand {
                return Ok(());
            }
            state.handed.remove(&late.item.id);
        }
        if late.is_delivered {
            self.admit_undelivered(late.item.id, late.handed_run_id)
                .await?;
        }
        self.continue_if_interrupted(session_id, late.handed_run_id)
            .await
    }

    async fn continue_if_interrupted(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let run = self.read_run(run_id).await?;
        if run.is_some_and(|run| run.state == RunState::Interrupted) {
            self.shared
                .deps
                .continuation
                .continue_interrupted_run(session_id, run_id);
        }
        Ok(())
    }

    // Admits a message that reads not delivered into `run_id`, unless something moved it
    // meanwhile. One a retry superseded, before or during the write, stays so: the agent then has
    // it twice, which is logged.
    async fn admit_undelivered(
        &self,
        item_id: QueueItemId,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let is_superseded = match self.read_item(item_id).await? {
            Some(item) if matches!(item.state, RecordedQueueItemState::NotDelivered { .. }) => {
                let admitted = self
                    .shared
                    .deps
                    .recorder
                    .record_late_admission(&item, run_id, &WireInstant::now())
                    .await;
                match admitted {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        let is_superseded = error.is_refused()
                            && self.read_item(item_id).await?.is_some_and(|item| {
                                item.state == RecordedQueueItemState::Superseded
                            });
                        if !is_superseded {
                            return Err(error.into());
                        }
                        true
                    }
                }
            }
            Some(item) => item.state == RecordedQueueItemState::Superseded,
            None => false,
        };
        if is_superseded {
            tracing::warn!(
                queue_item_id = %item_id,
                run_id = %run_id,
                "the agent took a message a retry sent again, so it has it twice"
            );
        }
        Ok(())
    }
}

// The chain of `session_id`, which lives while its drain runs a job.
fn chain_of(state: &DeliveryState, session_id: SessionId) -> &SessionChain {
    state
        .chains
        .get(&session_id)
        .expect("a session's chain lives while its drain runs a job")
}

// Logs a job's failure on `item_id`: no caller waits for a drained job.
fn log_job_failure(
    session_id: SessionId,
    item_id: QueueItemId,
    settled: Result<(), DeliveryError>,
) {
    if let Err(error) = settled {
        tracing::error!(
            session_id = %session_id,
            queue_item_id = %item_id,
            error = &error as &(dyn Error + 'static),
            "settling a queued message failed"
        );
    }
}
