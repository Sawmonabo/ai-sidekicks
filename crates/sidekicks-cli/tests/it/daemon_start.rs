//! `sidekicks daemon start` against the built daemon program and stand-ins for it, each run under a
//! home, temporary folder and runtime folder of the test's own, every process it starts ended
//! before the test returns.

use std::env::consts::EXE_SUFFIX;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use serde::Deserialize;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_platforms::{
    LeftoverSweep, PathRules, pin_identified_process, pin_running_process, replace_file_atomically,
};
use tempfile::TempDir;

/// How long a process the test ends has between the stop and the kill.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// A home, temporary folder and runtime folder of the test's own, so nothing it starts reads or
/// writes the person's.
struct PrivateFolders {
    root: TempDir,
}

impl PrivateFolders {
    /// Makes the three folders in a new temporary folder, its name short enough that the daemon's
    /// socket under the home fits the system's bound on a socket's path.
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("s")
            .tempdir()
            .expect("a temporary folder is made");
        for name in ["h", "t", "x"] {
            fs::create_dir(root.path().join(name)).expect("a private folder is made");
        }
        Self { root }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    /// Runs the built `sidekicks` with `arguments` on these folders, and answers how it ended.
    fn run_sidekicks(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sidekicks"))
            .args(arguments)
            .env(
                PathRules::NATIVE.home_environment_name(),
                self.path().join("h"),
            )
            .env("TMPDIR", self.path().join("t"))
            .env("XDG_RUNTIME_DIR", self.path().join("x"))
            .output()
            .expect("the program runs")
    }

    /// Writes `body` as an executable POSIX script `name` in the root, and answers its path.
    fn write_script(&self, name: &str, body: &str) -> PathBuf {
        let path = self.path().join(name);
        replace_file_atomically(
            &path,
            format!("#!/bin/sh\n{body}\n").as_bytes(),
            0o755,
            LeftoverSweep::Unswept,
        )
        .expect("the script is written");
        path
    }
}

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

/// The built daemon program, found beside this test program as the build lays them out. Panics
/// with the build to run when it is missing, since running this crate's tests does not build it.
fn built_daemon_program() -> PathBuf {
    let test_program = std::env::current_exe().expect("the test program names itself");
    let program = test_program
        .parent()
        .and_then(Path::parent)
        .expect("the test program sits in the build's deps folder")
        .join(format!("sidekicks-daemon{EXE_SUFFIX}"));
    assert!(
        program.is_file(),
        "{} is missing: run `cargo build -p sidekicks-daemon` first",
        program.display()
    );
    program
}

fn read_pid(pid_file: &Path) -> Option<u32> {
    let text = fs::read_to_string(pid_file).ok()?;
    Some(text.trim().parse().expect("the stand-in wrote its id"))
}

fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("UTF-8")
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

fn path_text(path: &Path) -> &str {
    path.to_str().expect("a temporary path is UTF-8")
}
