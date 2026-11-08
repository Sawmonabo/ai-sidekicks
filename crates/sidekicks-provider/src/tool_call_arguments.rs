//! The arguments of the tool calls that await their results, kept for the calls' traces: in memory
//! up to a bound on their count and their bytes, and past it the oldest written to one private file
//! per process in the data folder and read back when the result arrives. A call's arguments go
//! when the call settles, the file once it keeps none, and a file a stopped daemon left goes at
//! the next start. The file is opened once, when a write makes it; each write, with its
//! bookkeeping, runs in a task of its own, each read takes its range by offset, and each removal
//! runs on a blocking thread, none of them under a caller's lock or the store's own.

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fs::File;
use std::io::{self, ErrorKind, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{
    create_new_file, create_private_folder, read_exact_at, remove_tree, remove_tree_awaited,
};
use sidekicks_std::failure_episode::FailureEpisode;
use sidekicks_std::mutex_lock::lock;
use tokio::runtime::Handle;
use tokio::task::JoinError;

// The folder in the data folder that holds each process's file of arguments past the bounds.
const TOOL_CALL_ARGUMENTS_FOLDER_NAME: &str = "tool-call-arguments";

// A file of arguments is readable by the person alone.
const TOOL_CALL_ARGUMENTS_FILE_MODE: u32 = 0o600;

/// How many calls' arguments, and how many of their bytes, one process keeps in memory.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ToolCallArgumentBounds {
    /// The most calls.
    pub(crate) calls: usize,
    /// The most bytes.
    pub(crate) bytes: usize,
}

/// The bounds every process keeps its calls' arguments in memory within: 256 calls and 16 MiB.
pub(crate) const TOOL_CALL_ARGUMENT_BOUNDS: ToolCallArgumentBounds = ToolCallArgumentBounds {
    calls: 256,
    bytes: 16 * 1024 * 1024,
};

/// Removes every file of arguments a previous run left in `data_folder`, at the daemon's start,
/// before any process runs. Fails with the system's error when the folder cannot be removed.
pub async fn remove_left_tool_call_arguments(data_folder: &Path) -> io::Result<()> {
    remove_tree_awaited(&tool_call_arguments_folder(data_folder)).await
}

/// The folder in `data_folder` that holds each process's file of arguments past the bounds.
pub(crate) fn tool_call_arguments_folder(data_folder: &Path) -> PathBuf {
    data_folder.join(TOOL_CALL_ARGUMENTS_FOLDER_NAME)
}

/// One process's kept arguments; a clone is another handle on the same store.
#[derive(Clone)]
pub(crate) struct ToolCallArgumentStore {
    shelf: Arc<Mutex<ArgumentShelf>>,
}

/// One call's kept arguments, in memory or on disk; dropped, they are forgotten.
pub(crate) struct KeptToolCallArguments {
    key: u64,
    shelf: Arc<Mutex<ArgumentShelf>>,
}

// Where one call's arguments sit in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DiskRange {
    offset: u64,
    length: usize,
}

// Each argument's place in a file, by its key.
type ArgumentPlaces = Vec<(u64, DiskRange)>;

// A file of arguments, with the handle writes append through and the handle reads take ranges
// from, both opened once, when the file is made.
#[derive(Clone)]
struct ArgumentFile {
    path: PathBuf,
    writer: Arc<File>,
    reader: Arc<File>,
}

// The file one process's arguments past the bounds sit in, and where each sits.
struct ArgumentDisk {
    file: ArgumentFile,
    ranges: HashMap<u64, DiskRange>,
    // The bytes of the arguments still awaited.
    live_bytes: u64,
    // The bytes the file holds, its forgotten arguments' included.
    length: u64,
}

// What one process keeps. Keys rise with each call kept, so the lowest in memory is the oldest.
struct ArgumentShelf {
    session_id: SessionId,
    folder: PathBuf,
    // The runtime a handle dropped outside a task hands its file's removal to.
    runtime: Handle,
    bounds: ToolCallArgumentBounds,
    next_key: u64,
    in_memory: BTreeMap<u64, Box<RawValue>>,
    in_memory_bytes: usize,
    // The arguments a write under way is taking to the file.
    writing: HashSet<u64>,
    disk: Option<ArgumentDisk>,
    // Whether a write is under way, so no second one starts and the file stays.
    is_writing: bool,
    // Whether a write failed since the last that succeeded, so a full disk warns once.
    write_failure_episode: FailureEpisode,
}

