//! `agent.queueItem.*`: a person's send to a session's lead and the list, removal and reorder of
//! the messages waiting, and the stream of a queue's changes. A send records the device the call
//! came from. The stream follows from after the cursor a returning screen names, replaying each
//! item changed past it and then every item still waiting, or else from the session's newest event;
//! it reads each frame from the store at its cursor once its lane has credit, so nothing is
//! dropped. A session the daemon does not hold or a cursor it cannot read is refused before
//! anything opens, and a read that fails later ends the subscription with the failure.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::run::control::{
    AgentQueueItemCancel, AgentQueueItemCreate, AgentQueueItemList, AgentQueueItemReorder,
    AgentQueueItemSubscribe,
};
use sidekicks_contracts::run::queue::{AgentQueueItemSubscribeRequest, RunQueueStreamFrame};
use sidekicks_contracts::session::event_cursor::decode_event_cursor;
use sidekicks_contracts::wire::list::BoundedVec;
use tokio::sync::watch;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::events::log_service::{EventLogService, FollowStart};
use crate::events::session::read::{DamagedFromSequenceReader, SessionLogReadError};
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::ipc::stream::feed::{ChangeRecord, Feed, RecordPage};
use crate::ipc::stream::frame_batcher::{ChangeFeed, FrameChanges};
use crate::queue::changes::{
    QueueChange, QueueChangeCursor, QueueChangeReadError, QueueChangeSignals, QueueKey,
    read_current_queue_cursor, read_queue_changes_after,
};
use crate::queue::service::RunQueue;

