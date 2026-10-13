//! The service log: every `tracing` line goes to the daemon's standard error and to its own file in
//! `logs/` in the data folder, `service-<local time begun, to the millisecond>.log`, so the log is
//! kept whoever started the daemon and whatever they did with its streams.
//!
//! - A new file is begun at each start, when the local day turns and at 16 MiB, so a daemon that
//!   runs for weeks leaves day-sized files the diagnostic-log expiry deletes whole. A name taken in
//!   the same millisecond gets `.restart-0000`, which still sorts in order.
//! - Lines are written straight to the file, never queued, so the last line before an end is kept.
//!   Line times are UTC; file names are local time.
//! - A folder or file that cannot be opened leaves standard error carrying the log, which says so
//!   once; a standard error whose reader has gone leaves the file carrying it, which says so once.
//!   Neither stops the daemon.

use std::error::Error;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use flexi_logger::writers::{ArcFileLogWriter, FileLogWriter, FileLogWriterHandle};
use flexi_logger::{Age, Cleanup, Criterion, FileSpec, FlexiLoggerError, Naming};
use tracing::Dispatch;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::writer::{MakeWriter, MakeWriterExt};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::{SubscriberInitExt, TryInitError};

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME: &str = "logs";

// The most bytes one file holds before the next is begun: 16 MiB, so each file stays small enough
// to open and to delete whole; at ordinary rates the day turns a file first.
const SERVICE_LOG_FILE_BYTE_CEILING: u64 = 16 * 1024 * 1024;

// `service-2026-10-12T21-05-48-642`, the local time a file was begun; the suffix `.log` follows.
const SERVICE_LOG_FILE_NAME_FORMAT: &str = "service-%Y-%m-%dT%H-%M-%S-%3f";

// The names a service log file takes, `0` standing for any ASCII digit: one begun alone in its
// millisecond, and one begun in the same millisecond as another.
const SERVICE_LOG_FILE_NAME_TEMPLATES: [&[u8]; 2] = [
    b"service-0000-00-00T00-00-00-000.log",
    b"service-0000-00-00T00-00-00-000.restart-0000.log",
];

// The line the file gets once, when standard error's reader has gone.
const STANDARD_ERROR_GONE_NOTICE: &str =
    "Standard error's reader is gone, so the service log goes to its file alone from here";

/// The service log built and not yet installed: `main` installs it with [`ServiceLog::install`]
/// before anything else logs.
pub struct ServiceLog {
    dispatch: Dispatch,
    file: Result<ServiceLogFile, ServiceLogFileError>,
}

/// What `main` keeps for the daemon's life once the service log is installed: dropping it shuts the
/// file writer down.
pub struct ServiceLogGuard {
    file: Option<ServiceLogFile>,
}

// The open file writer and the handle whose drop shuts it down.
struct ServiceLogFile {
    writer: ArcFileLogWriter,
    _handle: FileLogWriterHandle,
}

/// Why the service log file could not be opened, so the log goes to standard error alone.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ServiceLogFileError {
    /// The `logs/` folder could not be made, or made private.
    #[error("the service log folder {} could not be made", .folder.display())]
    Folder {
        /// The `logs/` folder.
        folder: PathBuf,
        /// The failure making it.
        #[source]
        source: io::Error,
    },
    /// The first file in the folder could not be opened.
    #[error("the service log file in {} could not be opened", .folder.display())]
    File {
        /// The `logs/` folder.
        folder: PathBuf,
        /// The file writer's failure.
        #[source]
        source: FlexiLoggerError,
    },
}

impl ServiceLog {
    /// Installs the service log as the process's subscriber, `log` records included, and says once
    /// on standard error when the file could not be opened. Fails when a subscriber or a `log`
    /// logger is already installed.
    pub fn install(self) -> Result<ServiceLogGuard, TryInitError> {
        self.dispatch.try_init()?;
        let file = match self.file {
            Ok(file) => Some(file),
            Err(failure) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "The service log file could not be opened, so the service log goes to \
                     standard error alone from here"
                );
                None
            }
        };
        Ok(ServiceLogGuard { file })
    }
}

