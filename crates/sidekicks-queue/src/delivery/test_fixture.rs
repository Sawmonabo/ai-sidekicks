//! A delivery other crates' tests build over their own test store, with no provider process, no
//! run being started and no interrupted run to continue, and the hand a send into a live run
//! makes.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::process_identity::ProcessStandIn;
use sidekicks_session::queue_store::QueueItemRecord;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventLogService;

use crate::changes::QueueChangeSignals;
use crate::delivery::{
    DeliveryError, InterruptedRunContinuation, OpeningMessages, QueueDelivery, QueueDeliveryDeps,
};
use crate::recorder::{QueueRecorder, QueueRecorderDeps};
use crate::session_lock::QueueSessionLock;

/// No run is being started, so no waiting message opens one.
struct NoOpenings;

impl OpeningMessages for NoOpenings {
    fn is_opening(&self, _item: &QueueItemRecord) -> bool {
        false
    }
}

/// No run rests interrupted for a continue.
struct NoContinuation;

impl InterruptedRunContinuation for NoContinuation {
    fn continue_interrupted_run(&self, _session_id: SessionId, _run_id: RunId) {}
}

/// A delivery reading through `pool`, recording each outcome in `event_log` and `writer`, and
/// finding each run's driver in `providers`, while no session runs a provider process.
pub fn test_delivery(
    pool: Arc<DatabaseReadPool>,
    event_log: Arc<EventLogService>,
    writer: Arc<DatabaseWriter>,
    providers: Arc<ProviderRegistry>,
) -> QueueDelivery {
    let recorder = Arc::new(QueueRecorder::new(QueueRecorderDeps {
        event_log,
        writer,
        pool: Arc::clone(&pool),
        signals: Arc::new(QueueChangeSignals::new()),
    }));
    QueueDelivery::new(QueueDeliveryDeps {
        pool,
        recorder,
        providers,
        session_lock: Arc::new(QueueSessionLock::new()),
        processes: Arc::new(ProcessStandIn::default()),
        openings: Arc::new(NoOpenings),
        continuation: Arc::new(NoContinuation),
    })
}

/// Hands `run_id` of `session_id` every lead message waiting for it not yet handed, as a send into
/// the live run does, under the session's queue lock, and waits until the hands reached its
/// driver. Fails as the hand does.
pub async fn hand_waiting_messages(
    delivery: &QueueDelivery,
    session_id: SessionId,
    run_id: RunId,
) -> Result<(), DeliveryError> {
    {
        let hold = delivery
            .shared
            .deps
            .session_lock
            .hold_session(session_id)
            .await;
        delivery.hand_waiting(&hold, run_id).await?;
    }
    delivery.settle(session_id).await;
    Ok(())
}
