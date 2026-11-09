use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{CodexLaunchRollouts, CodexRolloutFallback, CodexStatusTurn};
use crate::pricing::export_status::ExportStatusTracker;

// The files the fallback names as unreadable change the published status but turn nothing: the
// first turn it reads is the stop. Killed by a fallback that wakes on any change of the
// published status (it reads the file list as the exports arriving and stops reading).
#[tokio::test(start_paused = true)]
async fn a_published_file_list_is_no_turn_of_the_export_status() {
    let scheduler = Arc::new(Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    ));
    let tracker = Arc::new(ExportStatusTracker::new(scheduler, Duration::from_secs(1)));
    let mut fallback = CodexRolloutFallback::new(CodexLaunchRollouts::new(&tracker, 0));

    tracker.publish_unreadable_files(vec![PathBuf::from("rollout-a.jsonl")]);
    tracker
        .turn_settled(true, Instant::now())
        .expect("the scheduler runs");

    assert!(matches!(
        fallback.status_turned().await,
        CodexStatusTurn::Stopped
    ));
}