// Where one write puts its arguments.
enum ArgumentTarget {
    // A process's first file, made by the write.
    Make,
    // The end of `file`, at `start`.
    Append {
        file: ArgumentFile,
        start: u64,
    },
    // A fresh file the write makes, holding `live`'s arguments copied from `file` before the
    // batch, which then replaces `file`; made where forgotten bytes outgrew the live ones.
    Compact {
        file: ArgumentFile,
        live: ArgumentPlaces,
    },
}

// One write to the file: the oldest arguments past the bounds.
struct ArgumentWrite {
    folder: PathBuf,
    target: ArgumentTarget,
    batch: Vec<(u64, Box<RawValue>)>,
}

// What a write did: each argument's place in the file it wrote, a compacted one's new place
// included, and that file's length; or why it failed, with the arguments it could not take.
enum ArgumentWriteOutcome {
    Written {
        file: ArgumentFile,
        ranges: ArgumentPlaces,
        length: u64,
    },
    Failed {
        error: io::Error,
        batch: Vec<(u64, Box<RawValue>)>,
    },
}

// A file that keeps no arguments, taken off the store to be removed once its lock is let go.
struct UnusedArgumentFile {
    session_id: SessionId,
    runtime: Handle,
    file: ArgumentFile,
}

impl ToolCallArgumentStore {
    /// The store of a process of `session_id`, whose file goes under a name of its own in the
    /// data folder `data_folder`, made only once arguments pass the bounds. Panics outside a Tokio
    /// runtime, whose blocking threads remove the file.
    pub(crate) fn new(data_folder: &Path, session_id: SessionId) -> Self {
        Self::with_bounds(data_folder, session_id, TOOL_CALL_ARGUMENT_BOUNDS)
    }

    // The store keeping arguments in memory within `bounds`.
    fn with_bounds(
        data_folder: &Path,
        session_id: SessionId,
        bounds: ToolCallArgumentBounds,
    ) -> Self {
        Self {
            shelf: Arc::new(Mutex::new(ArgumentShelf {
                session_id,
                folder: tool_call_arguments_folder(data_folder),
                runtime: Handle::current(),
                bounds,
                next_key: 0,
                in_memory: BTreeMap::new(),
                in_memory_bytes: 0,
                writing: HashSet::new(),
                disk: None,
                is_writing: false,
                write_failure_episode: FailureEpisode::default(),
            })),
        }
    }

    /// Keeps a call's `arguments` in memory, until [`Self::spill_past_bounds`] writes the oldest
    /// past the bounds to the file.
    pub(crate) fn keep(&self, arguments: Box<RawValue>) -> KeptToolCallArguments {
        let mut shelf = lock(&self.shelf);
        let key = shelf.next_key;
        shelf.next_key += 1;
        shelf.in_memory_bytes += arguments.get().len();
        shelf.in_memory.insert(key, arguments);
        KeptToolCallArguments {
            key,
            shelf: Arc::clone(&self.shelf),
        }
    }

    /// Writes the oldest arguments in memory past the bounds to the process's file, on a blocking
    /// thread, logged at debug; what a failed write could not take stays in memory, logged. The
    /// write and its bookkeeping run in a task of their own, so a canceled caller strands neither.
    pub(crate) async fn spill_past_bounds(&self) {
        let Some(write) = lock(&self.shelf).take_write() else {
            return;
        };
        let shelf = Arc::clone(&self.shelf);
        let spill = tokio::spawn(async move {
            let keys: Vec<u64> = write.batch.iter().map(|(key, _)| *key).collect();
            let outcome = tokio::task::spawn_blocking(move || write.run()).await;
            let unused = lock(&shelf).finish_write(&keys, outcome);
            if let Some(unused) = unused {
                unused.remove().await;
            }
        });
        if let Err(error) = spill.await
            && let Ok(panic) = error.try_into_panic()
        {
            std::panic::resume_unwind(panic);
        }
    }

