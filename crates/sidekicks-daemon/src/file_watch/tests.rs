use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use notify::{Config, ErrorKind, EventHandler, NullWatcher, RecursiveMode, Watcher, WatcherKind};
use tokio::time::timeout;

use super::{FileWatch, FileWatchNotice, WalkFilter};

const WAIT: Duration = Duration::from_secs(15);

// Whether the ceiling watcher has refused its one root yet.
static HAS_REFUSED_AT_CEILING: AtomicBool = AtomicBool::new(false);

// A system watch whose ceiling refuses the first watch it is asked for, then has room.
struct CeilingWatcher;

impl Watcher for CeilingWatcher {
    fn new<F: EventHandler>(_handler: F, _config: Config) -> notify::Result<Self> {
        Ok(Self)
    }

    fn watch(&mut self, _path: &Path, _mode: RecursiveMode) -> notify::Result<()> {
        if HAS_REFUSED_AT_CEILING.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        Err(notify::Error::new(ErrorKind::MaxFilesWatch))
    }

    fn unwatch(&mut self, _path: &Path) -> notify::Result<()> {
        Ok(())
    }

    fn kind() -> WatcherKind {
        WatcherKind::NullWatcher
    }
}

fn keeps_everything() -> WalkFilter {
    WalkFilter::new(|_| true)
}

// The next change the watch tells, skipping none.
async fn next_change<W: Watcher + Send + 'static>(watch: &mut FileWatch<W>) -> Vec<PathBuf> {
    match timeout(WAIT, watch.next_notice()).await {
        Ok(Some(FileWatchNotice::Changed(paths))) => paths,
        other => panic!("expected a change in time, read {other:?}"),
    }
}

// Catches a network root left to a system watch that never tells another computer's change: the
// system watch here tells nothing, so only the poll can see the write.
#[tokio::test]
async fn a_root_on_a_network_file_system_is_polled() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let (mut watch, _feed) = FileWatch::<NullWatcher>::start_checking(
        vec![scratch.path().to_path_buf()],
        keeps_everything(),
        |_| Ok(true),
    )
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

// Catches a root the ceiling refused left unwatched for good, and a late watch that tells the
// whole unchanged tree: once the retry watches it, only what changed since the start is told.
#[tokio::test]
async fn a_root_refused_at_the_ceiling_is_watched_on_its_retry() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let unchanged = scratch.path().join("unchanged.txt");
    fs::write(&unchanged, "old").expect("a file is written");
    File::options()
        .write(true)
        .open(&unchanged)
        .and_then(|file| file.set_modified(SystemTime::now() - Duration::from_secs(3_600)))
        .expect("the file is aged");
    let (mut watch, _feed) = FileWatch::<CeilingWatcher>::start_checking(
        vec![scratch.path().to_path_buf()],
        keeps_everything(),
        |_| Ok(false),
    )
    .await
    .expect("the watch starts though its root is refused");
    let written = watch.roots()[0].join("written-meanwhile.txt");
    fs::write(&written, "new").expect("a file is written");

    assert!(matches!(
        timeout(WAIT, watch.next_notice()).await,
        Ok(Some(FileWatchNotice::Incomplete))
    ));
    assert_eq!(next_change(&mut watch).await, vec![written]);
}
