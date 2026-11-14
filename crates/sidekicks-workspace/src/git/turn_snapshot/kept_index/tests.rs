use std::path::Path;

use sidekicks_platforms::real_path;

use super::open_kept_index;
use crate::git::process::test_repository::{commit_empty, make_test_repository};
use crate::git::process::{read_git_common_folder, test_git_runner_with_environment};
use crate::git::turn_snapshot::capture_folder::CaptureFolder;
use crate::git::turn_snapshot::capture_steps::{SnapshotCheckout, index_lock_path};

// The three settings each call on the kept index carries, as `-c` values.
const GUARDS: [&str; 3] = [
    "core.splitIndex=false",
    "splitIndex.sharedIndexExpire=never",
    "core.fsmonitor=false",
];

// The argument lists of the refreshes git's event trace at `trace` records.
fn traced_refreshes(trace: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(trace).expect("git wrote its trace");
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| event["event"] == "start")
        .filter_map(|event| {
            let arguments: Vec<String> = event["argv"]
                .as_array()?
                .iter()
                .filter_map(|argument| argument.as_str().map(str::to_owned))
                .collect();
            let is_refresh = arguments.iter().any(|argument| argument == "update-index")
                && arguments.iter().any(|argument| argument == "--refresh");
            is_refresh.then_some(arguments)
        })
        .collect()
}

// Fails when the kept index is seeded without the index guards, reseeded while HEAD stands, kept
// after HEAD moves, or left behind a lock file a git ended mid-write left beside it.
#[tokio::test]
async fn the_kept_index_is_seeded_with_its_guards_and_again_only_when_head_moves() {
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let trace = root.path().join("trace.json");
    let trace_text = trace
        .to_str()
        .expect("the temporary folder's path is UTF-8");
    let git = test_git_runner_with_environment(&[("GIT_TRACE2_EVENT", trace_text)]);
    let repository = make_test_repository(&git, root.path(), "repository").await;
    let repository = real_path(&repository).expect("the repository resolves");
    let git_common_folder = read_git_common_folder(&git, None, &repository, None)
        .await
        .expect("the repository's git folder is read");
    let capture_folder =
        CaptureFolder::open_or_create(&git, None, &root.path().join("owner"), &git_common_folder)
            .await
            .expect("the capture folder is made");
    let checkout = SnapshotCheckout {
        git: &git,
        place: None,
        root: &repository,
        capture_folder: &capture_folder,
    };

    let seeded = open_kept_index(&checkout)
        .await
        .expect("the index is seeded");
    let after_seed = traced_refreshes(&trace);
    open_kept_index(&checkout)
        .await
        .expect("the index is reused");
    let after_reuse = traced_refreshes(&trace);
    commit_empty(&git, &repository, "moved").await;
    let stale_lock = index_lock_path(seeded.path());
    std::fs::write(&stale_lock, b"").expect("a stale lock is left");
    let reseeded = open_kept_index(&checkout)
        .await
        .expect("the index is reseeded");
    let after_move = traced_refreshes(&trace);

    assert!(seeded.path().is_file(), "the kept index is written");
    assert_eq!(seeded.path(), reseeded.path());
    assert_eq!(after_seed.len(), 1, "the first use seeds it");
    for guard in GUARDS {
        assert!(
            after_seed[0]
                .windows(2)
                .any(|pair| pair[0] == "-c" && pair[1] == guard),
            "the seed's refresh carries {guard}, got {:?}",
            after_seed[0]
        );
    }
    assert_eq!(after_reuse.len(), 1, "an unmoved HEAD reuses it");
    assert_eq!(after_move.len(), 2, "a moved HEAD reseeds it");
    assert!(!stale_lock.exists(), "the stale lock is gone");
}
