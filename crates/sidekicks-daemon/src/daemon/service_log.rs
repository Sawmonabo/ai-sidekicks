//! The service log: every `tracing` line goes to the daemon's standard error and to its own file in
//! `logs/` in the data folder, `service-<local time begun, to the millisecond>.log`, so the log is
//! kept whoever started the daemon and whatever they did with its streams.
//!
//! - The first file opens at start. The log's own writer begins the next file when the local day
//!   turns and before a line would take the file past 16 MiB, so a daemon that runs for weeks
//!   leaves day-sized files the diagnostic-log expiry deletes whole. A turn in the same
//!   millisecond as the file before it takes `.restart-0000`, which still sorts in order; a start
//!   whose clock was set back onto an existing file's millisecond begins that file again.
//! - Lines are written straight to both sides, never queued, so the last line before an end is
//!   kept. Line times are UTC; file names are local time.
//! - A file that fails to open at start says so once on standard error, which carries the log
//!   alone from then on. A failure of the file at a turn, on a write or on a flush says so once on
//!   standard error, which carries the log alone until the file takes a line again: the next line
//!   reopens the file, or begins the next one once the day has turned. Every failure of standard
//!   error says so once in the file, which carries it alone. Neither stops the daemon.
//! - Lines from the daemon's own crates are kept from info up, every other crate's from warn up.

use std::borrow::Cow;
use std::collections::HashSet;
use std::error::Error;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flexi_logger::writers::{ArcFileLogWriter, FileLogWriter, FileLogWriterHandle};
use flexi_logger::{Cleanup, Criterion, FileSpec, FlexiLoggerError, Naming};
use jiff::{Timestamp, Zoned};
use sidekicks_platforms::create_private_folder;
use tracing::Dispatch;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::{SubscriberInitExt, TryInitError};

use sidekicks_std::mutex_lock::lock;
use sidekicks_store::data_folder::service_log_folder;

/// The folder in the data folder that holds the service's crash reports, one file per crash.
pub(crate) const CRASH_REPORTS_FOLDER_NAME: &str = "crash-reports";

// The most bytes one file holds before the next is begun: 16 MiB, so each file stays small enough
// to open and to delete whole; at ordinary rates the day turns a file first.
const SERVICE_LOG_FILE_BYTE_CEILING: u64 = 16 * 1024 * 1024;

// `service-2026-10-12T21-05-48-642`, the local time a file was begun; the suffix `.log` follows.
const SERVICE_LOG_FILE_NAME_FORMAT: &str = "service-%Y-%m-%dT%H-%M-%S-%3f";

// The names a service log file takes, `0` standing for any ASCII digit: one begun alone in its
// millisecond, and one begun in the same millisecond as the file before it.
const SERVICE_LOG_FILE_NAME_TEMPLATES: [&[u8]; 2] = [
    b"service-0000-00-00T00-00-00-000.log",
    b"service-0000-00-00T00-00-00-000.restart-0000.log",
];

// The target prefix of the daemon's own crates, whose info lines the log keeps.
const OWN_CRATES_TARGET_PREFIX: &str = "sidekicks_";

// The line the file gets once, when standard error fails.
const STANDARD_ERROR_GONE_NOTICE: &str =
    "standard error failed, so the service log goes to its file alone from here";

// The line standard error gets once, when the file fails, until it takes a line again.
const FILE_FAILED_NOTICE: &str = "the service log file failed, so the service log goes to standard \
                                  error alone until the file takes a line again";

/// The service log built and not yet installed: `main` installs it with [`ServiceLog::install`]
/// before anything else logs.
pub(crate) struct ServiceLog {
    dispatch: Dispatch,
    sides: Arc<ServiceLogSides>,
    file_handle: Option<FileLogWriterHandle>,
    open_failure: Option<ServiceLogFileError>,
}

/// What `main` keeps for the daemon's life once the service log is installed: dropping it shuts the
/// file writer down.
pub(crate) struct ServiceLogGuard {
    file_writer: Option<ArcFileLogWriter>,
    files: ServiceLogFiles,
    _file_handle: Option<FileLogWriterHandle>,
}

/// A view of the service log's files, for the diagnostic-log expiry.
#[derive(Clone)]
pub(crate) struct ServiceLogFiles {
    sides: Arc<ServiceLogSides>,
}

