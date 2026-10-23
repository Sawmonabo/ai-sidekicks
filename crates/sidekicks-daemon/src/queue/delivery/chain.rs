//! Each session's chain: the jobs that hand, withdraw and settle its messages, pushed in call order
//! under the delivery's mutex and run one at a time by one drain task, which lives only while the
//! chain holds a job. A job's failure is logged, since no caller waits for it, and the drain goes
//! on.

use std::collections::VecDeque;
use std::collections::hash_map::Entry;
use std::error::Error;
use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::{oneshot, watch};
use tracing::Instrument as _;

use crate::provider::driver::contract::{DriverError, ProviderDriver};
use crate::queue::delivery::state::{DeliveryState, HandRoute};
use crate::queue::delivery::withdraw::{LateWithdraw, WithdrawJob};
use crate::queue::delivery::{DeliveryError, QueueDelivery, steer_of};
use crate::queue::store::{QueueItemOutcome, QueueItemRecord, RecordedQueueItemState};

/// One session's jobs in push order, and the run a `Hand` or `ToolBoundary` job is inside its
/// driver call for.
pub(super) struct SessionChain {
    jobs: VecDeque<ChainJob>,
    in_flight: watch::Sender<Option<RunId>>,
}

impl SessionChain {
    /// Follows the run a `Hand` or `ToolBoundary` job is inside its driver call for; the follow
    /// closes once the chain ends, when nothing is in flight.
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
        /// Whether the provider reads them ahead of what it holds: a person's `Send now`.
        is_priority: bool,
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
    /// Settles a handed message the provider refused after the hand.
    Refused {
        /// The message.
        item_id: QueueItemId,
        /// Why it was not delivered.
        reason: QueueItemNotDeliveredReason,
    },
    /// Settles a withdraw the provider answered past the deadline; boxed, since the message it
    /// carries outweighs every other job.
    LateWithdraw(Box<LateWithdraw>),
    /// Gives a caller its turn between the jobs: `go` says it is its turn, and the drain waits
    /// until `done` closes.
    Gate {
        /// Sent when the caller's turn comes.
        go: oneshot::Sender<()>,
        /// Closes when the caller's turn is over.
        done: oneshot::Receiver<()>,
    },
}

impl QueueDelivery {
    /// Settles a message the daemon handed `session_id`'s provider and the provider then refused,
    /// on the session's chain: it reads not delivered for `reason` and its hand is let go, so a
    /// retry sends it again. `message_id` is the provider's own; one that is no queue item id, or
    /// names a message not handed, is dropped.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex driver's delivery of a steer the person's prompt hook refused"
        )
    )]
    pub(crate) fn refuse_handed(
        &self,
        session_id: SessionId,
        message_id: &str,
        reason: QueueItemNotDeliveredReason,
    ) {
        let Ok(item_id) = QueueItemId::new(message_id) else {
            return;
        };
        self.push(session_id, ChainJob::Refused { item_id, reason });
    }

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
                self.shared.tasks.spawn(
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
                is_priority,
            } => {
                for item in &items {
                    let handed = self
                        .hand(session_id, run_id, driver.as_ref(), item, is_priority)
                        .await;
                    log_job_failure(session_id, item.id, handed);
                }
            }
            ChainJob::ToolBoundary {
                run_id,
                driver,
                items,
            } => {
                self.steer_at_boundary(session_id, run_id, driver.as_ref(), &items)
                    .await;
            }
            ChainJob::Withdraw(job) => self.withdraw_all(session_id, job).await,
            ChainJob::MessageTaken { item_id, run_id } => {
                let settled = self.settle_taken(session_id, item_id, run_id).await;
                log_job_failure(session_id, item_id, settled);
            }
            ChainJob::Refused { item_id, reason } => {
                let settled = self.settle_refused(item_id, reason).await;
                log_job_failure(session_id, item_id, settled);
            }
            ChainJob::LateWithdraw(late) => {
                let item_id = late.item.id;
                let settled = self.settle_late_withdraw(session_id, *late).await;
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
        is_priority: bool,
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
            if state.interrupt_holds.contains_key(&run_id) {
                state.forget_hand(&item.id);
                return Ok(());
            }
            chain_of(&state, session_id).mark_in_flight(Some(run_id));
        }
        let steered = driver
            .apply_intervention(steer_of(item, run_id, run.version, is_priority))
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
    // the driver sent stays handed and waiting until the provider's record of it. An interrupt
    // that now holds the run decides the messages instead, which wait unhanded for its choice,
    // since the provider drops a steer when its turn is aborted. The run is marked in flight for
    // the driver calls, which an interrupt's hold waits out.
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
        {
            let mut state = self.lock_state();
            if state.interrupt_holds.contains_key(&run_id) {
                for item in items {
                    state.forget_hand(&item.id);
                }
                return;
            }
            chain_of(&state, session_id).mark_in_flight(Some(run_id));
        }
        let answers = join_all(
            items
                .iter()
                .map(|item| driver.apply_intervention(steer_of(item, run_id, run.version, false))),
        )
        .await;
        chain_of(&self.lock_state(), session_id).mark_in_flight(None);
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

    // A handed message the provider refused: still waiting, it reads not delivered for `reason`;
    // the hand goes once the write lands or fails, so no hand in between sends it again.
    async fn settle_refused(
        &self,
        item_id: QueueItemId,
        reason: QueueItemNotDeliveredReason,
    ) -> Result<(), DeliveryError> {
        if self.lock_state().hand_of(&item_id).is_none() {
            return Ok(());
        }
        let recorded = match self.read_item(item_id).await? {
            Some(item) if item.state == RecordedQueueItemState::Queued => self
                .shared
                .deps
                .recorder
                .record_outcome(
                    &item,
                    QueueItemOutcome::NotDelivered { reason },
                    &WireInstant::now(),
                )
                .await
                .map_err(DeliveryError::from),
            Some(_) | None => Ok(()),
        };
        self.forget_hand(item_id);
        recorded
    }

    // A message the provider recorded as taken by `run_id`. One the driver handed is admitted
    // while it waits, else, reading not delivered, admitted late; its interrupted run is then
    // continued, as the provider keeps no turn for it. One a resume kept is admitted, its resume
    // having delivered it after all. One not handed that reads not delivered in this session is
    // admitted late.
    async fn settle_taken(
        &self,
        session_id: SessionId,
        item_id: QueueItemId,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let item = self.read_item(item_id).await?;
        let handed = self.lock_state().hand_of(&item_id).copied();
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
                HandRoute::Continue { is_kept: true, .. } => match item {
                    Some(item) if item.state == RecordedQueueItemState::Queued => {
                        self.record_admission(&item, run_id).await
                    }
                    Some(_) | None => {
                        self.forget_hand(item_id);
                        Ok(())
                    }
                },
                HandRoute::Continue { is_kept: false, .. } => Ok(()),
            },
            None => match item {
                Some(item) if item.session_id == session_id => {
                    self.admit_undelivered(item_id, run_id).await
                }
                Some(_) | None => Ok(()),
            },
        }
    }

    /// Continues the interrupted run `run_id`, the provider keeping no message for it. Fails when
    /// the run's read fails.
    pub(super) async fn continue_if_interrupted(
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

    /// Admits a message that reads not delivered into `run_id`, unless something moved it
    /// meanwhile. One a retry superseded, before or during the write, stays so: the agent then has
    /// it twice, which is logged. Fails when a read or the admission's write fails.
    pub(super) async fn admit_undelivered(
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
