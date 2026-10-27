//! The daemon's SQLite shell, the `database shell` mode, which the repair runs in, and SQLite's
//! own recovery, `sqlite3_recover`, run through the shell's `.recover`: one shell reads the damaged
//! file read-only and writes the SQL that rebuilds every row it can reach, and a second shell runs
//! that SQL into a fresh file. The shell is SQLite's own, built into the daemon's program against
//! the library it links, so the two are one release; a shell built without the page table the
//! recovery reads through means a damaged install and is refused before it runs. The recovery's
//! SQL passes through the daemon on its way to the second shell, and the daemon counts the session
//! events in it. A recovery whose shells have both stopped working is stopped (`stall_watch`).
//! Every shell is a child process, so a stop ends it at once.

use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::LazyLock;

use memchr::memmem::Finder;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::Spawner;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::database_file::stall_watch::{
    RECOVERY_STALL_WINDOW, RecoveryStallWatch, ShellProcessorTimeReader, ShellProcessorTimes,
};
use crate::database_file::{ERROR_OUTPUT_KEPT_BYTES, READ_BUSY_TIMEOUT};
use sidekicks_std::helper_mode::child::start_helper_mode_child;
use sidekicks_std::helper_mode::error_output::read_error_output_tail;
use sidekicks_store::database::schema::SESSION_EVENTS_TABLE;

/// The arguments the daemon's own program is started with to run SQLite's shell; the shell's own
/// arguments follow them.
pub const DATABASE_SHELL_MODE: [&str; 2] = ["database", "shell"];

// Answers a row only for a shell built with the page table `.recover` reads through.
const PAGE_TABLE_OPTION_SQL: &str =
    "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_DBPAGE_VTAB'";

// The writing shell turns foreign keys off before it reads the recovery's SQL, since the library is
// built with them on and the recovery writes a child row before a parent it may have lost. A dot
// command, never an SQL `-cmd`: under `-bail` the shell leaves after an SQL `-cmd` even when it
// succeeds, and would read no input. It prints one line, so the writer's success is read from its
// exit and its error output alone.
const RECOVERY_WRITER_FOREIGN_KEYS_OFF: &str = ".dbconfig enable_fkey off";

// What the writing shell runs before the recovery's SQL. The fresh file is scratch until it is
// flushed and marked ready, and a failed repair removes it, so the shell keeps no rollback journal
// and waits for no sync. With defensive mode on, SQLite silently keeps the journal, so the
// preamble turns defensive mode off first, as the recovery's own SQL does.
const RECOVERY_WRITER_PREAMBLE: &str = ".dbconfig defensive off
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
";

// The writing shell's page cache. The recovery keeps its unique indexes, built before the rows so
// that a duplicate row is dropped, and the rows reach the one on a session and its sequence out of
// its order, so once that index outgrows the cache every row writes a page out to make room for
// the one it needs, and the recovery slows many times over. A sixth of the damaged file holds that
// index with room to spare. The cache never falls below 256 MiB, and above that never takes more
// than an eighth of the machine's memory, so on a machine of under 2 GiB it is 256 MiB. The shell
// is a child process, so its memory goes when the repair ends.
const RECOVERY_WRITER_CACHE_FLOOR_BYTES: u64 = 256 * 1024 * 1024;
const RECOVERY_WRITER_CACHE_FILE_SHARE: u64 = 6;
const RECOVERY_WRITER_CACHE_MEMORY_SHARE: u64 = 8;

// How `.recover` starts each row it writes to the event log, the table whose rows the recovery
// counts.
static COUNTED_ROW_START: LazyLock<String> =
    LazyLock::new(|| format!("\nINSERT OR IGNORE INTO '{SESSION_EVENTS_TABLE}'("));

// How many bytes of the recovery's SQL one read passes between the shells.
const PUMP_BUFFER_BYTES: usize = 64 * 1024;

// What each shell run is doing, as a failure names it.
const CHECKING_STEP: &str = "checking its page table";
const READING_STEP: &str = "reading the damaged file";
const WRITING_STEP: &str = "writing the fresh file";
const COUNTING_STEP: &str = "counting the damaged file's session events";