impl ServiceLogGuard {
    /// A handle on the service log file's writer, for the panic hook to flush before the process
    /// ends; `None` when the file could not be opened.
    pub fn file_writer(&self) -> Option<ArcFileLogWriter> {
        self.file.as_ref().map(|file| file.writer.clone())
    }
}

/// Builds the service log over `data_folder`'s `logs/`, which `create_private_folder` makes, with
/// its parents, readable by the person alone. Never fails: a folder or file that cannot be opened
/// leaves `standard_error` alone carrying the log, which [`ServiceLog::install`] says once.
pub fn open_service_log<StandardError>(
    data_folder: &Path,
    standard_error: StandardError,
    create_private_folder: fn(&Path) -> io::Result<()>,
) -> ServiceLog
where
    StandardError: Write + Send + 'static,
{
    let folder = service_log_folder(data_folder);
    match open_service_log_file(&folder, create_private_folder) {
        Ok(file) => {
            let file_for_lines = file.writer.clone();
            let file_for_notice = file.writer.clone();
            let standard_error = StandardErrorWriter::new(standard_error, Some(file_for_notice));
            ServiceLog {
                dispatch: service_log_dispatch(standard_error.and(move || file_for_lines.clone())),
                file: Ok(file),
            }
        }
        Err(failure) => ServiceLog {
            dispatch: service_log_dispatch(StandardErrorWriter::new(standard_error, None)),
            file: Err(failure),
        },
    }
}

/// The folder in `data_folder` that holds the service log files.
pub(crate) fn service_log_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(SERVICE_LOG_FOLDER_NAME)
}

/// Whether `file_name` names a service log file, `service-<time begun>.log` with or without its
/// `.restart-NNNN`: the only files in `logs/` the diagnostic-log expiry deletes.
pub(crate) fn is_service_log_file_name(file_name: &str) -> bool {
    SERVICE_LOG_FILE_NAME_TEMPLATES
        .iter()
        .any(|template| fits_template(file_name.as_bytes(), template))
}

// A `0` in the template stands for any ASCII digit; every other byte stands for itself.
fn fits_template(name: &[u8], template: &[u8]) -> bool {
    name.len() == template.len()
        && name.iter().zip(template).all(|(byte, expected)| {
            if *expected == b'0' {
                byte.is_ascii_digit()
            } else {
                byte == expected
            }
        })
}

fn open_service_log_file(
    folder: &Path,
    create_private_folder: fn(&Path) -> io::Result<()>,
) -> Result<ServiceLogFile, ServiceLogFileError> {
    create_private_folder(folder).map_err(|source| ServiceLogFileError::Folder {
        folder: folder.to_path_buf(),
        source,
    })?;
    let (writer, handle) = FileLogWriter::builder(
        FileSpec::default()
            .directory(folder)
            .suppress_basename()
            .suppress_timestamp()
            .suffix("log"),
    )
    .rotate(
        Criterion::AgeOrSize(Age::Day, SERVICE_LOG_FILE_BYTE_CEILING),
        Naming::TimestampsCustomFormat {
            current_infix: None,
            format: SERVICE_LOG_FILE_NAME_FORMAT,
        },
        // Old files are deleted by the diagnostic-log expiry, by when each was last written.
        Cleanup::Never,
    )
    .try_build_with_handle()
    .map_err(|source| ServiceLogFileError::File {
        folder: folder.to_path_buf(),
        source,
    })?;
    Ok(ServiceLogFile {
        writer,
        _handle: handle,
    })
}

// One fmt layer, built with `fmt::layer()`, whose failed writes are dropped rather than printed:
// the `fmt()` builder prints them with `eprintln!`, which panics on a closed standard error. Lines
// below info, which libraries write in bulk, are left out.
fn service_log_dispatch<Writers>(writers: Writers) -> Dispatch
where
    Writers: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    Dispatch::new(
        tracing_subscriber::registry().with(LevelFilter::INFO).with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writers),
        ),
    )
}

