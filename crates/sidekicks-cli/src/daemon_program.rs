//! The daemon's program the command line starts or runs: the one the person names, else the one
//! installed beside this program.

use std::env::consts::EXE_SUFFIX;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use sidekicks_platforms::{RunningProgramPath, read_running_program_path};

/// The daemon program's file name, without the system's program suffix.
const DAEMON_PROGRAM_NAME: &str = "sidekicks-daemon";

/// The daemon's program as an absolute path: `named` (`--daemon-path`) made absolute against the
/// current folder, else `sidekicks-daemon` beside this program's file. Fails when the current
/// folder or this program's path cannot be read, or this program's file was removed or replaced
/// since it started, so nothing beside it can be trusted.
pub(crate) fn daemon_program(named: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(named) = named {
        return std::path::absolute(named).with_context(|| {
            format!(
                "could not find the background service's program {}",
                named.display()
            )
        });
    }
    let running =
        read_running_program_path().context("could not find where this program is installed")?;
    let RunningProgramPath::OnDisk(running) = running else {
        bail!(
            "this program's file was removed or replaced since it started, so the background \
             service's program beside it cannot be found: run the command again, or name the \
             program with --daemon-path"
        );
    };
    let folder = running
        .parent()
        .context("this program's path names no folder")?;
    Ok(folder.join(format!("{DAEMON_PROGRAM_NAME}{EXE_SUFFIX}")))
}