/// Why one run of the SQLite shell failed.
#[derive(Debug, thiserror::Error)]
pub enum SqliteShellRunError {
    /// The shell's process could not start.
    #[error("the SQLite shell could not start {step}")]
    Start {
        /// What the shell was started to do.
        step: &'static str,
        /// The start's failure.
        #[source]
        source: io::Error,
    },
    /// Writing the shell's input, reading its output or waiting for it failed.
    #[error("the SQLite shell's input or output failed {step}")]
    Pipe {
        /// What the shell was doing.
        step: &'static str,
        /// The pipe's or the wait's failure.
        #[source]
        source: io::Error,
    },
    /// A stop, or the other shell's failure, ended the shell.
    #[error("the SQLite shell was ended {step}: {error_output}")]
    Ended {
        /// What the shell was doing.
        step: &'static str,
        /// The end of its error output.
        error_output: String,
    },
    /// The shell exited with a failure.
    #[error("the SQLite shell failed {step} ({status}): {error_output}")]
    Failed {
        /// What the shell was doing.
        step: &'static str,
        /// How it ended.
        status: ExitStatus,
        /// The end of its error output.
        error_output: String,
    },
}

/// Why the daemon's SQLite shell is refused: each case means a damaged install.
#[derive(Debug, thiserror::Error)]
pub enum UnfitSqliteShell {
    /// The shell could not be run.
    #[error("the daemon's SQLite shell could not be run, so its install is damaged")]
    Unrunnable(#[source] SqliteShellRunError),
    /// The shell is built without the page table its recovery reads through.
    #[error(
        "the daemon's SQLite shell is built without the page table its recovery reads through \
         (SQLITE_ENABLE_DBPAGE_VTAB), so its install is damaged"
    )]
    NoPageTable,
}

/// Why a recovery into a fresh file failed.
#[derive(Debug, thiserror::Error)]
pub enum SqliteRecoveryError {
    /// The shell is refused before it runs.
    #[error(transparent)]
    Unfit(UnfitSqliteShell),
    /// The damaged file's size could not be read.
    #[error("the damaged file's size could not be read")]
    DamagedFileSize(#[source] io::Error),
    /// A shell failed.
    #[error(transparent)]
    Shell(SqliteShellRunError),
    /// The recovery's SQL could not be passed from one shell to the other.
    #[error("the recovery's SQL could not be passed between the SQLite shells")]
    Pipe(#[source] io::Error),
    /// Both shells stopped working, so both were ended; the first shell's end rides beside it.
    #[error(
        "the SQLite shells' recovery passed no byte for {} seconds and then used no processor \
         time for as long again, so it was stopped",
        RECOVERY_STALL_WINDOW.as_secs()
    )]
    Stalled(#[source] Option<SqliteShellRunError>),
    /// A stop ended the recovery once both shells had exited.
    #[error("the recovery was stopped")]
    Stopped,
}

/// Why the damaged file's session events could not be counted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DamagedFileCountError {
    /// The shell failed, as a damaged index makes it.
    #[error(transparent)]
    Shell(#[from] SqliteShellRunError),
    /// The shell answered something other than a count.
    #[error("the SQLite shell answered the count of session events with {0}")]
    Answer(String),
}

/// How a script runs in the shell: what it is for, its output's form and the folder it runs in.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SqliteShellScript<'a> {
    /// What the script does, as the failure's message names it: `checking the fresh file`.
    pub(crate) step: &'static str,
    /// Opens the file read-only.
    pub(crate) is_read_only: bool,
    /// Writes every row as JSON rather than SQLite's list form.
    pub(crate) is_json: bool,
    /// The shell's working folder, which a relative file name the script attaches is read
    /// against; the daemon's own when `None`.
    pub(crate) working_folder: Option<&'a Path>,
}

// Why the pump between the shells ended early.
enum PumpFailure {
    Pipe(io::Error),
    Stalled,
}

