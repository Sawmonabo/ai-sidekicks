//! The service's end on a panic: a panic in any thread or task is written to the service log and
//! to one record in the crash reports folder, the log's file is flushed, and the process aborts,
//! so the supervisor restarts the service rather than leaving it running without the work that
//! panicked.

use std::backtrace::Backtrace;
use std::io::Write as _;
use std::panic::PanicHookInfo;
use std::path::Path;

use flexi_logger::writers::ArcFileLogWriter;
use jiff::Timestamp;
use sidekicks_platforms::{create_private_folder, replace_file_atomically};

use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;

// A crash record readable by the person alone.
const CRASH_RECORD_MODE: u32 = 0o600;

/// Installs the hook every panic runs before it unwinds: it logs the panic, its place, its thread
/// and its backtrace, writes them to a new record in `data_folder`'s crash reports folder, flushes
/// `log_file` and aborts the process, the one place the service ends itself.
pub(crate) fn install_panic_hook(data_folder: &Path, log_file: Option<ArcFileLogWriter>) {
    let crash_reports = data_folder.join(CRASH_REPORTS_FOLDER_NAME);
    std::panic::set_hook(Box::new(move |panic| {
        let report = describe_panic(panic);
        tracing::error!(report = %report, "The background service panicked and stops");
        if let Err(error) = write_crash_record(&crash_reports, &report) {
            tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "The panic's crash record could not be written"
            );
        }
        if let Some(mut log_file) = log_file.clone()
            && let Err(error) = log_file.flush()
        {
            // The log's file is what failed, so standard error alone is left to say so; a failure
            // there has nowhere left to go.
            if let Err(write_error) = writeln!(
                std::io::stderr().lock(),
                "The service log could not be flushed before the panic's end: {error}"
            ) {
                drop(write_error);
            }
        }
        std::process::abort();
    }));
}

// The panic's message, place, thread and backtrace, one report.
fn describe_panic(panic: &PanicHookInfo<'_>) -> String {
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
        "panic-{}.txt",
        Timestamp::now().strftime("%Y-%m-%dT%H-%M-%S-%3fZ")
    ));
    replace_file_atomically(&record, report.as_bytes(), CRASH_RECORD_MODE)
        .map_err(std::io::Error::other)
}
