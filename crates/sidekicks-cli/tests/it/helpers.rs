//! What the tests of the built program share: a home, temporary folder and runtime folder of a
//! test's own, the built daemon program, and readers of a run's output.

use std::env::consts::EXE_SUFFIX;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use sidekicks_platforms::{LeftoverSweep, PathRules, replace_file_atomically};
use tempfile::TempDir;

/// A home, temporary folder and runtime folder of the test's own, so nothing it starts reads or
/// writes the person's.
pub(crate) struct PrivateFolders {
    root: TempDir,
}

impl PrivateFolders {
    /// Makes the three folders in a new temporary folder, its name short enough that the daemon's
    /// socket under the home fits the system's bound on a socket's path.
    pub(crate) fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("s")
            .tempdir()
            .expect("a temporary folder is made");
        for name in ["h", "t", "x"] {
            fs::create_dir(root.path().join(name)).expect("a private folder is made");
        }
        Self { root }
    }

    pub(crate) fn path(&self) -> &Path {
        self.root.path()
    }

    /// Runs the built `sidekicks` with `arguments` on these folders, and answers how it ended.
    pub(crate) fn run_sidekicks(&self, arguments: &[&str]) -> Output {
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
    pub(crate) fn write_script(&self, name: &str, body: &str) -> PathBuf {
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

/// The built daemon program, found beside this test program as the build lays them out. Panics
/// with the build to run when it is missing, since running this crate's tests does not build it.
pub(crate) fn built_daemon_program() -> PathBuf {
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

/// `bytes` as text, which the program's output always is.
pub(crate) fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("UTF-8")
}

/// `path` as text, which a temporary path always is.
pub(crate) fn path_text(path: &Path) -> &str {
    path.to_str().expect("a temporary path is UTF-8")
}