/// The daemon's own program run as SQLite's shell, each shell started on one spawner.
pub struct SqliteShell {
    program: PathBuf,
    spawner: Spawner,
}

impl SqliteShell {
    /// A shell run as `program`, the daemon's own, in the `database shell` mode, started on
    /// `spawner`'s thread. `program` is absolute, so a script run in another working folder still
    /// finds it.
    pub fn new(program: PathBuf, spawner: Spawner) -> Self {
        Self { program, spawner }
    }

    /// Checks that the shell runs and has the page table its recovery reads through. Fails with
    /// [`UnfitSqliteShell`] naming which.
    pub(crate) async fn refuse_unfit(
        &self,
        stop: &CancellationToken,
    ) -> Result<(), UnfitSqliteShell> {
        let page_table = self
            .run(
                CHECKING_STEP,
                [OsStr::new(":memory:"), OsStr::new(PAGE_TABLE_OPTION_SQL)],
                None,
                None,
                stop,
            )
            .await
            .map_err(UnfitSqliteShell::Unrunnable)?;
        if String::from_utf8_lossy(&page_table).trim().is_empty() {
            return Err(UnfitSqliteShell::NoPageTable);
        }
        Ok(())
    }

    /// Recovers what `damaged_path` holds into `fresh_path`, which must not exist, sending on
    /// `recovered_events` how many session events have passed so far; the writer's cache is sized
    /// from the file and `machine_memory`, the machine's installed memory in bytes. Fails when the
    /// shell is unfit, when either shell cannot start or exits with a failure, naming its error
    /// output, when both stop working, and with [`SqliteRecoveryError::Stopped`] once `stop`
    /// fires; it answers only once both shells have exited, so nothing still writes the fresh file.
    pub async fn recover_into_fresh_file(
        &self,
        damaged_path: &Path,
        fresh_path: &Path,
        machine_memory: u64,
        recovered_events: &watch::Sender<u64>,
        stop: &CancellationToken,
    ) -> Result<(), SqliteRecoveryError> {
        if let Err(unfit) = self.refuse_unfit(stop).await {
            return Err(if stop.is_cancelled() {
                SqliteRecoveryError::Stopped
            } else {
                SqliteRecoveryError::Unfit(unfit)
            });
        }
        let damaged_bytes = tokio::fs::metadata(damaged_path)
            .await
            .map_err(SqliteRecoveryError::DamagedFileSize)?
            .len();
        let cache_kib = writer_cache_bytes(damaged_bytes, machine_memory) / 1024;
        let mut reader_command = self.command([
            OsStr::new("-readonly"),
            damaged_path.as_os_str(),
            OsStr::new(".recover"),
        ]);
        reader_command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut writer_command = self.command([
            OsStr::new("-bail"),
            OsStr::new("-cmd"),
            OsStr::new(RECOVERY_WRITER_FOREIGN_KEYS_OFF),
            fresh_path.as_os_str(),
        ]);
        writer_command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut reader = self
            .start(reader_command, READING_STEP)
            .await
            .map_err(SqliteRecoveryError::Shell)?;
        let mut writer = match self.start(writer_command, WRITING_STEP).await {
            Ok(writer) => writer,
            Err(failure) => {
                end_shell(&mut reader).await;
                return Err(SqliteRecoveryError::Shell(failure));
            }
        };
        let reader_output = reader.stdout.take().expect("the reader's output is piped");
        let reader_errors = reader.stderr.take().expect("the reader's errors are piped");
        let mut writer_input = writer.stdin.take().expect("the writer's input is piped");
        let writer_errors = writer.stderr.take().expect("the writer's errors are piped");
        let shell_pids: Vec<u32> = [reader.id(), writer.id()].into_iter().flatten().collect();
        let processor_times = ShellProcessorTimeReader::new();
        let mut stall_watch = RecoveryStallWatch::new(RECOVERY_STALL_WINDOW, || {
            processor_times.read(shell_pids.clone())
        });
        // Fires on a stop, and on any failure, so the other shell is ended too.
        let ended = stop.child_token();
        let pumping = async {
            let preamble = format!("{RECOVERY_WRITER_PREAMBLE}PRAGMA cache_size = -{cache_kib};\n");
            let pumped = match writer_input.write_all(preamble.as_bytes()).await {
                Ok(()) => {
                    pump_recovery(
                        reader_output,
                        writer_input,
                        &mut stall_watch,
                        recovered_events,
                        &ended,
                    )
                    .await
                }
                Err(failure) => Err(PumpFailure::Pipe(failure)),
            };
            if pumped.is_err() {
                ended.cancel();
            }
            pumped
        };
        let reading = async {
            let finished = finish_shell(&mut reader, reader_errors, READING_STEP, &ended).await;
            if finished.is_err() {
                ended.cancel();
            }
            finished
        };
        let writing = async {
            let finished = finish_shell(&mut writer, writer_errors, WRITING_STEP, &ended).await;
            if finished.is_err() {
                ended.cancel();
            }
            finished
        };
        let (pumped, read, written) = tokio::join!(pumping, reading, writing);
        if stop.is_cancelled() {
            return Err(SqliteRecoveryError::Stopped);
        }
        fold_recovery(pumped, read, written)
    }