/// Why the service log file could not be opened at start, so the log goes to standard error alone.
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
    /// The file writer could not be built over the folder.
    #[error("the service log writer for {} could not be built", .folder.display())]
    Writer {
        /// The `logs/` folder.
        folder: PathBuf,
        /// The file writer's failure.
        #[source]
        source: FlexiLoggerError,
    },
    /// The first file in the folder could not be opened, or not found once opened.
    #[error("the first service log file in {} could not be opened", .folder.display())]
    Open {
        /// The `logs/` folder.
        folder: PathBuf,
        /// The failure opening it.
        #[source]
        source: io::Error,
    },
}

impl ServiceLog {
    /// The files of this log, never installed, for a test that starts the daemon over it.
    #[cfg(test)]
    pub(crate) fn files(&self) -> ServiceLogFiles {
        ServiceLogFiles {
            sides: Arc::clone(&self.sides),
        }
    }

    /// Installs the service log as the process's subscriber, `log` records included, and says once
    /// on standard error when the file could not be opened. Fails when a subscriber or a `log`
    /// logger is already installed.
    pub(crate) fn install(self) -> Result<ServiceLogGuard, TryInitError> {
        self.dispatch.try_init()?;
        if let Some(failure) = &self.open_failure {
            tracing::warn!(
                error = failure as &(dyn Error + 'static),
                "the service log file could not be opened, so the service log goes to standard \
                 error alone from here"
            );
        }
        let file_writer = self
            .sides
            .file
            .as_ref()
            .map(|file| lock(file).writer.clone());
        Ok(ServiceLogGuard {
            file_writer,
            files: ServiceLogFiles { sides: self.sides },
            _file_handle: self.file_handle,
        })
    }
}

impl ServiceLogGuard {
    /// A handle on the service log file's writer, taken at install so the panic hook can flush it
    /// without waiting on the log's own lock; `None` when the file could not be opened.
    pub(crate) fn file_writer(&self) -> Option<ArcFileLogWriter> {
        self.file_writer.clone()
    }

