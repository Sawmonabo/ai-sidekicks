use std::collections::BTreeSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{Config, ErrorKind, EventHandler, NullWatcher, RecursiveMode, Watcher, WatcherKind};
use sidekicks_platforms::WATCHES_TREES;
use tokio::time::timeout;

use super::{
    FileWatch, FileWatchNotice, WalkFilter, WatchedRoot, lowered_for_clock_step,
    wait_for_the_next_whole_second,
};
use sidekicks_std::mutex_lock::lock;

const WAIT: Duration = Duration::from_secs(15);

// How many watches the ceiling watcher was asked for.
static CEILING_WATCH_CALLS: AtomicUsize = AtomicUsize::new(0);

// What the ceiling watcher watched once it had room.
static CEILING_WATCHED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

// A system watch whose ceiling refuses the first two watches it is asked for, then has room.
struct CeilingWatcher;

impl Watcher for CeilingWatcher {
    fn new<F: EventHandler>(_handler: F, _config: Config) -> notify::Result<Self> {
        Ok(Self)
    }

    fn watch(&mut self, path: &Path, _mode: RecursiveMode) -> notify::Result<()> {
        if CEILING_WATCH_CALLS.fetch_add(1, Ordering::AcqRel) < 2 {
            return Err(notify::Error::new(ErrorKind::MaxFilesWatch));
        }
        lock(&CEILING_WATCHED).push(path.to_path_buf());
        Ok(())
    }

    fn unwatch(&mut self, _path: &Path) -> notify::Result<()> {
        Ok(())
    }

    fn kind() -> WatcherKind {
        WatcherKind::NullWatcher
    }
}

// `path` watched whole.
fn watched_whole(path: &Path) -> WatchedRoot {
    WatchedRoot {
        path: path.to_path_buf(),
        filter: WalkFilter::new(|_| true),
    }
}

// The next change the watch tells, skipping none.
async fn next_change<W: Watcher + Send + 'static>(watch: &mut FileWatch<W>) -> Vec<PathBuf> {
    match timeout(WAIT, watch.next_notice()).await {
        Ok(Some(FileWatchNotice::Changed(paths))) => paths,
        other => panic!("expected a change in time, read {other:?}"),
    }
}

fn age_by_an_hour(path: &Path) {
    File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now() - Duration::from_secs(3_600)))
        .expect("the file is aged");
}

// Catches a network root left to a system watch that never tells another computer's change: the
// system watch here tells nothing, so only the poll can see the write.
#[tokio::test]
async fn a_root_on_a_network_file_system_is_polled() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let (mut watch, _feed) =
        FileWatch::<NullWatcher>::start_checking(vec![watched_whole(scratch.path())], |_| Ok(true))
            .await
            .expect("the watch starts");
    let written = watch.roots()[0].join("from-another-computer.txt");
    fs::write(&written, "written").expect("a file is written");

    loop {
        if next_change(&mut watch).await.contains(&written) {
            break;
        }
    }
}

// Catches roots the ceiling refused left unwatched for good, a retry that walks a root while
// another still waits and so watches none of its folders, and a late watch that tells the whole
// unchanged tree: once the retry finds room, every refused root is watched and walked, its folders
// watched where each takes a watch of its own, and only what changed since the refusal is told.
#[tokio::test]
async fn roots_refused_at_the_ceiling_are_watched_and_walked_on_the_retry() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let roots = [scratch.path().join("first"), scratch.path().join("second")];
    for root in &roots {
        fs::create_dir_all(root.join("inside")).expect("a root and its folder are made");
        let unchanged = root.join("unchanged.txt");
        fs::write(&unchanged, "old").expect("a file is written");
        age_by_an_hour(&unchanged);
    }
    // The retry counts whole seconds, so each unchanged file's last change is left a second
    // behind the refusal.
    wait_for_the_next_whole_second().await;
    let (mut watch, _feed) = FileWatch::<CeilingWatcher>::start_checking(
        roots.iter().map(|root| watched_whole(root)).collect(),
        |_| Ok(false),
    )
    .await
    .expect("the watch starts though its roots are refused");
    let written: BTreeSet<PathBuf> = watch
        .roots()
        .iter()
        .map(|root| root.join("written-meanwhile.txt"))
        .collect();
    for path in &written {
        fs::write(path, "new").expect("a file is written");
    }

    assert!(matches!(
        timeout(WAIT, watch.next_notice()).await,
        Ok(Some(FileWatchNotice::Incomplete))
    ));
    let mut told = BTreeSet::new();
    while told.len() < written.len() {
        told.extend(next_change(&mut watch).await);
    }
    assert_eq!(told, written);
    if !WATCHES_TREES {
        let inside: Vec<PathBuf> = watch
            .roots()
            .iter()
            .map(|root| root.join("inside"))
            .collect();
        let watched = lock(&CEILING_WATCHED);
        assert!(
            inside.iter().all(|folder| watched.contains(folder)),
            "{watched:?}"
        );
    }
}

// Catches a rescan that trusts a wall clock set back: a change written after the step carries a
// time before the instant the feed was last whole, so the rescan reports from that much earlier.
#[test]
fn a_wall_clock_set_back_lowers_the_rescan_instant_by_the_step() {
    let whole_since = UNIX_EPOCH + Duration::from_secs(1_000_000);
    let elapsed = Duration::from_secs(60);
    let step = Duration::from_secs(3_600);

    assert_eq!(
        lowered_for_clock_step(whole_since, elapsed, whole_since + elapsed),
        whole_since
    );
    assert_eq!(
        lowered_for_clock_step(whole_since, elapsed, whole_since + elapsed + step),
        whole_since,
        "a clock set forward reports from the same instant"
    );
    assert_eq!(
        lowered_for_clock_step(whole_since, elapsed, whole_since + elapsed - step),
        whole_since - step
    );
}