    /// How many session events the damaged file at `path` lists, read through the shell so a large
    /// file holds no thread of the daemon's; the shell waits out the recovery's reader's locks.
    /// Fails when the shell cannot read the count, as a damaged index makes it, and once `stop`
    /// fires, which ends the shell.
    pub(crate) async fn count_damaged_file_events(
        &self,
        path: &Path,
        stop: &CancellationToken,
    ) -> Result<SafeInt<0>, DamagedFileCountError> {
        let timeout = format!(".timeout {}", READ_BUSY_TIMEOUT.as_millis());
        let count_sql = format!("SELECT count(*) FROM {SESSION_EVENTS_TABLE}");
        let output = self
            .run(
                COUNTING_STEP,
                [
                    OsStr::new("-readonly"),
                    OsStr::new("-cmd"),
                    OsStr::new(&timeout),
                    path.as_os_str(),
                    OsStr::new(&count_sql),
                ],
                None,
                None,
                stop,
            )
            .await?;
        let answer = String::from_utf8_lossy(&output);
        let answer = answer.trim();
        answer
            .parse()
            .ok()
            .and_then(SafeInt::new)
            .ok_or_else(|| DamagedFileCountError::Answer(answer.to_owned()))
    }

    /// Runs `script` in the shell on the database at `database_path`, stopping at its first error,
    /// and answers what it wrote, whole, once it has exited, so a script's output must stay small.
    /// Fails naming the script's step and the shell's error output when the shell cannot start or
    /// fails, and once `stop` fires, when the shell has exited.
    pub(crate) async fn run_script(
        &self,
        database_path: &Path,
        script: &str,
        options: SqliteShellScript<'_>,
        stop: &CancellationToken,
    ) -> Result<String, SqliteShellRunError> {
        let mut arguments = vec![OsStr::new("-bail")];
        if options.is_read_only {
            arguments.push(OsStr::new("-readonly"));
        }
        if options.is_json {
            arguments.push(OsStr::new("-json"));
        }
        arguments.push(database_path.as_os_str());
        let output = self
            .run(
                options.step,
                arguments,
                Some(script.as_bytes()),
                options.working_folder,
                stop,
            )
            .await?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    // The shell's command with `arguments`.
    fn command<'a>(&self, arguments: impl IntoIterator<Item = &'a OsStr>) -> Command {
        let mut command = Command::new(&self.program);
        command.args(DATABASE_SHELL_MODE).args(arguments);
        command
    }

    // Starts `command` on the spawner's thread, armed to end with the daemon and ended if dropped.
    async fn start(
        &self,
        command: Command,
        step: &'static str,
    ) -> Result<Child, SqliteShellRunError> {
        start_helper_mode_child(&self.spawner, command)
            .await
            .map_err(|source| SqliteShellRunError::Start { step, source })
    }

