//! The approval service a test builds over a test database, and the bound on a wait a test expects
//! to settle.

use std::sync::{Arc, Weak};
use std::time::Duration;

use sidekicks_platforms::WallClockTimer;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::occupancy::MountOccupancyReader;
use sidekicks_workspace::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps};

use super::ApprovalService;
use crate::run_blocking::ApprovalRunHolds;
use crate::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;

/// Bounds a wait the test expects to settle, so one that never does fails the test.
pub const SETTLE_WAIT: Duration = Duration::from_secs(5);

/// The approval service on `database`, appending through `events` and writing through `writer`,
/// with its run holds reaching `engine`; a working-folder watcher over `event_log` stands by it.
pub fn test_approval_service(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    events: Arc<SessionEventAppender>,
    writer: Arc<DatabaseWriter>,
    engine: Weak<RunEngine>,
) -> (Arc<ApprovalService>, Arc<ApprovalRunHolds>) {
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        APPROVAL_REQUEST_READER_STATEMENT_CAPACITY,
    ));
    let run_holds = Arc::new(ApprovalRunHolds::new(engine, Arc::clone(&reads)));
    let watcher_reads = Arc::new(DatabaseReadPool::new(database.path(), 8));
    let working_folders = Arc::new(WorkingFolderWatcher::new(WorkingFolderWatcherDeps {
        git: test_git_runner(),
        reads: Arc::clone(&watcher_reads),
        occupancy: MountOccupancyReader::new(watcher_reads),
        events: Arc::new(WorktreeEventEmitter::new(event_log)),
        scheduler: Arc::new(Scheduler::start(
            Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
            None,
            tokio::sync::watch::channel(0).1,
        )),
        read_watch_ceiling: || Ok(None),
        slow_tick_interval: Duration::from_secs(180),
    }));
    let service = Arc::new(ApprovalService::new(
        reads,
        events,
        writer,
        working_folders,
        Arc::clone(&run_holds),
    ));
    (service, run_holds)
}