    /// The service log's files, for the diagnostic-log expiry.
    pub(crate) fn files(&self) -> ServiceLogFiles {
        self.files.clone()
    }
}

impl ServiceLogFiles {
    /// The file the service log writes now, which the expiry never deletes; it stays the live file
    /// through a failed write, which the next line reopens; `None` when it never opened.
    pub(crate) fn live_file(&self) -> Option<PathBuf> {
        Some(lock(self.sides.file.as_ref()?).live_file.clone())
    }
}

/// Builds the service log over `data_folder`'s `logs/`, made with its parents readable by the
/// person alone (mode 0700 on macOS and Linux; on Windows the folder keeps the profile's access
/// list), and opens its first file. Never fails: a folder or file that cannot be opened
/// leaves `standard_error` alone carrying the log, which [`ServiceLog::install`] says once.
pub(crate) fn open_service_log<StandardError>(
    data_folder: &Path,
    standard_error: StandardError,
) -> ServiceLog
where
    StandardError: Write + Send + 'static,
{
    let folder = service_log_folder(data_folder);
    let (file, file_handle, open_failure) = match open_service_log_file(&folder) {
        Ok((file, handle)) => (Some(Mutex::new(file)), Some(handle), None),
        Err(failure) => (None, None, Some(failure)),
    };
    let sides = Arc::new(ServiceLogSides {
        standard_error: Mutex::new(StandardErrorSide {
            writer: Box::new(standard_error),
            is_open: true,
        }),
        file,
    });
    ServiceLog {
        dispatch: service_log_dispatch(Arc::clone(&sides)),
        sides,
        file_handle,
        open_failure,
    }
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

// Makes the folder, builds the file writer and opens the first file, so a file that cannot be
// opened is known at start rather than at the first line.
fn open_service_log_file(
    folder: &Path,
) -> Result<(FileSide, FileLogWriterHandle), ServiceLogFileError> {
    let open_failure = |source| ServiceLogFileError::Open {
        folder: folder.to_path_buf(),
        source,
    };
    create_private_folder(folder).map_err(|source| ServiceLogFileError::Folder {
        folder: folder.to_path_buf(),
        source,
    })?;
    let names_before = service_log_file_names(folder).map_err(open_failure)?;
    let (mut writer, handle) = FileLogWriter::builder(
        FileSpec::default()
            .directory(folder)
            .suppress_basename()
            .suppress_timestamp()
            .suffix("log"),
    )
    .rotate(
        // Past reach: the file side below turns the file itself, so a failed turn is said once
        // rather than retried and printed on every later line.
        Criterion::Size(u64::MAX),
        Naming::TimestampsCustomFormat {
            current_infix: None,
            format: SERVICE_LOG_FILE_NAME_FORMAT,
        },
        // Old files are deleted by the diagnostic-log expiry, by when each was last written.
        Cleanup::Never,
    )
    .try_build_with_handle()
    .map_err(|source| ServiceLogFileError::Writer {
        folder: folder.to_path_buf(),
        source,
    })?;
    // The writer opens its file at its first write; `write_all` skips an empty one.
    let _empty_write_count = Write::write(&mut writer, &[]).map_err(open_failure)?;
    let live_file = newest_added_file(folder, &names_before).map_err(open_failure)?;
    let next_day_at =
        next_local_midnight().map_err(|failure| open_failure(io::Error::other(failure)))?;
    let file = FileSide {
        writer,
        folder: folder.to_path_buf(),
        live_file,
        next_day_at,
        byte_count: 0,
        is_failing: false,
    };
    Ok((file, handle))
}

// One fmt layer, built with `fmt::layer()`, which drops a failed write rather than printing it as
// the `fmt()` builder does with `eprintln!`; the writer itself never fails. The daemon's own crates
// keep info lines; every other crate, whose info lines come in bulk, keeps warn and error.
fn service_log_dispatch(sides: Arc<ServiceLogSides>) -> Dispatch {
    let filter = Targets::new()
        .with_target(OWN_CRATES_TARGET_PREFIX, LevelFilter::INFO)
        .with_default(LevelFilter::WARN);
    Dispatch::new(
        tracing_subscriber::registry().with(filter).with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(ServiceLogWriter(sides)),
        ),
    )
}

// Both sides of the log, each behind its own lock; neither lock is held while the other is taken.
struct ServiceLogSides {
    standard_error: Mutex<StandardErrorSide>,
    file: Option<Mutex<FileSide>>,
}

struct StandardErrorSide {
    writer: Box<dyn Write + Send>,
    is_open: bool,
}

// The file side: the file writer, the file it holds open, and when it turns next.
struct FileSide {
    writer: ArcFileLogWriter,
    folder: PathBuf,
    live_file: PathBuf,
    // The next local midnight, when the next file is begun.
    next_day_at: Timestamp,
    byte_count: u64,
    // Whether a turn, write or flush failed and was told, and no line has landed since.
    is_failing: bool,
}

impl ServiceLogSides {
    fn write_line(&self, line: &[u8]) {
        self.write_standard_error(line);
        self.write_file(line);
    }

    // Writes to standard error while it is open. A failure closes it and says so once in the file.
    fn write_standard_error(&self, bytes: &[u8]) {
        let failure = {
            let mut standard_error = lock(&self.standard_error);
            if !standard_error.is_open {
                return;
            }
            // `write_all` retries an interrupted write itself, so any failure here is final.
            match standard_error.writer.write_all(bytes) {
                Ok(()) => return,
                Err(failure) => {
                    standard_error.is_open = false;
                    failure
                }
            }
        };
        self.write_file(notice_line(STANDARD_ERROR_GONE_NOTICE, &failure).as_bytes());
    }

    fn write_file(&self, bytes: &[u8]) {
        self.write_file_through(bytes, <ArcFileLogWriter as Write>::write_all);
    }

    // Writes to the file through `write`, turning it first when due. The first failure in a row
    // says so once on standard error, and the next line tries the file again.
    fn write_file_through(
        &self,
        bytes: &[u8],
        write: impl FnOnce(&mut ArcFileLogWriter, &[u8]) -> io::Result<()>,
    ) {
        let Some(file) = &self.file else {
            return;
        };
        let failure = {
            let mut file = lock(file);
            match file.write_line(bytes, write) {
                Ok(()) => {
                    file.is_failing = false;
                    return;
                }
                Err(_failure) if file.is_failing => return,
                Err(failure) => {
                    file.is_failing = true;
                    failure
                }
            }
        };
        self.write_standard_error(notice_line(FILE_FAILED_NOTICE, &failure).as_bytes());
    }

