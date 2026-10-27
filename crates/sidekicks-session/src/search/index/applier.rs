//! Applies the outbox to the search index. A run starts when the daemon's writes commit and
//! applies batch after batch until the outbox holds nothing past what it read, so a settled message
//! waits for no timer and no fuller batch. Runs never overlap: the live index's one task calls
//! `SearchIndexApplier::apply_waiting` for each change of the writer's commit count, so a write
//! that commits during a run is read by the next. A row too long for one batch is applied inside
//! the read that reads it, over several commits, so no batch holds much more than its text bound.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use sidekicks_search::index::{IndexBatch, SearchIndex, SearchIndexError};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use tokio::task::JoinError;

use crate::search::index::outbox::{OutboxRead, OutboxReader};

/// Why a run did not apply every waiting row; the index is then behind the database.
#[derive(Debug, thiserror::Error)]
pub enum SearchIndexApplyError {
    /// The outbox or a row it names could not be read.
    #[error("the search outbox's read failed")]
    Database(#[from] rusqlite::Error),
    /// The read did not reach a connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The index failed the batch or is closed.
    #[error("the search index failed to apply an outbox batch")]
    Index(#[from] SearchIndexError),
    /// The blocking task applying the batch ended without an answer.
    #[error("the search index's apply did not finish")]
    Task(#[from] JoinError),
}

/// Applies outbox batches to one index, past the outbox id its newest commit records. Shared by
/// `Arc`: one task runs the applies, and searches read where the floor log stood.
pub(crate) struct SearchIndexApplier {
    index: Arc<SearchIndex>,
    reads: Arc<DatabaseReadPool>,
    // The last outbox id a run read and applied.
    last_read_id: AtomicU64,
    // Where the rowid floor log stood when the index last matched the database; 0, the strictest,
    // until a run has caught up.
    floor_position: AtomicI64,
}

impl SearchIndexApplier {
    /// An applier past the outbox id `index`'s newest commit records, reading through `reads`.
    pub(crate) fn new(index: Arc<SearchIndex>, reads: Arc<DatabaseReadPool>) -> Self {
        let last_read_id = AtomicU64::new(index.last_applied_outbox_id());
        Self {
            index,
            reads,
            last_read_id,
            floor_position: AtomicI64::new(0),
        }
    }

    /// Where the rowid floor log stood when the index last matched the database, so a search
    /// opened now checks every floor logged since.
    pub(crate) fn floor_position(&self) -> i64 {
        self.floor_position.load(Ordering::Acquire)
    }

    /// Applies every outbox row waiting, each batch in its own durable commit on the blocking
    /// pool, calling `on_applied` with the batch's last outbox id once it is durable; returns once
    /// a read leaves no row waiting. A row too long for one batch commits its earlier pages inside
    /// the read, holding the read's connection meanwhile. Only one call runs at a time. Fails with
    /// the read's or the index's failure, the batches before it applied.
    pub(crate) async fn apply_waiting(
        &self,
        mut on_applied: impl FnMut(u64),
    ) -> Result<(), SearchIndexApplyError> {
        loop {
            let after_id = self.last_read_id.load(Ordering::Acquire);
            let reading_index = Arc::clone(&self.index);
            let OutboxRead {
                batch,
                floor_position,
            } = self
                .reads
                .read(ReadLength::Long, move |connection| {
                    OutboxReader::new(connection).read(after_id, &mut |batch: &IndexBatch| {
                        reading_index
                            .apply(batch)
                            .map_err(SearchIndexApplyError::from)
                    })
                })
                .await?;
            if let Some(batch) = batch {
                let last_outbox_id = batch.last_outbox_id;
                let index = Arc::clone(&self.index);
                tokio::task::spawn_blocking(move || index.apply(&batch)).await??;
                self.last_read_id.store(last_outbox_id, Ordering::Release);
                if let Some(floor_position) = floor_position {
                    self.floor_position.store(floor_position, Ordering::Release);
                }
                on_applied(last_outbox_id);
            } else if let Some(floor_position) = floor_position {
                self.floor_position.store(floor_position, Ordering::Release);
            }
            if floor_position.is_some() {
                return Ok(());
            }
        }
    }
}
