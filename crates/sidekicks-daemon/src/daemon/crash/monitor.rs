//! The crash monitor: the `minidump <socket>` mode, a child of the service that writes a dump of
//! the service when it crashes, since a crashed process cannot write its own. The service connects
//! to it at its start and attaches the crash handler, which asks the monitor for the dump on a
//! crash; a panic first sends its message and place, which the monitor keeps beside the dump. A
//! dump is written under a temporary name and renamed once whole, so the report builder never
//! reads one half written. The monitor ends once it has written a dump or its service has gone.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crash_handler::{CrashContext, CrashEventResult, CrashHandler, make_crash_event};
use minidumper::{Client, LoopAction, MinidumpBinary, Server, ServerHandler, SocketName};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{
    SocketPathRefused, check_socket_path, create_private_folder, rename_replacing,
    replace_file_atomically,
};

use crate::missing_entry::MissingEntry as _;

/// The word the daemon's own program is started with to run the crash monitor; the socket's path
/// follows it.
pub const CRASH_MONITOR_MODE: &str = "minidump";

/// The folder of crash dumps in the data folder, the service's and the app's alike.
pub(crate) const CRASH_DUMPS_FOLDER_NAME: &str = "crash-dumps";

/// A finished dump's extension.
pub(crate) const DUMP_EXTENSION: &str = "dmp";

/// The suffix of the panic record kept beside a dump whose crash a panic raised.
pub(crate) const PANIC_RECORD_SUFFIX: &str = ".panic.json";

// The kind of message that carries a panic's record to the monitor.
const PANIC_MESSAGE_KIND: u32 = 1;

// The suffix of a dump being written.
const DUMP_IN_PROGRESS_SUFFIX: &str = ".partial";

// How long the service tries to reach a monitor that is still starting, and how often.
const CONNECT_BOUND: Duration = Duration::from_secs(10);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(100);

// A dump or panic record readable by the person alone.
const CRASH_FILE_MODE: u32 = 0o600;

/// What a panic said, as the service sends it to the monitor before it aborts: unstripped, since
/// the report builder strips it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PanicRecord {
    /// The panic's message.
    pub(crate) message: String,
    /// The source file, line and column it was raised at.
    pub(crate) location: String,
}

/// Why the monitor could not serve or be reached.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CrashMonitorError {
    /// The socket's path is past the system's bound.
    #[error("the crash monitor's socket path {} cannot be bound", path.display())]
    SocketPath {
        /// The path.
        path: PathBuf,
        /// Why.
        #[source]
        source: SocketPathRefused,
    },
    /// The socket's path is not text, which the channel names it in.
    #[error("the crash monitor's socket path {} is not text", path.display())]
    SocketPathText {
        /// The path.
        path: PathBuf,
    },
    /// The dumps folder could not be made.
    #[error("the crash dumps folder {} could not be made", path.display())]
    Folder {
        /// The folder.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
    /// The monitor's server failed, or the service could not reach it in time.
    #[error("the crash monitor's channel failed")]
    Channel(#[source] minidumper::Error),
}

/// The socket a service with process id `daemon_pid` reaches its monitor at, in its run folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start starts its crash monitor at it"
    )
)]
pub(crate) fn crash_monitor_socket_path(run_folder: &Path, daemon_pid: u32) -> PathBuf {
    run_folder.join(format!("crash-monitor-{daemon_pid}.sock"))
}

/// Runs the `minidump` mode on the argument after the mode's own, the socket's path, writing dumps
/// into the data folder's crash dumps folder. Exits 0 once it ends, 1 with why on standard error
/// when it cannot serve.
pub fn run_crash_monitor(arguments: &[OsString]) -> ExitCode {
    let [socket_path] = arguments else {
        write_line("The crash monitor is started with its socket's path");
        return ExitCode::FAILURE;
    };
    let Some(home) = std::env::home_dir() else {
        write_line("The crash monitor cannot find the home folder");
        return ExitCode::FAILURE;
    };
    let dumps_folder = home
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(CRASH_DUMPS_FOLDER_NAME);
    match serve_crash_monitor(Path::new(socket_path), &dumps_folder) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            write_line(&format!(
                "The crash monitor stopped: {}",
                crate::error_description::describe_error(&failure)
            ));
            ExitCode::FAILURE
        }
    }
}

/// Serves the monitor's socket at `socket_path`, writing each dump into `dumps_folder`, until it
/// has written one or its service has gone. Fails when the path or the folder cannot be used or
/// the server fails.
pub(crate) fn serve_crash_monitor(
    socket_path: &Path,
    dumps_folder: &Path,
) -> Result<(), CrashMonitorError> {
    let name = socket_name(socket_path)?;
    create_private_folder(dumps_folder).map_err(|source| CrashMonitorError::Folder {
        path: dumps_folder.to_path_buf(),
        source,
    })?;
    let mut server =
        Server::with_name(SocketName::path(name)).map_err(CrashMonitorError::Channel)?;
    let handler = DumpWriter {
        dumps_folder: dumps_folder.to_path_buf(),
        panic: Mutex::new(None),
    };
    server
        .run(Box::new(handler), &AtomicBool::new(false), None)
        .map_err(CrashMonitorError::Channel)
}