    fn flush(&self) {
        let standard_error_failure = {
            let mut standard_error = lock(&self.standard_error);
            match standard_error.writer.flush() {
                Ok(()) => None,
                Err(failure) if failure.kind() == io::ErrorKind::Interrupted => None,
                Err(failure) => standard_error.is_open.then(|| {
                    standard_error.is_open = false;
                    failure
                }),
            }
        };
        if let Some(failure) = standard_error_failure {
            self.write_file(notice_line(STANDARD_ERROR_GONE_NOTICE, &failure).as_bytes());
        }
        let Some(file) = &self.file else {
            return;
        };
        let file_failure = {
            let mut file = lock(file);
            if file.is_failing {
                return;
            }
            file.writer
                .flush()
                .err()
                .inspect(|_| file.is_failing = true)
        };
        if let Some(failure) = file_failure {
            self.write_standard_error(notice_line(FILE_FAILED_NOTICE, &failure).as_bytes());
        }
    }
}

impl FileSide {
    // Turns the file when the local day has turned or the line would take it past the ceiling, or
    // else reopens it after a failure, then writes the whole line through `write`. The first line
    // into a reopened file starts on a line of its own, since a failed write may have left part of
    // one.
    fn write_line(
        &mut self,
        line: &[u8],
        write: impl FnOnce(&mut ArcFileLogWriter, &[u8]) -> io::Result<()>,
    ) -> io::Result<()> {
        let line_length = u64::try_from(line.len()).unwrap_or(u64::MAX);
        let is_full = self.byte_count > 0
            && self.byte_count.saturating_add(line_length) > SERVICE_LOG_FILE_BYTE_CEILING;
        let line = if is_full || Timestamp::now() >= self.next_day_at {
            self.turn()?;
            Cow::Borrowed(line)
        } else if self.is_failing {
            self.writer.reopen_outputfile().map_err(io::Error::other)?;
            Cow::Owned([b"\n", line].concat())
        } else {
            Cow::Borrowed(line)
        };
        write(&mut self.writer, &line)?;
        let written = u64::try_from(line.len()).unwrap_or(u64::MAX);
        self.byte_count = self.byte_count.saturating_add(written);
        Ok(())
    }

    // Begins the next file and learns its name.
    fn turn(&mut self) -> io::Result<()> {
        let names_before = service_log_file_names(&self.folder)?;
        self.writer.rotate().map_err(io::Error::other)?;
        self.live_file = newest_added_file(&self.folder, &names_before)?;
        self.next_day_at = next_local_midnight().map_err(io::Error::other)?;
        self.byte_count = 0;
        Ok(())
    }
}

// The file just begun in `folder`: the newest name not listed before, or, when a start's clock was
// set back onto an existing name, the newest name of all.
fn newest_added_file(folder: &Path, names_before: &HashSet<String>) -> io::Result<PathBuf> {
    let names = service_log_file_names(folder)?;
    let newest = names
        .iter()
        .filter(|name| !names_before.contains(*name))
        .max()
        .or_else(|| names.iter().max())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no service log file is in the folder after opening one",
            )
        })?;
    Ok(folder.join(newest))
}

fn service_log_file_names(folder: &Path) -> io::Result<HashSet<String>> {
    let mut names = HashSet::new();
    for entry in std::fs::read_dir(folder)? {
        // A name that is not UTF-8 is no service log file's.
        if let Ok(name) = entry?.file_name().into_string()
            && is_service_log_file_name(&name)
        {
            names.insert(name);
        }
    }
    Ok(names)
}

fn next_local_midnight() -> Result<Timestamp, jiff::Error> {
    Ok(Zoned::now().tomorrow()?.start_of_day()?.timestamp())
}

// A notice in the shape the fmt layer gives a line, written straight to the other side, since an
// event from inside the writer would come back into it.
fn notice_line(notice: &str, failure: &io::Error) -> String {
    format!(
        "{}  WARN {}: {notice} error={failure}\n",
        Timestamp::now().strftime("%Y-%m-%dT%H:%M:%S%.6fZ"),
        module_path!(),
    )
}

// The fmt layer's writer: one line goes to both sides whole, and the writer never fails.
struct ServiceLogWriter(Arc<ServiceLogSides>);

impl<'writer> MakeWriter<'writer> for ServiceLogWriter {
    type Writer = &'writer ServiceLogSides;

    fn make_writer(&'writer self) -> Self::Writer {
        &self.0
    }
}

