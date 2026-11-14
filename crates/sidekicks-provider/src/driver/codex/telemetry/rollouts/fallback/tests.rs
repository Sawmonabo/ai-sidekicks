use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{CodexFallbackDue, CodexLaunchRollouts, CodexRolloutFallback};
use crate::pricing::export_status::ExportStatusTracker;

/// The launch's export interval in these tests.
const INTERVAL: Duration = Duration::from_secs(1);

/// When the launch registered, and the stamp the export that ends the stop carries last.
const REGISTERED_AT_MS: u64 = 1_000;
const RETURNED_NEWEST_MS: u64 = 9_000;

// A launch's export status and the fallback over it, on a paused clock.
fn launch() -> (
    Arc<ExportStatusTracker>,
    CodexLaunchRollouts,
    CodexRolloutFallback,
) {
    let scheduler = Arc::new(Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    ));
    let tracker = Arc::new(ExportStatusTracker::new(scheduler, INTERVAL));
    let rollouts = CodexLaunchRollouts::new(&tracker, REGISTERED_AT_MS);
    let fallback = CodexRolloutFallback::new(rollouts.clone());
    (tracker, rollouts, fallback)
}

// A request turn settles unexported and its check, two intervals on, counts the stop.
async fn stop(tracker: &ExportStatusTracker) {
    tracker
        .turn_settled(true, Instant::now())
        .expect("the scheduler runs");
    tokio::time::sleep(INTERVAL * 3).await;
}

// An export carrying no completed response, its newest record stamped `RETURNED_NEWEST_MS`, read
// as the status's lock lets it.
fn export_without_responses(tracker: &ExportStatusTracker, rollouts: &CodexLaunchRollouts) {
    tracker.export_arrived(|stops| {
        rollouts.export_read(
            stops,
            Vec::new(),
            Some(RETURNED_NEWEST_MS),
            RETURNED_NEWEST_MS + 5,
        );
    });
}

// The stop the fallback reads, as a pass takes it: its start, and the newest record of the export
// that ended it, if one has.
fn read_stop(fallback: &CodexRolloutFallback) -> Option<(u64, Option<u64>)> {
    let reading = fallback.reading.as_ref()?;
    let ended_ms = lock(&fallback.rollouts.times)
        .ended(reading.stop)
        .map(|ended| ended.newest_record_ms);
    Some((reading.since_ms, ended_ms))
}

// The files the fallback names as unreadable change the published status but make no pass due:
// the first thing it wakes for is the stop. Killed by a fallback that wakes on any change of the
// published status (a pass due with no stop counted, so none is begun).
#[tokio::test(start_paused = true)]
async fn a_published_file_list_is_no_turn_of_the_export_status() {
    let (tracker, _rollouts, mut fallback) = launch();

    tracker.publish_unreadable_files(vec![PathBuf::from("rollout-a.jsonl")]);
    tracker
        .turn_settled(true, Instant::now())
        .expect("the scheduler runs");

    assert!(matches!(
        fallback.wait_until_due().await,
        CodexFallbackDue::Pass
    ));
    assert!(fallback.next_pass());
    assert!(fallback.is_reading());
}

// An export that arrives after the fallback saw the stop and before it began reading still ends
// the stop it reads, at the newest stamp any record of the export carries, though the export holds
// no completed response, and the pass that begins the stop covers that export. Killed by an end
// recorded only while the fallback already reads (no end: the files followed until the next stop
// ends), by an end taken from the completed responses only (the export's arrival less one), and by
// a second pass for an export the first already covers.
#[tokio::test(start_paused = true)]
async fn an_export_between_the_stop_s_read_and_its_reading_ends_the_stop() {
    let (tracker, rollouts, mut fallback) = launch();
    stop(&tracker).await;
    assert!(matches!(
        fallback.wait_until_due().await,
        CodexFallbackDue::Pass
    ));

    export_without_responses(&tracker, &rollouts);

    assert!(fallback.next_pass());
    assert_eq!(
        read_stop(&fallback),
        Some((REGISTERED_AT_MS, Some(RETURNED_NEWEST_MS)))
    );
    assert!(!fallback.next_pass());
}

// A stop an export ends before the fallback looks is still read, once, from the launch's last
// export on, ended at the returning export's newest record. Killed by a fallback that reads the
// status's current value instead of its count of stops (it sees arriving against arriving and
// never wakes, so the stop is read nowhere).
#[tokio::test(start_paused = true)]
async fn a_stop_the_export_ends_before_the_fallback_looks_is_read_once() {
    let (tracker, rollouts, mut fallback) = launch();
    stop(&tracker).await;
    export_without_responses(&tracker, &rollouts);

    let due = tokio::time::timeout(INTERVAL, fallback.wait_until_due()).await;
    assert!(matches!(due, Ok(CodexFallbackDue::Pass)));
    assert!(fallback.next_pass());
    assert_eq!(
        read_stop(&fallback),
        Some((REGISTERED_AT_MS, Some(RETURNED_NEWEST_MS)))
    );
    assert!(!fallback.next_pass());
}
