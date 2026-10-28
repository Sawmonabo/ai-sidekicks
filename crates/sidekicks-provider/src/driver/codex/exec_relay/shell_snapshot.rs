//! A conversation's shell snapshot, as Codex's local path takes it and the executor's path does
//! not: the person's login shell started once per conversation, shell and folder, its functions,
//! options and aliases written to a file every relayed command of that shell sources first.

mod capture_scripts;
pub(super) mod wrap;

use std::collections::HashMap;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{Spawner, create_private_folder, wrap_group_child_command};
use sidekicks_std::mutex_lock::lock;
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::sync::OnceCell;

use self::capture_scripts::capture_script;

/// The folder under the daemon's data folder that holds every relay's snapshots.
const SNAPSHOTS_FOLDER: &str = "codex-shell-snapshots";

/// How long one capture or check may run, as Codex bounds its own.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// The most output a capture keeps; a shell that prints more yields no snapshot.
const CAPTURE_MAX_BYTES: u64 = 16 << 20;

/// The most of a failed capture's error output kept for the log.
const ERROR_TAIL_MAX_BYTES: u64 = 4 << 10;

/// The variable naming a command's call, which a capture never carries.
const TOOL_CALL_ID_VARIABLE: &str = "CODEX_TOOL_CALL_ID";

/// The line that opens a capture's state.
const SNAPSHOT_MARKER: &[u8] = b"# Snapshot file";

/// The line a snapshot ends with, where Codex lists the exports it keeps; it keeps none here.
const EXPORTS_HEADING: &str = "# exports (native declarations)\n";

/// A shell whose state a snapshot captures.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum SnapshotShell {
    Zsh,
    Bash,
    Sh,
}

impl SnapshotShell {
    /// The shell `program` names by its file name; `None` for any other program.
    pub(super) fn of(program: &str) -> Option<Self> {
        match Path::new(program).file_name()?.to_str()? {
            "zsh" => Some(Self::Zsh),
            "bash" => Some(Self::Bash),
            "sh" => Some(Self::Sh),
            _ => None,
        }
    }
}

/// Which snapshot a command sources: its conversation, its shell and its folder.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SnapshotKey {
    thread_id: String,
    shell: String,
    working_folder: PathBuf,
}

/// One relay's snapshots: each taken once, at its first command, and kept until the relay ends.
pub(super) struct ShellSnapshots {
    spawner: Spawner,
    folder: PathBuf,
    environment: Mutex<Vec<(String, String)>>,
    taken: Mutex<HashMap<SnapshotKey, Arc<OnceCell<Option<PathBuf>>>>>,
}

impl ShellSnapshots {
    /// Snapshots kept in a folder of their own under `data_folder`, captured on `spawner`.
    pub(super) fn new(spawner: Spawner, data_folder: &Path) -> Self {
        Self {
            spawner,
            folder: data_folder
                .join(SNAPSHOTS_FOLDER)
                .join(mint_uuid_v7().to_string()),
            environment: Mutex::new(Vec::new()),
            taken: Mutex::new(HashMap::new()),
        }
    }

    /// Sets the environment a capture runs in: the one the service's own process would capture
    /// in.
    pub(super) fn set_environment(&self, environment: Vec<(String, String)>) {
        *lock(&self.environment) = environment;
    }

