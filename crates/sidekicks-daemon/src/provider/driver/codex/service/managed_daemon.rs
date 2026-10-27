//! Stopping Codex's own managed daemon on the person's Codex folder once nothing is loaded on it,
//! so the daemon's terminal service can take the folder, as Codex's own updater stops it: under
//! Codex's start lock, each process named by its pid file and checked against the identity the
//! file records, so a process given a freed id is never signaled. On macOS and Linux the server
//! is asked to stop with `SIGTERM` and the updater with `SIGTERM` to its whole group, as Codex's
//! own updater stops it, and each is killed with its group after the grace; on Windows, which has
//! no signal, the server takes Codex's own shutdown request and the updater a `.shutdown` file
//! beside its pid file, and each is ended after the grace.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_platforms::{
    CAN_SIGNAL_A_STOP, PinnedProcess, connect_unix_domain_socket, pin_running_process,
    process_identity,
};

use crate::codex::service::process::request_codex_service_shutdown;
use crate::codex::service::start_lock::{CodexStartLock, codex_daemon_state_folder};

/// How long a stopped process has to end before it is killed, Codex's own grace.
const CODEX_MANAGED_DAEMON_GRACE: Duration = Duration::from_secs(60);

/// The server's and the updater's pid files, the current pair first, then the pair Codex uses when
/// its managed program sits under `packages/standalone`.
const CODEX_PID_FILE_PAIRS: [(&str, &str); 2] = [
    ("daemon.pid", "daemon-updater.pid"),
    ("app-server.pid", "app-server-updater.pid"),
];

/// Which of the managed daemon's processes a pid file names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedProcessRole {
    Server,
    Updater,
}

// A pid file as Codex writes it; the members it adds are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPidRecord {
    pid: u32,
    process_start_time: String,
    process_identity: Option<CodexProcessIdentity>,
}

// Codex's identity of a process, untagged as Codex writes it; the unique-id form is tried before
// the start-only one.
#[derive(Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
enum CodexProcessIdentity {
    Linux {
        boot_id: String,
        start_ticks: u64,
    },
    MacOsUnique {
        boot_id: String,
        unique_id: u64,
        start_seconds: u64,
        start_microseconds: u64,
    },
    MacOs {
        start_seconds: u64,
        start_microseconds: u64,
    },
}

impl CodexPidRecord {
    // Whether the running process `running`, whose system mark is `running_mark`, is the one this
    // record names: its boot, where the record keeps one, its start as the system writes it, and
    // on macOS its unique id where the record keeps one.
    fn names(&self, running: &ProcessIdentity, running_mark: u64) -> bool {
        let start = running.process_start_time.as_ref();
        let boot = running.boot_id.as_ref();
        match &self.process_identity {
            Some(CodexProcessIdentity::Linux {
                boot_id,
                start_ticks,
            }) => boot_id == boot && start_ticks.to_string() == start,
            Some(CodexProcessIdentity::MacOsUnique {
                boot_id,
                unique_id,
                start_seconds,
                start_microseconds,
            }) => {
                boot_id == boot
                    && *unique_id == running_mark
                    && macos_start(*start_seconds, *start_microseconds) == start
            }
            Some(CodexProcessIdentity::MacOs {
                start_seconds,
                start_microseconds,
            }) => macos_start(*start_seconds, *start_microseconds) == start,
            // Codex's older text: Windows' creation time, which reads as the platforms crate writes
            // it; elsewhere a localized date that never matches, so the process is left alone.
            None => self.process_start_time == start,
        }
    }
}

// A macOS start instant in microseconds since the epoch, as the platforms crate writes it.
fn macos_start(start_seconds: u64, start_microseconds: u64) -> String {
    start_seconds
        .saturating_mul(1_000_000)
        .saturating_add(start_microseconds)
        .to_string()
}

/// Stops Codex's managed daemon on `codex_home`: each pid file found, of either pair, whose
/// process is still the one it records. `control_socket` is the home's control socket, over which
/// Windows' shutdown request goes. Answers whether any process was stopped; fails with the first
/// stop that failed, once every one ran.
pub(crate) async fn stop_codex_managed_daemon(
    codex_home: &Path,
    control_socket: &Path,
    _start_lock: &CodexStartLock,
) -> io::Result<bool> {
    let folder = codex_daemon_state_folder(codex_home);
    let mut outcome = Ok(false);
    for (server, updater) in CODEX_PID_FILE_PAIRS {
        for (file_name, role) in [
            (server, ManagedProcessRole::Server),
            (updater, ManagedProcessRole::Updater),
        ] {
            match stop_recorded_process(&folder.join(file_name), role, control_socket).await {
                Ok(is_stopped) => {
                    outcome = outcome.map(|was_stopped| was_stopped || is_stopped);
                }
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        pid_file = file_name,
                        "a process of Codex's managed daemon could not be stopped"
                    );
                    outcome = outcome.and(Err(error));
                }
            }
        }
    }
    outcome
}

// Stops the process `pid_file` records, when the file is there and its process still runs as
// recorded; answers whether it stopped one.
async fn stop_recorded_process(
    pid_file: &Path,
    role: ManagedProcessRole,
    control_socket: &Path,
) -> io::Result<bool> {
    let text = match tokio::fs::read_to_string(pid_file).await {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let record: CodexPidRecord = serde_json::from_str(&text)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let pid = record.pid;
    // Pinned first, then read, so the identity read is the pinned process's own.
    let pinned = tokio::task::spawn_blocking(move || -> io::Result<Option<PinnedProcess>> {
        let Some(pinned) = pin_running_process(pid)? else {
            return Ok(None);
        };
        let Some(running) = process_identity(pid)? else {
            return Ok(None);
        };
        let Some(running_record) = pinned.record()? else {
            return Ok(None);
        };
        Ok(record
            .names(&running, running_record.start())
            .then_some(pinned))
    })
    .await
    .map_err(io::Error::other)??;
    let Some(pinned) = pinned else {
        return Ok(false);
    };
    if !CAN_SIGNAL_A_STOP {
        ask_to_stop_without_a_signal(pid_file, role, pid, control_socket).await;
    }
    tokio::task::spawn_blocking(move || match role {
        ManagedProcessRole::Server => pinned.stop(CODEX_MANAGED_DAEMON_GRACE),
        ManagedProcessRole::Updater => pinned.stop_group(CODEX_MANAGED_DAEMON_GRACE),
    })
    .await
    .map_err(io::Error::other)??;
    Ok(true)
}

// Where a stop sends no signal: the server's shutdown request over its control socket, the
// updater's `.shutdown` file naming it. A failed ask is logged; the forced end follows the grace.
async fn ask_to_stop_without_a_signal(
    pid_file: &Path,
    role: ManagedProcessRole,
    pid: u32,
    control_socket: &Path,
) {
    let asked = match role {
        ManagedProcessRole::Server => match connect_unix_domain_socket(control_socket).await {
            Ok(connection) => request_codex_service_shutdown(connection, pid)
                .await
                .map_err(io::Error::other),
            Err(error) => Err(error),
        },
        ManagedProcessRole::Updater => {
            tokio::fs::write(shutdown_file(pid_file), pid.to_string()).await
        }
    };
    if let Err(error) = asked {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            process_id = pid,
            "codex's managed daemon was not asked to stop; it is ended after the grace"
        );
    }
}

// The file whose presence asks Codex's updater to stop: its pid file's name with `.shutdown`.
fn shutdown_file(pid_file: &Path) -> PathBuf {
    pid_file.with_extension("shutdown")
}
