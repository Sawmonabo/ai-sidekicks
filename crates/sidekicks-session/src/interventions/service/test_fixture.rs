//! What the interventions service's tests and other crates' tests share: a run queue that hands
//! each interrupt's end straight to the run engine, and a service built over it and wired to the
//! engine as the daemon wires them.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::interventions::interrupt_queue::{
    InterruptCause, InterruptChoice, InterruptEnd, InterruptQueue, InterruptQueueError, SendNow,
    SendNowOutcome,
};
use crate::interventions::service::{InterventionService, InterventionServiceDeps};
use crate::queue_store::send_now::{SentNow, mark_sent_now_statement, record_sent_now_statement};
use crate::run::engine::RunEngine;

/// An interventions service over `pool`, `engine` and `providers`, its interrupts' ends handed
/// straight to `engine`, which is handed the queue and the service as its limit interrupter, as
/// the daemon wires them. Panics when `engine` was handed either already.
pub fn test_intervention_service(
    pool: Arc<DatabaseReadPool>,
    engine: &Arc<RunEngine>,
    providers: Arc<ProviderRegistry>,
) -> Arc<InterventionService> {
    let queue: Arc<dyn InterruptQueue> = Arc::new(EngineQueue::new(Arc::clone(engine), None));
    engine
        .set_interrupt_queue(Arc::downgrade(&queue) as Weak<dyn InterruptQueue>)
        .expect("the test's engine holds no run queue yet");
    let service = Arc::new(InterventionService::new(InterventionServiceDeps {
        pool,
        engine: Arc::clone(engine),
        providers,
        queue,
    }));
    engine
        .set_limit_interrupter(Arc::downgrade(&service) as Weak<_>)
        .expect("the test's engine holds no interventions service yet");
    service
}

/// A run queue that holds nothing but counts each hold it takes, records each release's choice,
/// and hands each end straight to the run engine; with a writer, it counts each `Send now` it is
/// asked for and marks its message as sent once per key, a key it marked answering the first's id.
pub(crate) struct EngineQueue {
    /// The engine each end is handed to.
    engine: Arc<RunEngine>,
    /// How many holds it has taken.
    pub(crate) holds_taken: Arc<AtomicUsize>,
    /// The choice of each hold it let go, in order.
    pub(crate) releases: Arc<Mutex<Vec<InterruptPendingChoice>>>,
    // The writer a `Send now` marks its message through; none where the provider reads no
    // priority message.
    sends_now: Option<Arc<DatabaseWriter>>,
    /// How many `Send now`s it was asked for.
    pub(crate) sent_now: Arc<AtomicUsize>,
    // Each key a `Send now` marked, with the intervention it marked.
    marked: Mutex<Vec<(ClientUuid, InterventionId)>>,
}

impl EngineQueue {
    /// A queue handing each end to `engine`, with nothing counted, marking a `Send now`'s message
    /// through `sends_now` where the provider reads a priority message.
    pub(crate) fn new(engine: Arc<RunEngine>, sends_now: Option<Arc<DatabaseWriter>>) -> Self {
        Self {
            engine,
            holds_taken: Arc::new(AtomicUsize::new(0)),
            releases: Arc::new(Mutex::new(Vec::new())),
            sends_now,
            sent_now: Arc::new(AtomicUsize::new(0)),
            marked: Mutex::new(Vec::new()),
        }
    }

    // Records the release of a hold with `choice`.
    fn record_release(&self, choice: InterruptChoice) {
        self.releases
            .lock()
            .expect("the test's releases are writable")
            .push(choice.pending);
    }
}

impl InterruptQueue for EngineQueue {
    fn send_now(
        &self,
        send: SendNow,
    ) -> BoxFuture<'_, Result<SendNowOutcome, InterruptQueueError>> {
        async move {
            let writer = self
                .sends_now
                .as_ref()
                .expect("only a provider that reads a priority message sends now");
            let marked = self
                .marked
                .lock()
                .expect("the test's marks are readable")
                .iter()
                .find(|(key, _)| *key == send.key)
                .map(|(_, intervention_id)| *intervention_id);
            self.sent_now.fetch_add(1, Ordering::SeqCst);
            if let Some(intervention_id) = marked {
                return Ok(SendNowOutcome::Sent { intervention_id });
            }
            let now = WireInstant::now();
            let sent = SentNow {
                item_id: send.item_id,
                intervention_id: send.intervention_id,
            };
            writer
                .write(vec![
                    mark_sent_now_statement(&send.item_id, &send.intervention_id, &now),
                    record_sent_now_statement(&send.run_id, &send.key, &sent, &now),
                ])
                .await
                .expect("the test marks the message sent now");
            self.marked
                .lock()
                .expect("the test's marks are writable")
                .push((send.key, send.intervention_id));
            Ok(SendNowOutcome::Sent {
                intervention_id: send.intervention_id,
            })
        }
        .boxed()
    }

    fn reorders_waiting(
        &self,
        _run_id: RunId,
        _deliver_first: Option<QueueItemId>,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>> {
        async { Ok(false) }.boxed()
    }

    fn hold_for_interrupt(
        &self,
        _run_id: RunId,
        _intervention_id: InterventionId,
        _choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        self.holds_taken.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn end_run_for_interrupt(
        &self,
        end: InterruptEnd,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>> {
        let (limit, cut_turn) = match end.cause {
            InterruptCause::Person(_) | InterruptCause::Undo => (None, None),
            InterruptCause::Limit { limit, cut_turn } => (Some(limit), cut_turn),
        };
        async move {
            Ok(self
                .engine
                .end_run_for_interrupt(
                    end.run_id,
                    end.accepted_run_version,
                    limit,
                    cut_turn,
                    end.verdict,
                )
                .await?)
        }
        .boxed()
    }

    fn release_interrupt(
        &self,
        _run_id: RunId,
        _intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        self.record_release(choice);
        async { Ok(()) }.boxed()
    }

    fn release_interrupt_at_run_end(
        &self,
        _run_id: RunId,
        _intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        self.record_release(choice);
        async { Ok(()) }.boxed()
    }
}
