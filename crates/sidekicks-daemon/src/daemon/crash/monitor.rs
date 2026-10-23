//! The crash monitor: the `minidump <socket>` mode, a child of the service that writes a dump of
//! the service when it crashes, since a crashed process cannot write its own. The service connects
//! to it at its start and attaches the crash handler, which asks the monitor for the dump on a
//! crash; a panic first sends its message and place, which the monitor keeps beside the dump. A
//! dump is written under a temporary name, held locked until it is renamed once whole, so the
//! report builder never reads one half written nor takes it for a leftover. The monitor ends once
//! it has written a dump or its service has gone.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crash_handler::{CrashContext, CrashEventResult, CrashHandler, make_crash_event};
use minidumper::{Client, LoopAction, MinidumpBinary, Server, ServerHandler, SocketName};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{
    SocketPathRefused, check_socket_path, create_private_folder, rename_replacing,
    replace_file_atomically,
};

use crate::cleanup_failures::CleanupFailures;
use crate::daemon::data_folder::data_folder;
use crate::error_description::describe_error;
use crate::helper_mode::error_output::write_error_line;
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

// How long a panic waits for the monitor to take its record before it aborts without it.
const PANIC_RECORD_SEND_BOUND: Duration = Duration::from_secs(2);

// The most bytes a panic's record takes as JSON: under the 64 KiB a message may hold on every
// system the channel runs on.
const PANIC_RECORD_MAX_BYTES: usize = 60 * 1024;

/// The suffix of a dump being written.
pub(crate) const DUMP_IN_PROGRESS_SUFFIX: &str = ".partial";

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