    /// The snapshot a `shell` command of `thread_id` in `working_folder` sources, captured at
    /// its first ask; `None` where the shell is none a snapshot captures or its capture failed,
    /// which is logged once.
    pub(super) async fn snapshot_for(
        &self,
        thread_id: &str,
        shell: &str,
        working_folder: &Path,
    ) -> Option<PathBuf> {
        let snapshot_shell = SnapshotShell::of(shell)?;
        let key = SnapshotKey {
            thread_id: thread_id.to_owned(),
            shell: shell.to_owned(),
            working_folder: working_folder.to_owned(),
        };
        let cell = Arc::clone(lock(&self.taken).entry(key).or_default());
        cell.get_or_init(|| async {
            match self.take(snapshot_shell, shell, working_folder).await {
                Ok(path) => Some(path),
                Err(error) => {
                    tracing::warn!(
                        shell,
                        error = &error as &(dyn std::error::Error + 'static),
                        "a conversation's shell snapshot could not be taken; its commands run \
                         without it"
                    );
                    None
                }
            }
        })
        .await
        .clone()
    }

    // Captures `shell`'s state as a login shell in `working_folder`, writes it and checks that it
    // sources cleanly.
    async fn take(
        &self,
        snapshot_shell: SnapshotShell,
        shell: &str,
        working_folder: &Path,
    ) -> io::Result<PathBuf> {
        let captured = self
            .run_shell(
                shell,
                "-lc",
                &capture_script(snapshot_shell),
                working_folder,
            )
            .await?;
        let snapshot = render_snapshot(&captured).ok_or_else(|| {
            io::Error::new(ErrorKind::InvalidData, "the shell's capture is no snapshot")
        })?;
        let folder = self.folder.clone();
        let path = folder.join(format!("{}.sh", mint_uuid_v7()));
        let written = path.clone();
        tokio::task::spawn_blocking(move || {
            create_private_folder(&folder)?;
            std::fs::write(&written, snapshot)
        })
        .await
        .map_err(io::Error::other)??;
        let check = format!("set -e; . \"{}\"", path.display());
        if let Err(error) = self.run_shell(shell, "-c", &check, working_folder).await {
            if let Err(removal) = tokio::fs::remove_file(&path).await {
                tracing::warn!(%removal, "a failed shell snapshot could not be removed");
            }
            return Err(error);
        }
        Ok(path)
    }

    // Runs `shell flag script` in `working_folder`, its input closed, in a process group of its own
    // ended at the timeout, and answers what it printed. Fails with the spawn's error, a timeout,
    // a failing exit with what it printed on its error output, or output past the bound.
    async fn run_shell(
        &self,
        shell: &str,
        flag: &str,
        script: &str,
        working_folder: &Path,
    ) -> io::Result<Vec<u8>> {
        let mut command = tokio::process::Command::new(shell);
        command
            .args([flag, script])
            .current_dir(working_folder)
            .env_clear()
            .envs(
                lock(&self.environment)
                    .iter()
                    .filter(|(name, _)| name != TOOL_CALL_ID_VARIABLE)
                    .cloned(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let daemon_pid = std::process::id();
        let mut child = self
            .spawner
            .run(move || wrap_group_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)?;
        let output = child.stdout().take().expect("the shell's output is piped");
        let errors = child
            .stderr()
            .take()
            .expect("the shell's error output is piped");
        let ran = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
            let (output, errors, status) = tokio::join!(
                read_bounded(output, CAPTURE_MAX_BYTES),
                read_bounded(errors, ERROR_TAIL_MAX_BYTES),
                child.wait()
            );
            Ok::<_, io::Error>((output?, errors?, status?))
        })
        .await;
        let Ok(ran) = ran else {
            child.start_kill()?;
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                format!("the shell ran past {SNAPSHOT_TIMEOUT:?}"),
            ));
        };
        let (output, errors, status) = ran?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "the shell exited with {status}: {}",
                String::from_utf8_lossy(&errors)
            )));
        }
        if u64::try_from(output.len()).is_ok_and(|length| length > CAPTURE_MAX_BYTES) {
            return Err(io::Error::new(
                ErrorKind::FileTooLarge,
                "the shell printed past the capture's bound",
            ));
        }
        Ok(output)
    }
}

impl Drop for ShellSnapshots {
    fn drop(&mut self) {
        // Small files the relay alone wrote; its end removes them where it can.
        if let Err(error) = std::fs::remove_dir_all(&self.folder)
            && error.kind() != ErrorKind::NotFound
        {
            tracing::warn!(%error, "a Codex relay's shell snapshots could not be removed");
        }
    }
}

// Reads `stream` to its end, keeping one byte past `limit` so an overlong output shows.
async fn read_bounded(stream: impl AsyncRead + Unpin, limit: u64) -> io::Result<Vec<u8>> {
    let mut read = Vec::new();
    stream.take(limit + 1).read_to_end(&mut read).await?;
    Ok(read)
}

/// The snapshot a capture's output holds: its state from the marker, then its aliases, then the
/// exports heading; `None` for output that is no capture.
pub(super) fn render_snapshot(captured: &[u8]) -> Option<String> {
    let mut records = captured.split(|byte| *byte == 0);
    let state = records.next()?;
    let start = state
        .windows(SNAPSHOT_MARKER.len())
        .position(|window| window == SNAPSHOT_MARKER)?;
    let state = std::str::from_utf8(&state[start..]).ok()?;
    // The aliases end at their NUL, which a whole capture always prints.
    let aliases = std::str::from_utf8(records.next()?).ok()?;
    records.next()?;
    Some(format!("{state}{aliases}{EXPORTS_HEADING}"))
}

#[cfg(test)]
mod tests;
