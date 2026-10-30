//! `sidekicks daemon start` against the built daemon program and stand-ins for it, each run under a
//! home, temporary folder and runtime folder of the test's own, every process it starts ended
//! before the test returns.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_platforms::{pin_identified_process, pin_running_process};

use crate::helpers::{PrivateFolders, built_daemon_program, path_text, text};

/// How long a process the test ends has between the stop and the kill.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// Ends the daemon these folders run, the one `daemon status --json` names, when it drops, so the
/// test leaves no daemon behind on any path.
struct DaemonEnding<'a> {
    folders: &'a PrivateFolders,
}

impl Drop for DaemonEnding<'_> {
    fn drop(&mut self) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StatusProcess {
            process_identity: ProcessIdentity,
        }

        let status = self.folders.run_sidekicks(&["daemon", "status", "--json"]);
        let Ok(status) = serde_json::from_slice::<StatusProcess>(&status.stdout) else {
            return;
        };
        if let Some(process) =
            pin_identified_process(&status.process_identity).expect("the daemon's process reads")
        {
            process.stop(STOP_GRACE).expect("the daemon is stopped");
        }
    }
}

/// Ends the process whose id the stand-in wrote to `pid_file`, where it still runs, when it drops.
struct StandInEnding {
    pid_file: PathBuf,
}

impl Drop for StandInEnding {
    fn drop(&mut self) {
        let Some(pid) = read_pid(&self.pid_file) else {
            return;
        };
        if let Some(process) = pin_running_process(pid).expect("the stand-in's process reads") {
            process.stop(STOP_GRACE).expect("the stand-in is stopped");
        }
    }
}

fn read_pid(pid_file: &Path) -> Option<u32> {
    let text = fs::read_to_string(pid_file).ok()?;
    Some(text.trim().parse().expect("the stand-in wrote its id"))
}

// Fails when the start reports success at the spawn rather than at the handshake, since the status
// read right after it then finds no daemon; and when the already-running check is dropped, since
// the second start then runs the stand-in, which leaves its mark, and reports a start.
#[test]
fn a_start_reports_success_once_the_daemon_answers_and_a_second_start_spawns_nothing() {
    let folders = PrivateFolders::new();
    let daemon = built_daemon_program();
    let _ending = DaemonEnding { folders: &folders };

    // A debug build's first launch, its large program checked by the system, can pass the default
    // wait, which this test does not prove.
    let first = folders.run_sidekicks(&[
        "daemon",
        "start",
        "--daemon-path",
        path_text(&daemon),
        "--timeout",
        "60000",
    ]);
    assert_eq!(first.status.code(), Some(0), "{}", text(&first.stderr));
    assert_eq!(text(&first.stdout), "Started the background service.\n");
    let status = folders.run_sidekicks(&["daemon", "status", "--json"]);
    assert_eq!(status.status.code(), Some(0), "{}", text(&status.stderr));

    let mark = folders.path().join("stand-in-ran");
    let stand_in = folders.write_script("stand-in", &format!(": > '{}'", path_text(&mark)));
    let second = folders.run_sidekicks(&["daemon", "start", "--daemon-path", path_text(&stand_in)]);
    assert_eq!(second.status.code(), Some(0), "{}", text(&second.stderr));
    assert_eq!(
        text(&second.stdout),
        "The background service is already running.\n"
    );
    assert!(!mark.exists(), "the second start ran a program");
}

// Fails when a start whose program never answers leaves it running, which would hold the socket
// against every later start.
#[test]
fn a_started_program_that_never_answers_is_ended_and_the_start_exits_69() {
    let folders = PrivateFolders::new();
    let pid_file = folders.path().join("stand-in.pid");
    let stand_in = folders.write_script(
        "never-answers",
        &format!("echo $$ > '{}'\nexec sleep 30", path_text(&pid_file)),
    );
    let _ending = StandInEnding {
        pid_file: pid_file.clone(),
    };

    let started = folders.run_sidekicks(&[
        "daemon",
        "start",
        "--daemon-path",
        path_text(&stand_in),
        "--timeout",
        "200",
    ]);

    assert_eq!(started.status.code(), Some(69), "{}", text(&started.stderr));
    assert!(
        text(&started.stderr).starts_with(
            "error: The background service did not answer within 200 ms of its start, so it was \
             stopped"
        ),
        "{}",
        text(&started.stderr)
    );
    let pid = read_pid(&pid_file).expect("the stand-in wrote its id");
    assert!(
        pin_running_process(pid)
            .expect("the stand-in's process reads")
            .is_none(),
        "the program that never answered still runs"
    );
}
