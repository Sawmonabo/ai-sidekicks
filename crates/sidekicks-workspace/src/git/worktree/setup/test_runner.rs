//! A setup runner for tests: no file watch behind its warm step and the wall clock for the
//! watch's slow ticks.

use std::sync::Arc;
use std::time::Duration;

use notify::NullWatcher;
use sidekicks_platforms::{Spawner, WallClockTimer};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use super::{WorktreeSetupRunner, WorktreeSetupRunnerDeps, WorktreeSetupSources};
use crate::git::process::GitRunner;
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps, no_ceiling};

// The watch's slow tick, far beyond any test.
const SLOW_TICK_INTERVAL: Duration = Duration::from_secs(180);

/// A runner over `git`, `reads` and `events` reading its steps from `sources`. Panics when the
/// spawner thread or the timer cannot be had.
pub(crate) fn test_setup_runner(
    git: GitRunner,
    reads: Arc<DatabaseReadPool>,
    events: Arc<WorktreeEventEmitter>,
    sources: Arc<dyn WorktreeSetupSources>,
) -> WorktreeSetupRunner<NullWatcher> {
    let watcher = Arc::new(WorkingFolderWatcher::<NullWatcher>::new(
        WorkingFolderWatcherDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            occupancy: MountOccupancyReader::new(reads),
            events,
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
                tokio::sync::watch::channel(0).1,
            )),
            read_watch_ceiling: no_ceiling,
            slow_tick_interval: SLOW_TICK_INTERVAL,
        },
    ));
    WorktreeSetupRunner::new(WorktreeSetupRunnerDeps {
        git,
        spawner: Spawner::new(tokio::runtime::Handle::current())
            .expect("the spawner thread starts"),
        watcher,
        sources,
    })
}
