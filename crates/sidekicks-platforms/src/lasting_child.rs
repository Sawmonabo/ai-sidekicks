//! A child that outlives the daemon: what it runs, and the pinned process, record and exit its
//! start answers.

use std::fs::File;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::ExitStatus;

use crate::{PinnedProcess, ProcessRecord};

/// What a lasting child runs: its standard input and output read and write nothing, and its error
/// output goes to `error_output`.
#[derive(Debug)]
pub struct LastingCommand {
    /// The program, an absolute path to an executable file.
    pub program: PathBuf,
    /// The arguments after the program.
    pub arguments: Vec<String>,
    /// The whole environment; nothing is inherited from the daemon.
    pub environment: Vec<(String, String)>,
    /// The folder the child starts in.
    pub working_folder: PathBuf,
    /// The file the child's error output is written to.
    pub error_output: File,
}

/// A started lasting child: the process pinned, the record a later daemon re-pins it from, and its
/// exit, which this daemon reads since the child is still its own.
pub struct LastingChild {
    /// The child, pinned.
    pub process: PinnedProcess,
    /// What a later daemon re-pins the child from.
    pub record: ProcessRecord,
    /// The child's exit, answered once it has exited and been reaped; fails with the system's error
    /// from the wait for its end or its reap.
    pub exit: Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send>>,
}
