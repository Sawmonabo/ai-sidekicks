//! `sidekicks daemon restart` against the built daemon program, run under a home, temporary folder
//! and runtime folder of the test's own, every daemon it starts ended before the test returns.

use crate::helpers::{
    DaemonEnding, PrivateFolders, built_daemon_program, path_text, read_process_identity, text,
};

// Fails when the start after the ending is dropped, since the status read then finds no daemon;
// and when the ending is skipped, since the start then finds the first daemon running and the
// status names the same process.
#[test]
fn a_restart_reports_success_once_a_new_daemon_answers() {
    let folders = PrivateFolders::new();
    let daemon = built_daemon_program();
    let _ending = DaemonEnding::new(&folders);
    // A debug build's first launch, its large program checked by the system, can pass the default
    // wait, which this test does not prove.
    let start_options = ["--daemon-path", path_text(&daemon), "--timeout", "60000"];

    let started = folders.run_sidekicks(&[&["daemon", "start"], &start_options[..]].concat());
    assert_eq!(started.status.code(), Some(0), "{}", text(&started.stderr));
    let first = read_process_identity(&folders).expect("the started daemon names its process");

    let restarted =
        folders.run_sidekicks(&[&["daemon", "restart", "--yes"], &start_options[..]].concat());

    assert_eq!(
        restarted.status.code(),
        Some(0),
        "{}",
        text(&restarted.stderr)
    );
    assert_eq!(
        text(&restarted.stdout),
        "Restarted the background service.\n"
    );
    let second = read_process_identity(&folders).expect("the restarted daemon answers");
    assert_ne!(second, first, "the restart left the first daemon running");
}