    /// The bytes of the arguments kept in memory.
    #[cfg(test)]
    pub(crate) fn in_memory_bytes(&self) -> usize {
        lock(&self.shelf).in_memory_bytes
    }
}

impl KeptToolCallArguments {
    /// The arguments, word for word, read back from the file on a blocking thread where they were
    /// written there. Fails with the system's error from the file, or `NotFound` for arguments a
    /// write lost to a panic.
    pub(crate) async fn read(self) -> io::Result<Box<RawValue>> {
        let (reader, range) = {
            let mut shelf = lock(&self.shelf);
            if let Some(arguments) = shelf.in_memory.remove(&self.key) {
                shelf.in_memory_bytes -= arguments.get().len();
                return Ok(arguments);
            }
            let Some(on_disk) = shelf.disk.as_mut().and_then(|disk| {
                let range = disk.ranges.remove(&self.key)?;
                disk.live_bytes -= range.length as u64;
                Some((Arc::clone(&disk.file.reader), range))
            }) else {
                return Err(io::Error::new(
                    ErrorKind::NotFound,
                    "the arguments were lost to a failed write",
                ));
            };
            on_disk
        };
        // The handle read is the one the range was written to, so a compaction meanwhile, which
        // makes a fresh file, leaves this read on the bytes it names.
        let read = tokio::task::spawn_blocking(move || read_range(&reader, range))
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
        let unused = lock(&self.shelf).remove_file_if_unused();
        if let Some(unused) = unused {
            unused.remove().await;
        }
        let text = String::from_utf8(read?)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
        RawValue::from_string(text).map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
    }
}

impl Drop for KeptToolCallArguments {
    fn drop(&mut self) {
        let unused = lock(&self.shelf).forget(self.key);
        if let Some(unused) = unused {
            unused.runtime.clone().spawn(unused.remove());
        }
    }
}

impl ArgumentShelf {
    // Takes the oldest arguments in memory past the bounds out for a write, which compacts the
    // file where its forgotten bytes outgrew its live ones and the bounds; none while a write is
    // under way or nothing is past the bounds.
    fn take_write(&mut self) -> Option<ArgumentWrite> {
        if self.is_writing {
            return None;
        }
        let mut batch = Vec::new();
        while (self.in_memory.len() > self.bounds.calls || self.in_memory_bytes > self.bounds.bytes)
            && let Some((key, arguments)) = self.in_memory.pop_first()
        {
            self.in_memory_bytes -= arguments.get().len();
            self.writing.insert(key);
            batch.push((key, arguments));
        }
        if batch.is_empty() {
            return None;
        }
        let target = match &self.disk {
            None => ArgumentTarget::Make,
            Some(disk)
                if disk.length - disk.live_bytes > disk.live_bytes + self.bounds.bytes as u64 =>
            {
                let mut live: ArgumentPlaces = disk
                    .ranges
                    .iter()
                    .map(|(key, range)| (*key, *range))
                    .collect();
                live.sort_by_key(|(_, range)| range.offset);
                ArgumentTarget::Compact {
                    file: disk.file.clone(),
                    live,
                }
            }
            Some(disk) => ArgumentTarget::Append {
                file: disk.file.clone(),
                start: disk.length,
            },
        };
        self.is_writing = true;
        Some(ArgumentWrite {
            folder: self.folder.clone(),
            target,
            batch,
        })
    }