    // Runs the shell with `arguments` in `working_folder`, the daemon's own when `None`, writing
    // `input` to it, and answers its whole output once it has exited.
    async fn run<'a>(
        &self,
        step: &'static str,
        arguments: impl IntoIterator<Item = &'a OsStr>,
        input: Option<&[u8]>,
        working_folder: Option<&Path>,
        stop: &CancellationToken,
    ) -> Result<Vec<u8>, SqliteShellRunError> {
        let mut command = self.command(arguments);
        if let Some(working_folder) = working_folder {
            command.current_dir(working_folder);
        }
        command
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut shell = self.start(command, step).await?;
        let shell_input = shell.stdin.take();
        let mut shell_output = shell.stdout.take().expect("the shell's output is piped");
        let shell_errors = shell.stderr.take().expect("the shell's errors are piped");
        let writing = async {
            if let (Some(mut shell_input), Some(input)) = (shell_input, input) {
                shell_input.write_all(input).await?;
            }
            Ok::<_, io::Error>(())
        };
        let reading = async {
            let mut output = Vec::new();
            shell_output.read_to_end(&mut output).await.map(|_| output)
        };
        let (written, output, finished) = tokio::join!(
            writing,
            reading,
            finish_shell(&mut shell, shell_errors, step, stop)
        );
        finished?;
        written.map_err(|source| SqliteShellRunError::Pipe { step, source })?;
        output.map_err(|source| SqliteShellRunError::Pipe { step, source })
    }
}

/// `text` as an SQL string literal.
pub(crate) fn quote_sql_text(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// `name` as an SQL identifier.
pub(crate) fn quote_sql_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The writing shell's page cache in bytes for a damaged file of `file_bytes` on a machine of
/// `machine_memory` bytes: a sixth of the file, never under 256 MiB, and past that never over an
/// eighth of the machine's memory.
pub(crate) fn writer_cache_bytes(file_bytes: u64, machine_memory: u64) -> u64 {
    let file_share =
        (file_bytes / RECOVERY_WRITER_CACHE_FILE_SHARE).max(RECOVERY_WRITER_CACHE_FLOOR_BYTES);
    let memory_share = (machine_memory / RECOVERY_WRITER_CACHE_MEMORY_SHARE)
        .max(RECOVERY_WRITER_CACHE_FLOOR_BYTES);
    file_share.min(memory_share)
}

// Passes the recovery's SQL from `reader` to `writer`, counting the session events in it onto
// `recovered_events`, until the reader's end, when the writer's input is flushed and closed so the
// writing shell ends; or until `ended` fires; or until the stall watch reads the shells as
// stalled. A row's start can straddle two reads, so each search begins in the last read's tail,
// one byte shorter than a row's start, so no row is counted twice.
async fn pump_recovery<Reader, Writer, Read, Reading, ReadError>(
    mut reader: Reader,
    mut writer: Writer,
    stall_watch: &mut RecoveryStallWatch<Read>,
    recovered_events: &watch::Sender<u64>,
    ended: &CancellationToken,
) -> Result<(), PumpFailure>
where
    Reader: AsyncRead + Unpin,
    Writer: AsyncWrite + Unpin,
    Read: FnMut() -> Reading,
    Reading: Future<Output = Result<Option<ShellProcessorTimes>, ReadError>>,
    ReadError: Error + 'static,
{
    let finder = Finder::new(COUNTED_ROW_START.as_bytes());
    let tail_bytes = COUNTED_ROW_START.len() - 1;
    let mut buffer = vec![0_u8; tail_bytes + PUMP_BUFFER_BYTES];
    let mut tail_length = 0;
    let mut recovered = 0_u64;
    loop {
        let read = tokio::select! {
            () = ended.cancelled() => return Ok(()),
            () = stall_watch.stalled() => return Err(PumpFailure::Stalled),
            read = reader.read(&mut buffer[tail_length..]) => read.map_err(PumpFailure::Pipe)?,
        };
        if read == 0 {
            break;
        }
        stall_watch.note_passed_bytes();
        let searched_length = tail_length + read;
        let found = finder.find_iter(&buffer[..searched_length]).count();
        if found > 0 {
            recovered += u64::try_from(found).expect("a count of rows fits in a u64");
            recovered_events.send_replace(recovered);
        }
        tokio::select! {
            () = ended.cancelled() => return Ok(()),
            () = stall_watch.stalled() => return Err(PumpFailure::Stalled),
            written = writer.write_all(&buffer[tail_length..searched_length]) => {
                written.map_err(PumpFailure::Pipe)?;
            }
        }
        let next_tail_length = searched_length.min(tail_bytes);
        buffer.copy_within(searched_length - next_tail_length..searched_length, 0);
        tail_length = next_tail_length;
    }
    writer.shutdown().await.map_err(PumpFailure::Pipe)?;
    drop(writer);
    Ok(())
}

// Waits for `shell` to exit, keeping its error output's tail; once `ended` fires first, kills it
// and waits for it. Fails with what ended it or its failure.
async fn finish_shell(
    shell: &mut Child,
    errors: ChildStderr,
    step: &'static str,
    ended: &CancellationToken,
) -> Result<(), SqliteShellRunError> {
    let waiting = async {
        tokio::select! {
            biased;
            status = shell.wait() => (status, false),
            () = ended.cancelled() => {
                let killed = shell.start_kill();
                (match killed {
                    Ok(()) => shell.wait().await,
                    Err(failure) => Err(failure),
                }, true)
            }
        }
    };
    let ((status, is_ended), tail) = tokio::join!(
        waiting,
        read_error_output_tail(errors, ERROR_OUTPUT_KEPT_BYTES)
    );
    let status = status.map_err(|source| SqliteShellRunError::Pipe { step, source })?;
    let error_output = tail.map_err(|source| SqliteShellRunError::Pipe { step, source })?;
    if status.success() {
        Ok(())
    } else if is_ended {
        Err(SqliteShellRunError::Ended { step, error_output })
    } else {
        Err(SqliteShellRunError::Failed {
            step,
            status,
            error_output,
        })
    }
}

// Kills a shell that started alone, its partner having failed to start, and waits for it; a
// failure to end it is logged, since the start's failure is the one the caller hears.
async fn end_shell(shell: &mut Child) {
    let ended = match shell.start_kill() {
        Ok(()) => shell.wait().await.map(drop),
        Err(failure) => Err(failure),
    };
    if let Err(error) = ended {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the SQLite shell reading the damaged file could not be ended"
        );
    }
}