// Standard error for the service log. At its first `BrokenPipe` it stops writing there and writes
// the one notice to the file; from then on it takes every line and writes none, so the file side
// beside it keeps writing.
struct StandardErrorWriter<StandardError> {
    standard_error: Mutex<StandardError>,
    is_open: AtomicBool,
    file: Option<ArcFileLogWriter>,
}

impl<StandardError: Write> StandardErrorWriter<StandardError> {
    fn new(standard_error: StandardError, file: Option<ArcFileLogWriter>) -> Self {
        Self {
            standard_error: Mutex::new(standard_error),
            is_open: AtomicBool::new(true),
            file,
        }
    }

    fn lock_standard_error(&self) -> MutexGuard<'_, StandardError> {
        self.standard_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    // Marks standard error closed and, the first time only, writes the notice to the file in the
    // shape the fmt layer gives a line.
    fn close(&self, failure: &io::Error) -> io::Result<()> {
        if !self.is_open.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let Some(file) = &self.file else {
            return Ok(());
        };
        let notice = format!(
            "{}  WARN {}: {STANDARD_ERROR_GONE_NOTICE} error={failure}\n",
            jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%S%.6fZ"),
            module_path!(),
        );
        file.clone().write_all(notice.as_bytes())
    }
}

impl<'writer, StandardError: Write + 'writer> MakeWriter<'writer>
    for StandardErrorWriter<StandardError>
{
    type Writer = &'writer Self;

    fn make_writer(&'writer self) -> Self::Writer {
        self
    }
}

impl<StandardError: Write> Write for &StandardErrorWriter<StandardError> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if !self.is_open.load(Ordering::Acquire) {
            return Ok(buffer.len());
        }
        let written = self.lock_standard_error().write(buffer);
        match written {
            Ok(count) => Ok(count),
            Err(failure) if failure.kind() == io::ErrorKind::BrokenPipe => {
                self.close(&failure)?;
                Ok(buffer.len())
            }
            Err(failure) => Err(failure),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.is_open.load(Ordering::Acquire) {
            return Ok(());
        }
        let flushed = self.lock_standard_error().flush();
        match flushed {
            Ok(()) => Ok(()),
            Err(failure) if failure.kind() == io::ErrorKind::BrokenPipe => self.close(&failure),
            Err(failure) => Err(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::path::Path;

    use super::{
        STANDARD_ERROR_GONE_NOTICE, is_service_log_file_name, open_service_log, service_log_folder,
    };

    fn create_folder(folder: &Path) -> io::Result<()> {
        std::fs::create_dir_all(folder)
    }

    #[test]
    fn a_gone_standard_error_leaves_every_line_and_one_notice_in_the_file() {
        let data_folder = tempfile::tempdir().expect("a scratch data folder");
        let (reader, writer) = io::pipe().expect("a pipe");
        // With the reader gone, each write to the pipe fails with `BrokenPipe`.
        drop(reader);
        let service_log = open_service_log(data_folder.path(), writer, create_folder);
        let mut file = service_log
            .file
            .as_ref()
            .expect("the file opens")
            .writer
            .clone();

        tracing::dispatcher::with_default(&service_log.dispatch, || {
            tracing::info!(reading = "processor", "the first line");
            tracing::info!(reading = "memory", "the second line");
        });
        file.flush().expect("the file flushes");

        let entries = std::fs::read_dir(service_log_folder(data_folder.path()))
            .expect("the logs folder lists")
            .collect::<Result<Vec<_>, _>>()
            .expect("each entry reads");
        assert_eq!(entries.len(), 1);
        let file_name = entries[0].file_name();
        assert!(is_service_log_file_name(
            file_name.to_str().expect("an ASCII file name")
        ));
        let text = std::fs::read_to_string(entries[0].path()).expect("the file reads");
        assert!(text.contains("the first line reading=\"processor\""));
        assert!(text.contains("the second line reading=\"memory\""));
        assert_eq!(text.matches(STANDARD_ERROR_GONE_NOTICE).count(), 1);
    }
}