impl Write for &ServiceLogSides {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.write_line(buffer);
        Ok(buffer.len())
    }

    fn write_all(&mut self, buffer: &[u8]) -> io::Result<()> {
        self.write_line(buffer);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        ServiceLogSides::flush(self);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Read as _, Write as _};

    use flexi_logger::writers::ArcFileLogWriter;

    use super::{
        FILE_FAILED_NOTICE, STANDARD_ERROR_GONE_NOTICE, ServiceLogFiles, is_service_log_file_name,
        open_service_log,
    };
    use sidekicks_store::data_folder::service_log_folder;

    // Each run of failed writes to the file, two in a row, says so once on standard error, and the
    // next line lands in the file again: on a line of its own after a write that failed halfway,
    // and at the live file's path once the file was removed under the log. Killed by a failure
    // that ends the file for good, by a notice for each failed line, by a line that joins the part
    // a failed write left, and by a recovery that writes on without reopening the file.
    #[test]
    fn a_failed_file_write_is_told_once_and_the_next_line_lands() {
        let data_folder = tempfile::tempdir().expect("a scratch data folder");
        let (mut standard_error, writer) = io::pipe().expect("a pipe");
        let service_log = open_service_log(data_folder.path(), writer);
        let files = ServiceLogFiles {
            sides: std::sync::Arc::clone(&service_log.sides),
        };
        let live_file = files.live_file().expect("the file opened");
        let refuse = |_: &mut ArcFileLogWriter, _: &[u8]| -> io::Result<()> {
            Err(io::Error::from(io::ErrorKind::StorageFull))
        };
        let write_halfway = |file: &mut ArcFileLogWriter, line: &[u8]| -> io::Result<()> {
            file.write_all(&line[..8])?;
            Err(io::Error::from(io::ErrorKind::StorageFull))
        };
        let write = |line: &[u8]| {
            (&*service_log.sides)
                .write_all(line)
                .expect("the log's writer never fails");
            service_log.sides.flush();
        };

        service_log
            .sides
            .write_file_through(b"the first line\n", write_halfway);
        service_log
            .sides
            .write_file_through(b"the second line\n", refuse);
        write(b"the third line\n");
        let text = std::fs::read_to_string(&live_file).expect("the file reads");
        assert_eq!(text, "the firs\nthe third line\n");
        service_log
            .sides
            .write_file_through(b"the fourth line\n", refuse);
        std::fs::remove_file(&live_file).expect("the file is removed under the log");
        service_log
            .sides
            .write_file_through(b"the fifth line\n", refuse);
        write(b"the sixth line\n");

        assert_eq!(files.live_file(), Some(live_file.clone()));
        let text = std::fs::read_to_string(&live_file).expect("the file is back at its path");
        assert_eq!(text, "\nthe sixth line\n");
        drop((files, service_log));
        let mut told = String::new();
        standard_error
            .read_to_string(&mut told)
            .expect("standard error reads to its end");
        assert_eq!(told.matches(FILE_FAILED_NOTICE).count(), 2, "{told}");
    }

    #[test]
    fn a_gone_standard_error_leaves_every_line_and_one_notice_in_the_file() {
        let data_folder = tempfile::tempdir().expect("a scratch data folder");
        let (reader, writer) = io::pipe().expect("a pipe");
        // With the reader gone, each write to the pipe fails with `BrokenPipe`.
        drop(reader);
        let service_log = open_service_log(data_folder.path(), writer);
        assert!(service_log.open_failure.is_none());

        tracing::dispatcher::with_default(&service_log.dispatch, || {
            tracing::info!(reading = "processor", "the first line");
            tracing::info!(reading = "memory", "the second line");
        });
        service_log.sides.flush();

        let entries = std::fs::read_dir(service_log_folder(data_folder.path()))
            .expect("the logs folder lists")
            .collect::<Result<Vec<_>, _>>()
            .expect("each entry reads");
        assert_eq!(entries.len(), 1);
        let file_name = entries[0].file_name();
        assert!(is_service_log_file_name(
            file_name.to_str().expect("an ASCII file name")
        ));
        let files = ServiceLogFiles {
            sides: service_log.sides,
        };
        assert_eq!(files.live_file(), Some(entries[0].path()));
        let text = std::fs::read_to_string(entries[0].path()).expect("the file reads");
        assert!(text.contains("the first line reading=\"processor\""));
        assert!(text.contains("the second line reading=\"memory\""));
        assert_eq!(text.matches(STANDARD_ERROR_GONE_NOTICE).count(), 1);
    }
}