// The recovery's outcome from the pump and both shells: a shell's own failure before the pump's,
// the writer's before the reader's, and a shell that was only ended last; a stall carries the
// first shell's end.
fn fold_recovery(
    pumped: Result<(), PumpFailure>,
    read: Result<(), SqliteShellRunError>,
    written: Result<(), SqliteShellRunError>,
) -> Result<(), SqliteRecoveryError> {
    let is_own_failure = |outcome: &Result<(), SqliteShellRunError>| {
        outcome
            .as_ref()
            .is_err_and(|failure| !matches!(failure, SqliteShellRunError::Ended { .. }))
    };
    let shell_failure = if is_own_failure(&written) {
        written.err()
    } else if is_own_failure(&read) {
        read.err()
    } else {
        written.err().or(read.err())
    };
    match pumped {
        Err(PumpFailure::Stalled) => Err(SqliteRecoveryError::Stalled(shell_failure)),
        Err(PumpFailure::Pipe(failure)) => match shell_failure {
            Some(
                shell_failure @ (SqliteShellRunError::Start { .. }
                | SqliteShellRunError::Pipe { .. }
                | SqliteShellRunError::Failed { .. }),
            ) => Err(SqliteRecoveryError::Shell(shell_failure)),
            Some(SqliteShellRunError::Ended { .. }) | None => {
                Err(SqliteRecoveryError::Pipe(failure))
            }
        },
        Ok(()) => shell_failure.map_or(Ok(()), |failure| Err(SqliteRecoveryError::Shell(failure))),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::ready;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use rstest::rstest;
    use tokio::io::{AsyncRead, AsyncReadExt, ReadBuf};
    use tokio::sync::watch;
    use tokio_util::sync::CancellationToken;

    use super::{
        COUNTED_ROW_START, pump_recovery, quote_sql_identifier, quote_sql_text, writer_cache_bytes,
    };
    use crate::database_file::stall_watch::RecoveryStallWatch;

    const MIB: u64 = 1024 * 1024;

    // A reader that answers each chunk in its own read.
    struct Chunks(VecDeque<Vec<u8>>);

    impl AsyncRead for Chunks {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(chunk) = self.0.pop_front() {
                buffer.put_slice(&chunk);
            }
            Poll::Ready(Ok(()))
        }
    }

    // The recovery's SQL with three counted rows, one row of another table, and the second counted
    // row's start split across two reads at every offset.
    #[rstest]
    #[tokio::test]
    async fn counts_each_row_once_wherever_a_read_splits_it_and_ends_the_writer_s_input(
        #[values(1, 7, 20, 38, 39, 40, 41)] split_offset: usize,
    ) {
        let row_start = COUNTED_ROW_START.as_str();
        let first = format!("BEGIN;{row_start}1);\nINSERT OR IGNORE INTO 'other'(2);");
        let second = format!("{row_start}3);{row_start}4);\nCOMMIT;\n");
        let chunks = VecDeque::from([
            first.as_bytes().to_vec(),
            second.as_bytes()[..split_offset].to_vec(),
            second.as_bytes()[split_offset..].to_vec(),
        ]);
        let (writer, mut written_side) = tokio::io::duplex(1024);
        let mut stall_watch = RecoveryStallWatch::new(Duration::from_secs(3600), || {
            ready(Ok::<_, io::Error>(None))
        });
        let (recovered_events, recovered) = watch::channel(0);
        let ended = CancellationToken::new();

        let pumping = pump_recovery(
            Chunks(chunks),
            writer,
            &mut stall_watch,
            &recovered_events,
            &ended,
        );
        let mut passed = Vec::new();
        // Bounded, so a writer's input left open fails the test rather than hanging it.
        let (pumped, read_to_end) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(pumping, written_side.read_to_end(&mut passed))
        })
        .await
        .expect("the pump ends and the writer's side reaches its end");

        assert!(pumped.is_ok());
        read_to_end.expect("the writer's side reads to its end");
        assert_eq!(passed, format!("{first}{second}").into_bytes());
        assert_eq!(*recovered.borrow(), 3);
    }

    #[rstest]
    #[case::small_file_on_a_small_machine(10 * MIB, 1024 * MIB, 256 * MIB)]
    #[case::large_file_capped_by_the_machine(6 * 1024 * MIB, 4 * 1024 * MIB, 512 * MIB)]
    #[case::large_file_under_the_machine_s_share(1536 * MIB, 16 * 1024 * MIB, 256 * MIB)]
    #[case::the_file_s_share(3 * 1024 * MIB, 16 * 1024 * MIB, 512 * MIB)]
    fn sizes_the_writer_s_cache_between_its_floor_and_the_machine_s_share(
        #[case] file_bytes: u64,
        #[case] machine_memory: u64,
        #[case] expected: u64,
    ) {
        assert_eq!(writer_cache_bytes(file_bytes, machine_memory), expected);
    }

    #[rstest]
    #[case::plain("damaged", "'damaged'", "\"damaged\"")]
    #[case::a_quote_in_a_path(
        "/Users/o'neil/daemon.db",
        "'/Users/o''neil/daemon.db'",
        "\"/Users/o'neil/daemon.db\""
    )]
    #[case::a_double_quote_in_a_name(
        "lost \"table\"",
        "'lost \"table\"'",
        "\"lost \"\"table\"\"\""
    )]
    fn quotes_text_and_names_so_a_quote_inside_stays_inside(
        #[case] raw: &str,
        #[case] text: &str,
        #[case] identifier: &str,
    ) {
        assert_eq!(quote_sql_text(raw), text);
        assert_eq!(quote_sql_identifier(raw), identifier);
    }
}
