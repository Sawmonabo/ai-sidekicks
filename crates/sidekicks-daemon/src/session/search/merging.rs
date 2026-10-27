//! Keeps the search index's segments merged. Each applied batch commits a new segment, and every
//! search reads each one, so whenever the merge policy proposes a merge one runs: after each
//! commit to the index and after each merge ends, as Tantivy's own segment updater considers
//! merges, one at a time on a blocking thread, never on the async runtime. A failed merge is
//! logged and tried again after the daemon's retry waits; commits meanwhile start none.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt;
use sidekicks_search::index::{SearchIndex, SearchIndexError};
use tokio::sync::Notify;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use sidekicks_std::retry_waits::retry_wait;

/// Merges the search index's segments whenever its merge policy proposes one, on a task of its
/// own until [`SearchIndexMerging::stop`].
pub(crate) struct SearchIndexMerging {
    /// Ends the task between merges.
    stop: CancellationToken,
    /// The task that merges.
    task: JoinHandle<()>,
}

/// Why one merge failed.
#[derive(Debug, thiserror::Error)]
enum SearchIndexMergeError {
    /// The index failed the merge.
    #[error(transparent)]
    Index(#[from] SearchIndexError),
    /// The blocking task running the merge ended without an answer.
    #[error("the search index merge's task ended without an answer")]
    Task(#[from] JoinError),
}

impl SearchIndexMerging {
    /// Starts merging `index`, first what it already proposes, then after each durable commit of a
    /// batch to it, which its applier signals with `index_commits.notify_one()`; a merge is no such
    /// commit.
    pub(crate) fn start(index: Arc<SearchIndex>, index_commits: Arc<Notify>) -> Self {
        let stop = CancellationToken::new();
        let task = tokio::spawn(keep_merged(index, index_commits, stop.clone()));
        Self { stop, task }
    }

    /// Stops following commits and merging. A merge already under way finishes; this settles once
    /// it has, failing only when the task itself ended abnormally.
    pub(crate) async fn stop(self) -> Result<(), JoinError> {
        self.stop.cancel();
        self.task.await
    }
}

async fn keep_merged(index: Arc<SearchIndex>, index_commits: Arc<Notify>, stop: CancellationToken) {
    let mut failed_passes_in_row = 0;
    loop {
        match merge_while_proposed(&index, &index_commits, &stop).await {
            Ok(()) => {
                failed_passes_in_row = 0;
                tokio::select! {
                    () = index_commits.notified() => {}
                    () = stop.cancelled() => return,
                }
            }
            Err(error) => {
                let wait = retry_wait(failed_passes_in_row);
                failed_passes_in_row += 1;
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    retry_in = ?wait,
                    "search_index_merge_failed"
                );
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = stop.cancelled() => return,
                }
            }
        }
    }
}

// One pass: merges while the policy proposes more or a commit landed during the last merge.
async fn merge_while_proposed(
    index: &Arc<SearchIndex>,
    index_commits: &Notify,
    stop: &CancellationToken,
) -> Result<(), SearchIndexMergeError> {
    let mut is_more_to_merge = true;
    while is_more_to_merge && !stop.is_cancelled() {
        // A commit before this merge is covered by it.
        take_commit_signal(index_commits);
        let merging = Arc::clone(index);
        let merged_with_more =
            tokio::task::spawn_blocking(move || merging.merge_segments()).await??;
        is_more_to_merge = merged_with_more || take_commit_signal(index_commits);
    }
    Ok(())
}

// Whether a commit was signaled since the signal was last taken, taking it.
fn take_commit_signal(index_commits: &Notify) -> bool {
    index_commits.notified().now_or_never().is_some()
}