/// What the queue methods act through.
pub(crate) struct RunQueueMethods {
    /// The run queue.
    pub(crate) queue: Arc<RunQueue>,
    /// The session log, which checks where a stream starts.
    pub(crate) log: Arc<EventLogService>,
    /// The read pool a stream's pages are read through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The queues' change signals, which wake a stream.
    pub(crate) signals: Arc<QueueChangeSignals>,
    /// Where each damaged session's log stops being readable.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// Registers `agent.queueItem.create`, `.list`, `.cancel`, `.reorder` and `.subscribe` over
/// `methods`. Fails the start when one is already registered.
pub(crate) fn register_run_queue(
    registry: &mut MethodRegistryBuilder,
    methods: &RunQueueMethods,
) -> Result<(), RegistrationError> {
    let queue = Arc::clone(&methods.queue);
    registry.register::<AgentQueueItemCreate, _>(move |request, context: HandlerContext| {
        let queue = Arc::clone(&queue);
        async move {
            let device_id = context.calling_device(AgentQueueItemCreate::DESCRIPTOR.method)?;
            Ok(queue.create(request, device_id).await?)
        }
        .boxed()
    })?;
    let queue = Arc::clone(&methods.queue);
    registry.register::<AgentQueueItemList, _>(move |request, _context: HandlerContext| {
        let queue = Arc::clone(&queue);
        async move { Ok(queue.list(request).await?) }.boxed()
    })?;
    let queue = Arc::clone(&methods.queue);
    registry.register::<AgentQueueItemCancel, _>(move |request, _context: HandlerContext| {
        let queue = Arc::clone(&queue);
        async move { Ok(queue.cancel(request).await?) }.boxed()
    })?;
    let queue = Arc::clone(&methods.queue);
    registry.register::<AgentQueueItemReorder, _>(move |request, _context: HandlerContext| {
        let queue = Arc::clone(&queue);
        async move { Ok(queue.reorder(request).await?) }.boxed()
    })?;
    let log = Arc::clone(&methods.log);
    let pool = Arc::clone(&methods.pool);
    let signals = Arc::clone(&methods.signals);
    let read_damaged_from_sequence = Arc::clone(&methods.read_damaged_from_sequence);
    registry.register_subscription::<AgentQueueItemSubscribe, _>(
        move |request: AgentQueueItemSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let queue = QueueKey {
                session_id: request.session_id,
                child_handle: request.child_handle,
            };
            // Taken before the start is read, so a change from then on wakes the stream.
            let change_count = signals.change_count(&queue);
            let record = QueueRecord {
                pool: Arc::clone(&pool),
                signals: Arc::clone(&signals),
                read_damaged_from_sequence: Arc::clone(&read_damaged_from_sequence),
                queue,
                change_count,
            };
            let log = Arc::clone(&log);
            async move {
                let start = request
                    .after_cursor
                    .map_or(FollowStart::Newest, FollowStart::After);
                let is_catching_up = matches!(start, FollowStart::After(_));
                // Refuses a session the daemon does not hold and a cursor it cannot read.
                let followed = log
                    .read_follow_start(record.queue.session_id, start)
                    .await?;
                let cursor = if is_catching_up {
                    let sequence = decode_event_cursor(&followed)
                        .map_err(|error| HandlerError::Internal(Box::new(error)))?;
                    QueueChangeCursor::after(sequence)
                } else {
                    record.read_current_cursor().await.map_err(internal)?
                };
                let feed: Box<dyn Feed<Emission = RunQueueStreamFrame>> =
                    Box::new(ChangeFeed::open(Arc::new(record), cursor, frame_of).await?);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Why a page of a queue's stream could not be read.
#[derive(Debug, thiserror::Error)]
enum QueueStreamError {
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The read itself failed.
    #[error(transparent)]
    Read(#[from] QueueChangeReadError),
    /// The session's newest sequence could not be read.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
}

/// One queue's changes as its stream reads them.
struct QueueRecord {
    pool: Arc<DatabaseReadPool>,
    signals: Arc<QueueChangeSignals>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    queue: QueueKey,
    change_count: watch::Receiver<u64>,
}

impl QueueRecord {
    // The cursor a stream with no catch-up cursor starts at, following from now.
    async fn read_current_cursor(&self) -> Result<QueueChangeCursor, QueueStreamError> {
        let signals = Arc::clone(&self.signals);
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let queue = self.queue.clone();
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueStreamError>(read_current_queue_cursor(
                    reader,
                    read_damaged_from_sequence.as_ref(),
                    &signals,
                    &queue,
                )?)
            })
            .await
    }
}

impl ChangeRecord for QueueRecord {
    type Cursor = QueueChangeCursor;
    type Change = QueueChange;
    type Error = QueueStreamError;

    fn read_after(
        &self,
        cursor: &QueueChangeCursor,
        max: usize,
    ) -> BoxFuture<'_, Result<RecordPage<QueueChange>, QueueStreamError>> {
        let cursor = cursor.clone();
        let signals = Arc::clone(&self.signals);
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let queue = self.queue.clone();
        async move {
            let changes = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, QueueStreamError>(read_queue_changes_after(
                        reader,
                        read_damaged_from_sequence.as_ref(),
                        &signals,
                        &queue,
                        &cursor,
                        max,
                    )?)
                })
                .await?;
            // The queue's read is cut by its count alone.
            Ok(RecordPage {
                changes,
                is_cut_by_size: false,
            })
        }
        .boxed()
    }

    fn cursor_of(change: &QueueChange) -> QueueChangeCursor {
        change.resume_cursor.clone()
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.change_count.clone()
    }

    fn is_store_closed(error: &QueueStreamError) -> bool {
        match error {
            QueueStreamError::Pool(DatabaseReadError::Closed) => true,
            QueueStreamError::Pool(DatabaseReadError::Open(_) | DatabaseReadError::Join(_))
            | QueueStreamError::Read(_)
            | QueueStreamError::Log(_) => false,
        }
    }
}

// A frame of the changes as the stream sends them, each without its resume cursor.
fn frame_of(changes: FrameChanges<QueueChange>) -> RunQueueStreamFrame {
    let changes = changes
        .into_vec()
        .into_iter()
        .map(|change| change.stream_change)
        .collect();
    RunQueueStreamFrame {
        changes: BoundedVec::new(changes).expect("the frame keeps the count it was cut at"),
    }
}

fn internal(error: QueueStreamError) -> HandlerError {
    HandlerError::Internal(Box::new(error))
}
