//! The service's end on a panic: a panic in any thread or task is written, its credentials
//! scrubbed, to the service log and to one record in the crash reports folder, its message and
//! place are sent to the crash monitor once the service is connected to one, the log's file is
//! flushed, and the process aborts, so the supervisor restarts the service rather than leaving it
//! running without the work that panicked; the abort is the crash the monitor writes a dump of.

use std::backtrace::Backtrace;
use std::io::Write as _;
use std::panic::PanicHookInfo;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use flexi_logger::writers::ArcFileLogWriter;
use jiff::Timestamp;
use sidekicks_ipc::redaction::scrub_credentials;
use sidekicks_platforms::{LeftoverSweep, create_private_folder, replace_file_atomically};
use sidekicks_std::standard_error::write_error_line;

use crate::daemon::crash::monitor::{PanicRecord, send_panic_record};
use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;

/// The start of a panic's record's name in the crash reports folder.
pub(crate) const PANIC_RECORD_FILE_PREFIX: &str = "panic-";

/// A panic's record's extension in the crash reports folder.
pub(crate) const PANIC_RECORD_FILE_EXTENSION: &str = "txt";

// A crash record readable by the person alone.
const CRASH_RECORD_MODE: u32 = 0o600;

// Counts this run's crash records, so two panics in one millisecond never write one name.
static CRASH_RECORD_COUNT: AtomicU64 = AtomicU64::new(0);

// The crash monitor each panic's record is sent to, once the service has connected to it.
static CRASH_MONITOR: OnceLock<Arc<minidumper::Client>> = OnceLock::new();

/// Sends each later panic's message and place to the crash monitor `client` reaches, before the
/// abort that asks it for a dump. The first call wins; a later one is dropped.
pub(crate) fn send_panics_to_monitor(client: Arc<minidumper::Client>) {
    if CRASH_MONITOR.set(client).is_err() {
        tracing::warn!("the panics were already sent to a crash monitor");
    }
}

/// Installs the hook every panic runs before it unwinds: it logs the panic, its place, its thread
/// and its backtrace, writes them to a new record in `data_folder`'s crash reports folder, flushes
/// `log_file` and aborts the process, the one place the service ends itself.
pub(crate) fn install_panic_hook(data_folder: &Path, log_file: Option<ArcFileLogWriter>) {
    let crash_reports = data_folder.join(CRASH_REPORTS_FOLDER_NAME);
    std::panic::set_hook(Box::new(move |panic| {
        let (message, place) = panic_message_and_place(panic);
        let report = scrub_credentials(&describe_panic(&message, &place));
        tracing::error!(report = %report, "the background service panicked and stops");
        if let Some(monitor) = CRASH_MONITOR.get()
            && let Err(error) = send_panic_record(
                monitor,
                &PanicRecord {
                    message: scrub_credentials(&message),
                    location: place,
                },
            )
        {
            tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "the panic's record could not be sent to the crash monitor"
            );
        }
        if let Err(error) = write_crash_record(&crash_reports, &report) {
            tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "the panic's crash record could not be written"
            );
        }
        if let Some(mut log_file) = log_file.clone()
            && let Err(error) = log_file.flush()
        {
            // The log's file is what failed, so standard error alone is left to say so.
            write_error_line(&format!(
                "the service log could not be flushed before the panic's end: {error}"
            ));
        }
        std::process::abort();
    }));
}

// The panic's message and the place in the source it was raised at.
fn panic_message_and_place(panic: &PanicHookInfo<'_>) -> (String, String) {
    let message = panic
        .payload()
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_owned());
    let place = panic.location().map_or_else(
        || "an unknown place".to_owned(),
        |location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        },
    );
    (message, place)
}

// The panic's message, place, thread and backtrace, one report.
fn describe_panic(message: &str, place: &str) -> String {
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("an unnamed thread");
    format!(
        "{message}\nat {place}, in {thread_name}\n{}",
        Backtrace::force_capture()
    )
}

// Writes `report` to a new record in `folder`, made private first. Fails with the folder's or the
// write's error.
fn write_crash_record(folder: &Path, report: &str) -> std::io::Result<()> {
    create_private_folder(folder)?;
    let record = folder.join(format!(
        "{PANIC_RECORD_FILE_PREFIX}{}-{}.{PANIC_RECORD_FILE_EXTENSION}",
        Timestamp::now().strftime("%Y-%m-%dT%H-%M-%S-%3fZ"),
        CRASH_RECORD_COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    // The crash pass sweeps the folder's leftovers.
    replace_file_atomically(
        &record,
        report.as_bytes(),
        CRASH_RECORD_MODE,
        LeftoverSweep::Swept,
    )
    .map_err(std::io::Error::other)
}