/// Connects the service to its monitor at `socket_path`, trying for up to ten seconds while the
/// monitor starts. Blocking. Fails when the path cannot be used or no monitor answers in time.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start connects to its crash monitor")
)]
pub(crate) fn connect_crash_monitor(socket_path: &Path) -> Result<Client, CrashMonitorError> {
    let name = socket_name(socket_path)?;
    let give_up_at = Instant::now() + CONNECT_BOUND;
    loop {
        match Client::with_name(SocketName::path(name)) {
            Ok(client) => return Ok(client),
            Err(failure) if Instant::now() >= give_up_at => {
                return Err(CrashMonitorError::Channel(failure));
            }
            Err(_not_yet) => thread::sleep(CONNECT_RETRY_INTERVAL),
        }
    }
}

/// Attaches the crash handler, which asks the monitor `client` reaches for a dump when the process
/// crashes or aborts, as a panic does. Fails when the system refuses the handler.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start attaches its crash handler")
)]
#[expect(
    unsafe_code,
    reason = "the crash handler's event is built through its library's one unsafe constructor"
)]
pub(crate) fn attach_crash_handler(
    client: Arc<Client>,
) -> Result<CrashHandler, crash_handler::Error> {
    // SAFETY: the closure runs in the crashed process's handler, where it only sends the dump
    // request over the monitor's already open channel and allocates nothing beyond it, as the
    // library's own example does.
    let on_crash = unsafe {
        make_crash_event(move |context: &CrashContext| {
            CrashEventResult::Handled(client.request_dump(context).is_ok())
        })
    };
    CrashHandler::attach(on_crash)
}

/// Sends `record` to the monitor `client` reaches, and waits until the monitor has it, so it is
/// kept beside the dump the abort that follows asks for. Fails when the channel fails.
pub(crate) fn send_panic_record(
    client: &Client,
    record: &PanicRecord,
) -> Result<(), minidumper::Error> {
    let bytes = serde_json::to_vec(record).expect("a panic record serializes as JSON");
    client.send_message(PANIC_MESSAGE_KIND, bytes)?;
    // On macOS messages and dump requests travel apart; the ping makes the message land first.
    client.ping()
}

// The socket path as the channel names it: checked for the system's bound and held in text.
fn socket_name(socket_path: &Path) -> Result<&str, CrashMonitorError> {
    check_socket_path(socket_path).map_err(|source| CrashMonitorError::SocketPath {
        path: socket_path.to_path_buf(),
        source,
    })?;
    socket_path
        .to_str()
        .ok_or_else(|| CrashMonitorError::SocketPathText {
            path: socket_path.to_path_buf(),
        })
}

// Writes each dump into the dumps folder, the latest panic record beside it.
struct DumpWriter {
    dumps_folder: PathBuf,
    panic: Mutex<Option<Vec<u8>>>,
}

impl ServerHandler for DumpWriter {
    fn create_minidump_file(&self) -> Result<(File, PathBuf), io::Error> {
        let path = self.dumps_folder.join(format!(
            "{}.{DUMP_EXTENSION}{DUMP_IN_PROGRESS_SUFFIX}",
            mint_uuid_v7()
        ));
        Ok((
            sidekicks_platforms::create_new_file(&path, CRASH_FILE_MODE)?,
            path,
        ))
    }

    fn on_minidump_created(&self, result: Result<MinidumpBinary, minidumper::Error>) -> LoopAction {
        match result {
            Ok(dump) => {
                if let Err(failure) = self.finish_dump(&dump) {
                    write_line(&format!("The crash dump could not be finished: {failure}"));
                }
            }
            Err(failure) => write_line(&format!("The crash dump could not be written: {failure}")),
        }
        LoopAction::Exit
    }

    fn on_message(&self, kind: u32, buffer: Vec<u8>) {
        if kind == PANIC_MESSAGE_KIND {
            *self.panic.lock().unwrap_or_else(PoisonError::into_inner) = Some(buffer);
        }
    }

    fn on_client_disconnected(&self, num_clients: usize) -> LoopAction {
        if num_clients == 0 {
            LoopAction::Exit
        } else {
            LoopAction::Continue
        }
    }
}

impl DumpWriter {
    // Flushes the dump, writes the panic record beside it, and renames the dump into place; a dump
    // that cannot be finished is removed.
    fn finish_dump(&self, dump: &MinidumpBinary) -> io::Result<()> {
        let finished = dump.path.with_extension("");
        let placed = dump
            .file
            .sync_all()
            .and_then(|()| {
                let panic = self
                    .panic
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                match panic {
                    Some(record) => replace_file_atomically(
                        &panic_record_path(&finished),
                        &record,
                        CRASH_FILE_MODE,
                    )
                    .map_err(io::Error::other),
                    None => Ok(()),
                }
            })
            .and_then(|()| rename_replacing(&dump.path, &finished));
        if placed.is_err() {
            std::fs::remove_file(&dump.path).none_if_missing()?;
        }
        placed
    }
}

/// The panic record's path beside the dump at `dump_path`.
pub(crate) fn panic_record_path(dump_path: &Path) -> PathBuf {
    let mut path = dump_path.with_extension("").into_os_string();
    path.push(PANIC_RECORD_SUFFIX);
    PathBuf::from(path)
}

fn write_line(line: &str) {
    // Nothing is left to report a failed write to; the exit status still says it failed.
    if let Err(error) = writeln!(io::stderr().lock(), "{line}") {
        drop(error);
    }
}