    // Takes a write's outcome: each argument written is on disk unless forgotten meanwhile, each
    // compacted one moves, and a failed write's arguments go back in memory; arguments a write
    // lost to a panic are gone. Answers the file where it now keeps none.
    fn finish_write(
        &mut self,
        keys: &[u64],
        outcome: Result<ArgumentWriteOutcome, JoinError>,
    ) -> Option<UnusedArgumentFile> {
        self.is_writing = false;
        match outcome {
            Ok(ArgumentWriteOutcome::Written {
                file,
                ranges,
                length,
            }) => {
                self.write_failure_episode.mark_succeeded();
                let disk = self.disk.get_or_insert_with(|| ArgumentDisk {
                    file: file.clone(),
                    ranges: HashMap::new(),
                    live_bytes: 0,
                    length: 0,
                });
                // A compaction's fresh file replaces the one it copied.
                disk.file = file;
                disk.length = length;
                let mut written_calls = 0;
                let mut written_bytes = 0;
                for (key, range) in ranges {
                    if self.writing.remove(&key) {
                        disk.ranges.insert(key, range);
                        disk.live_bytes += range.length as u64;
                        written_calls += 1;
                        written_bytes += range.length;
                    } else if let Some(moved) = disk.ranges.get_mut(&key) {
                        *moved = range;
                    }
                }
                tracing::debug!(
                    session_id = %self.session_id,
                    calls = written_calls,
                    bytes = written_bytes,
                    "tool call arguments past the memory bound were written to disk until their \
                     results"
                );
            }
            Ok(ArgumentWriteOutcome::Failed { error, batch }) => {
                let error = &error as &(dyn Error + 'static);
                if self.write_failure_episode.is_first_failure() {
                    tracing::warn!(
                        session_id = %self.session_id,
                        error,
                        "tool call arguments past the memory bound could not be written to disk, \
                         so they stay in memory until a write succeeds"
                    );
                } else {
                    tracing::debug!(
                        session_id = %self.session_id,
                        error,
                        "tool call arguments past the memory bound still could not be written to \
                         disk, so they stay in memory until a write succeeds"
                    );
                }
                for (key, arguments) in batch {
                    if self.writing.remove(&key) {
                        self.in_memory_bytes += arguments.get().len();
                        self.in_memory.insert(key, arguments);
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    session_id = %self.session_id,
                    error = &error as &(dyn Error + 'static),
                    "the write of tool call arguments past the memory bound panicked, so their \
                     calls are not traced"
                );
                for key in keys {
                    self.writing.remove(key);
                }
            }
        }
        self.remove_file_if_unused()
    }

    // Forgets the arguments under `key`, wherever they are; answers the file where it now keeps
    // none.
    fn forget(&mut self, key: u64) -> Option<UnusedArgumentFile> {
        if let Some(arguments) = self.in_memory.remove(&key) {
            self.in_memory_bytes -= arguments.get().len();
        } else if !self.writing.remove(&key)
            && let Some(disk) = &mut self.disk
            && let Some(range) = disk.ranges.remove(&key)
        {
            disk.live_bytes -= range.length as u64;
        }
        self.remove_file_if_unused()
    }

    // Takes the file off the store once it keeps no arguments and no write is under way, for
    // its removal once the lock is let go.
    fn remove_file_if_unused(&mut self) -> Option<UnusedArgumentFile> {
        if self.is_writing
            || self
                .disk
                .as_ref()
                .is_some_and(|disk| !disk.ranges.is_empty())
        {
            return None;
        }
        let disk = self.disk.take()?;
        Some(UnusedArgumentFile {
            session_id: self.session_id,
            runtime: self.runtime.clone(),
            file: disk.file,
        })
    }
}

impl UnusedArgumentFile {
    // Closes and removes the file on a blocking thread; a failed removal is logged, and the next
    // start's sweep removes it.
    async fn remove(self) {
        let ArgumentFile {
            path,
            writer,
            reader,
        } = self.file;
        let removed = tokio::task::spawn_blocking(move || {
            drop((writer, reader));
            remove_tree(&path)
        })
        .await
        .unwrap_or_else(|error| Err(io::Error::other(error)));
        if let Err(error) = removed {
            tracing::warn!(
                session_id = %self.session_id,
                error = &error as &(dyn Error + 'static),
                "a file of tool call arguments that keeps none was not removed"
            );
        }
    }
}

impl ArgumentFile {
    // Makes a fresh file under a name of its own in `folder`, readable by the person alone, and
    // opens it once for writing and once for reading.
    fn make(folder: &Path) -> io::Result<Self> {
        create_private_folder(folder)?;
        let path = folder.join(mint_uuid_v7().to_string());
        let writer = create_new_file(&path, TOOL_CALL_ARGUMENTS_FILE_MODE)?;
        match File::open(&path) {
            Ok(reader) => Ok(Self {
                path,
                writer: Arc::new(writer),
                reader: Arc::new(reader),
            }),
            Err(error) => {
                drop(writer);
                remove_logged(&path);
                Err(error)
            }
        }
    }
}

impl ArgumentWrite {
    // Runs the write, answering where each argument went or the arguments a failure left; a
    // file the write made is removed where the write fails, and a compacted file once its copy
    // holds its live arguments.
    fn run(self) -> ArgumentWriteOutcome {
        let written = match &self.target {
            ArgumentTarget::Make => self.write_new_file(None),
            ArgumentTarget::Append { file, start } => {
                append_arguments(file, *start, Vec::new(), &self.batch)
                    .map(|(ranges, length)| (file.clone(), ranges, length))
            }
            ArgumentTarget::Compact { file, live } => self.write_new_file(Some((file, live))),
        };
        match written {
            Ok((file, ranges, length)) => {
                if let ArgumentTarget::Compact {
                    file: compacted, ..
                } = self.target
                {
                    remove_logged(&compacted.path);
                }
                ArgumentWriteOutcome::Written {
                    file,
                    ranges,
                    length,
                }
            }
            Err(error) => ArgumentWriteOutcome::Failed {
                error,
                batch: self.batch,
            },
        }
    }

    // Makes a fresh file, copies `compacted`'s live arguments into it, then appends the batch;
    // a failure removes the fresh file.
    fn write_new_file(
        &self,
        compacted: Option<(&ArgumentFile, &[(u64, DiskRange)])>,
    ) -> io::Result<(ArgumentFile, ArgumentPlaces, u64)> {
        let made = ArgumentFile::make(&self.folder)?;
        match copy_and_append(&made, compacted, &self.batch) {
            Ok((ranges, length)) => Ok((made, ranges, length)),
            Err(error) => {
                let path = made.path.clone();
                drop(made);
                remove_logged(&path);
                Err(error)
            }
        }
    }
}

// Copies `compacted`'s live arguments to the start of the fresh file `made`, each at its new
// place, then appends `batch` after them.
fn copy_and_append(
    made: &ArgumentFile,
    compacted: Option<(&ArgumentFile, &[(u64, DiskRange)])>,
    batch: &[(u64, Box<RawValue>)],
) -> io::Result<(ArgumentPlaces, u64)> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    if let Some((file, live)) = compacted {
        let mut writer = &*made.writer;
        for (key, range) in live {
            writer.write_all(&read_range(&file.reader, *range)?)?;
            ranges.push((*key, DiskRange { offset, ..*range }));
            offset += range.length as u64;
        }
    }
    append_arguments(made, offset, ranges, batch)
}

// Writes `batch` to `file` from `start`, after `ranges`; answers every argument's place and the
// file's length.
fn append_arguments(
    file: &ArgumentFile,
    start: u64,
    mut ranges: ArgumentPlaces,
    batch: &[(u64, Box<RawValue>)],
) -> io::Result<(ArgumentPlaces, u64)> {
    let mut writer = &*file.writer;
    // From the bytes the store counts, so a failed write's partial bytes are written over.
    writer.seek(SeekFrom::Start(start))?;
    let mut offset = start;
    for (key, arguments) in batch {
        let bytes = arguments.get().as_bytes();
        writer.write_all(bytes)?;
        ranges.push((
            *key,
            DiskRange {
                offset,
                length: bytes.len(),
            },
        ));
        offset += bytes.len() as u64;
    }
    Ok((ranges, offset))
}

// Removes `path`, on the blocking thread a write runs on; a failure is logged, and the next
// start's sweep removes it.
fn remove_logged(path: &Path) {
    if let Err(error) = remove_tree(path) {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a file of tool call arguments a write made or replaced was not removed"
        );
    }
}

// The bytes `range` covers in `file`, read by offset, so reads sharing the handle never meet.
fn read_range(file: &File, range: DiskRange) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0; range.length];
    read_exact_at(file, &mut bytes, range.offset)?;
    Ok(bytes)
}
