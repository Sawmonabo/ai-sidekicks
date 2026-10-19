//! The program this process runs: the processor it is built for, and its path on disk, which a
//! later read finds gone once the program's file is removed, or on Linux replaced.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::platform::Arch;

use crate::real_path;

/// The processor this build runs on, in Node's spelling.
#[cfg(target_arch = "x86_64")]
pub const RUNNING_ARCH: Arch = Arch::X64;

/// The processor this build runs on, in Node's spelling.
#[cfg(target_arch = "aarch64")]
pub const RUNNING_ARCH: Arch = Arch::Arm64;

/// Where the running program's file is now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunningProgramPath {
    /// Still on disk at this path, every link resolved.
    OnDisk(PathBuf),
    /// Removed since the program started, or on Linux replaced (its link marked ` (deleted)`); a
    /// file renamed over it on macOS or Windows reads [`OnDisk`](Self::OnDisk).
    Replaced,
}

/// Where the running program's file is now: [`RunningProgramPath::Replaced`] once its file is
/// removed, or on Linux replaced. Fails when the system cannot name the running program or its path
/// cannot be resolved for any reason but its absence.
pub fn read_running_program_path() -> io::Result<RunningProgramPath> {
    classify_program_path(&std::env::current_exe()?)
}

// Where the program the system names as `program` is: replaced when Linux marks its link
// ` (deleted)` or the path no longer resolves; macOS and Windows name the path the program started
// from, which still resolves when another file was renamed over it.
fn classify_program_path(program: &Path) -> io::Result<RunningProgramPath> {
    if is_marked_replaced(program) {
        return Ok(RunningProgramPath::Replaced);
    }
    match real_path(program) {
        Ok(resolved) => Ok(RunningProgramPath::OnDisk(resolved)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(RunningProgramPath::Replaced),
        Err(error) => Err(error),
    }
}

// Whether Linux's link to the running program names a file since replaced: `… (deleted)`.
#[cfg(target_os = "linux")]
fn is_marked_replaced(program: &Path) -> bool {
    program
        .as_os_str()
        .as_encoded_bytes()
        .ends_with(b" (deleted)")
}

// No other system marks a replaced program's path.
#[cfg(not(target_os = "linux"))]
fn is_marked_replaced(_program: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{RunningProgramPath, classify_program_path};
    use crate::real_path;

    // Fails when a missing path is answered as on disk, or as an error, which leaves the daemon
    // joining a service whose hooks run a program that is gone.
    #[test]
    fn a_running_program_path_reads_replaced_once_its_file_is_gone() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let on_disk = folder.path().join("sidekicks-daemon");
        std::fs::write(&on_disk, b"").expect("the program file is written");
        let removed = folder.path().join("removed");
        let mut cases = vec![
            (
                on_disk.clone(),
                RunningProgramPath::OnDisk(real_path(&on_disk).expect("the program resolves")),
            ),
            (removed, RunningProgramPath::Replaced),
        ];
        if cfg!(target_os = "linux") {
            let marked = folder.path().join("sidekicks-daemon (deleted)");
            std::fs::write(&marked, b"").expect("the marked file is written");
            cases.push((marked, RunningProgramPath::Replaced));
        }

        for (program, expected) in cases {
            let read = classify_program_path(&program).expect("the program's path reads");
            assert_eq!(read, expected, "{}", program.display());
        }
    }
}