/// Why a panic's record did not reach the monitor before the abort.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PanicRecordSendError {
    /// The channel failed.
    #[error("the crash monitor's channel failed")]
    Channel(#[source] minidumper::Error),
    /// The monitor did not take the record within the bound.
    #[error("the crash monitor did not take the panic's record within {0:?}")]
    TimedOut(Duration),
    /// The thread that sends it could not be started.
    #[error("the thread that sends the panic's record could not be started")]
    Thread(#[source] io::Error),
    /// The thread that sends it ended without an answer.
    #[error("the thread that sends the panic's record ended without an answer")]
    Ended,
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
        write_error_line("the crash monitor is started with its socket's path");
        return ExitCode::FAILURE;
    };
    let Some(home) = std::env::home_dir() else {
        write_error_line("the crash monitor cannot find the home folder");
        return ExitCode::FAILURE;
    };
    let dumps_folder = data_folder(&home).join(CRASH_DUMPS_FOLDER_NAME);
    match serve_crash_monitor(Path::new(socket_path), &dumps_folder) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            write_error_line(&format!(
                "the crash monitor stopped: {}",
                describe_error(&failure)
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
        writing: Mutex::new(None),
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

/// Sends `record`, cut under 64 KiB, to the monitor `client` reaches, and waits until the monitor
/// has it, so it is kept beside the dump the abort that follows asks for. The send runs on its own
/// thread and the wait is bounded, so a monitor that hangs never keeps the service from aborting.
/// Fails when the channel fails or the monitor does not answer within the bound.
pub(crate) fn send_panic_record(
    client: &Arc<Client>,
    record: &PanicRecord,
) -> Result<(), PanicRecordSendError> {
    let bytes = panic_record_bytes(record);
    let client = Arc::clone(client);
    send_within(PANIC_RECORD_SEND_BOUND, move || {
        client.send_message(PANIC_MESSAGE_KIND, bytes)?;
        // On macOS messages and dump requests travel apart; the ping makes the message land first.
        client.ping()
    })
}

// `record` as JSON of at most `PANIC_RECORD_MAX_BYTES`: each text is cut at a character boundary,
// by half again while escaping keeps the whole over the bound.
fn panic_record_bytes(record: &PanicRecord) -> Vec<u8> {
    let mut kept = PANIC_RECORD_MAX_BYTES;
    loop {
        let cut = |text: &str| text[..text.floor_char_boundary(kept)].to_owned();
        let bytes = serde_json::to_vec(&PanicRecord {
            message: cut(&record.message),
            location: cut(&record.location),
        })
        .expect("a panic record serializes as JSON");
        if bytes.len() <= PANIC_RECORD_MAX_BYTES {
            return bytes;
        }
        kept /= 2;
    }
}

// Runs `send` on a thread of its own and waits for its answer at most `bound`; a send still
// running past it is left to the abort that follows.
fn send_within(
    bound: Duration,
    send: impl FnOnce() -> Result<(), minidumper::Error> + Send + 'static,
) -> Result<(), PanicRecordSendError> {
    let (answer_sender, answer) = sync_channel(1);
    thread::Builder::new()
        .name("panic-record-send".to_owned())
        .spawn(move || {
            // The wait has given up once no one receives, and has said so itself.
            if let Err(unreceived) = answer_sender.send(send()) {
                drop(unreceived);
            }
        })
        .map_err(PanicRecordSendError::Thread)?;
    match answer.recv_timeout(bound) {
        Ok(sent) => sent.map_err(PanicRecordSendError::Channel),
        Err(RecvTimeoutError::Timeout) => Err(PanicRecordSendError::TimedOut(bound)),
        Err(RecvTimeoutError::Disconnected) => Err(PanicRecordSendError::Ended),
    }
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
    // The dump being written, removed when its write fails.
    writing: Mutex<Option<PathBuf>>,
}

impl ServerHandler for DumpWriter {
    fn create_minidump_file(&self) -> Result<(File, PathBuf), io::Error> {
        let path = self.dumps_folder.join(format!(
            "{}.{DUMP_EXTENSION}{DUMP_IN_PROGRESS_SUFFIX}",
            mint_uuid_v7()
        ));
        let file = sidekicks_platforms::create_new_file(&path, CRASH_FILE_MODE)?;
        // Held until the dump is finished and the file closed after `on_minidump_created`, so a
        // crash pass that meets the file meanwhile leaves it.
        if let Err(failure) = file.lock() {
            drop(file);
            let removal_failures = remove_leftover(&path).into_iter().collect();
            return Err(io::Error::new(
                failure.kind(),
                CleanupFailures::new(failure, removal_failures, "the crash dump's lock"),
            ));
        }
        *self.writing.lock().unwrap_or_else(PoisonError::into_inner) = Some(path.clone());
        Ok((file, path))
    }

    fn on_minidump_created(&self, result: Result<MinidumpBinary, minidumper::Error>) -> LoopAction {
        match result {
            Ok(dump) => {
                if let Err(failure) = self.finish_dump(&dump) {
                    write_error_line(&format!(
                        "the crash dump could not be finished: {}",
                        describe_error(&failure)
                    ));
                }
            }
            Err(failure) => {
                let writing = self
                    .writing
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                let removal_failures = writing
                    .into_iter()
                    .filter_map(|path| remove_leftover(&path));
                let failure = CleanupFailures::new(
                    failure,
                    removal_failures.collect(),
                    "the crash dump's write",
                );
                write_error_line(&format!(
                    "the crash dump could not be written: {}",
                    describe_error(&failure)
                ));
            }
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
    // that cannot be finished is removed with the record written for it, a failed removal kept
    // beside the cause.
    fn finish_dump(&self, dump: &MinidumpBinary) -> Result<(), CleanupFailures<io::Error>> {
        let finished = dump.path.with_extension("");
        let record_path = panic_record_path(&finished);
        let mut is_record_written = false;
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
                    Some(record) => {
                        replace_file_atomically(&record_path, &record, CRASH_FILE_MODE)
                            .map_err(io::Error::other)?;
                        is_record_written = true;
                        Ok(())
                    }
                    None => Ok(()),
                }
            })
            .and_then(|()| rename_replacing(&dump.path, &finished));
        let Err(failure) = placed else {
            return Ok(());
        };
        let leftovers = [
            Some(dump.path.as_path()),
            is_record_written.then_some(&*record_path),
        ];
        let removal_failures = leftovers.into_iter().flatten().filter_map(remove_leftover);
        Err(CleanupFailures::new(
            failure,
            removal_failures.collect(),
            "the crash dump's finish",
        ))
    }
}

// Removes a file a failed dump left, answering the removal's failure; one already gone is no
// failure.
fn remove_leftover(path: &Path) -> Option<io::Error> {
    std::fs::remove_file(path).none_if_missing().err()
}

/// The panic record's path beside the dump at `dump_path`.
pub(crate) fn panic_record_path(dump_path: &Path) -> PathBuf {
    let mut path = dump_path.with_extension("").into_os_string();
    path.push(PANIC_RECORD_SUFFIX);
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::sync::Mutex;
    use std::sync::mpsc::sync_channel;
    use std::thread;
    use std::time::{Duration, Instant};

    use minidumper::{LoopAction, MinidumpBinary, ServerHandler};
    use rstest::rstest;

    use super::{
        DumpWriter, PANIC_RECORD_MAX_BYTES, PanicRecord, PanicRecordSendError, panic_record_bytes,
        send_within,
    };

    // A dump whose write fails, as a full disk fails it, and one whose finish fails after its
    // panic record was written, the finished name taken by a folder, leave neither the partial
    // dump nor the record. Killed by a failed write that keeps its partial dump, and by a failed
    // finish that keeps the dump or the record it wrote.
    #[rstest]
    #[case::write_fails(false)]
    #[case::finish_fails(true)]
    fn a_failed_dump_leaves_no_file_of_its_own(#[case] is_written: bool) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let writer = DumpWriter {
            dumps_folder: scratch.path().to_path_buf(),
            panic: Mutex::new(Some(b"{}".to_vec())),
            writing: Mutex::new(None),
        };
        let (file, path) = writer
            .create_minidump_file()
            .expect("the dump's file is made");
        let finished = path.with_extension("");
        let written = if is_written {
            fs::create_dir_all(finished.join("inside")).expect("the finished name is taken");
            Ok(MinidumpBinary {
                file,
                path,
                contents: None,
            })
        } else {
            drop(file);
            Err(minidumper::Error::Io(io::Error::from(
                io::ErrorKind::StorageFull,
            )))
        };

        assert!(writer.on_minidump_created(written) == LoopAction::Exit);

        let left: Vec<_> = fs::read_dir(scratch.path())
            .expect("the dumps folder lists")
            .map(|entry| entry.expect("an entry").path())
            .collect();
        let taken = if is_written {
            vec![finished]
        } else {
            Vec::new()
        };
        assert_eq!(left, taken);
    }

    // A message far past the bound, of characters JSON escapes and characters of several bytes,
    // is cut under 64 KiB at a character boundary and still reads back. Killed by the cap dropped,
    // by a cut at a byte that splits a character, and by a cut that ignores the escaping.
    #[test]
    fn a_panic_record_is_cut_under_64_kib() {
        let message = "\"é\u{1}".repeat(64 * 1024);
        let record = PanicRecord {
            message: message.clone(),
            location: "src/main.rs:1:1".to_owned(),
        };

        let bytes = panic_record_bytes(&record);

        assert!(bytes.len() <= PANIC_RECORD_MAX_BYTES && bytes.len() < 64 * 1024);
        let sent: PanicRecord = serde_json::from_slice(&bytes).expect("the record reads back");
        assert!(!sent.message.is_empty() && message.starts_with(&sent.message));
        assert_eq!(sent.location, record.location);
    }

    // A monitor that never answers holds the panic no longer than the bound. Killed by a wait
    // with no bound, which fails here at the outer wait rather than hanging.
    #[test]
    fn a_hung_monitor_does_not_hold_the_panic_past_the_bound() {
        let bound = Duration::from_millis(100);
        let (outcome_sender, outcome) = sync_channel(1);
        let started = Instant::now();
        thread::spawn(move || {
            let sent = send_within(bound, || {
                loop {
                    thread::park();
                }
            });
            outcome_sender
                .send(sent)
                .expect("the test waits for the outcome");
        });

        let sent = outcome
            .recv_timeout(Duration::from_secs(5))
            .expect("the send gives up within its bound");

        assert!(
            matches!(sent, Err(PanicRecordSendError::TimedOut(_))),
            "{sent:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
