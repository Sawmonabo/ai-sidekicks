//! The daemon's program the command line starts or runs: the one the person names, else the one
//! installed beside this program; whether two paths name the same program; and this program's own
//! file.

use std::env::consts::EXE_SUFFIX;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use sidekicks_platforms::{RunningProgramPath, read_running_program_path, real_path};

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
    let running = this_program()?;
    let folder = running
        .parent()
        .context("this program's path names no folder")?;
    Ok(folder.join(format!("{DAEMON_PROGRAM_NAME}{EXE_SUFFIX}")))
}

/// Whether `left` and `right` name the same program, compared with every link and `..` resolved;
/// a path that names no file is compared as written. Fails when either cannot be resolved for
/// another reason.
pub(crate) fn is_same_program(left: &Path, right: &Path) -> anyhow::Result<bool> {
    Ok(resolve_program(left)? == resolve_program(right)?)
}

/// `path` with every link and `..` resolved, or as written where it names no file. Fails, naming
/// it, when it cannot be resolved for another reason.
fn resolve_program(path: &Path) -> anyhow::Result<PathBuf> {
    match real_path(path) {
        Ok(resolved) => Ok(resolved),
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(path.to_owned()),
        Err(failure) => Err(anyhow::Error::new(failure)
            .context(format!("could not resolve the program {}", path.display()))),
    }
}

/// This program's own file, every link resolved. Fails when its path cannot be read, or its file
/// was removed or replaced since it started, so neither it nor anything beside it can be trusted.
pub(crate) fn this_program() -> anyhow::Result<PathBuf> {
    let running =
        read_running_program_path().context("could not find where this program is installed")?;
    let RunningProgramPath::OnDisk(running) = running else {
        bail!(
            "this program's file was removed or replaced since it started, so the background \
             service's program beside it cannot be found: run the command again, or name the \
             program with --daemon-path"
        );
    };
    Ok(running)
}
