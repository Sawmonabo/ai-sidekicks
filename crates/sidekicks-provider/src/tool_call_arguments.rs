//! The arguments of the tool calls that await their results, kept for the calls' traces: in memory
//! up to a bound on their count and their bytes, and past it the oldest written to one private file
//! per process in the data folder and read back when the result arrives. A call's arguments go
//! when the call settles, the file once it keeps none, and a file a stopped daemon left goes at
//! the next start. The file is written and read on blocking threads, never under a caller's lock.

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{
    create_new_file, create_private_folder, remove_tree, remove_tree_awaited,
};
use sidekicks_std::mutex_lock::lock;
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

// What one process keeps. Keys rise with each call kept, so the lowest in memory is the oldest.
struct ArgumentShelf {
    session_id: SessionId,
    folder: PathBuf,
    file: PathBuf,
    bounds: ToolCallArgumentBounds,
    next_key: u64,
    in_memory: BTreeMap<u64, Box<RawValue>>,
    in_memory_bytes: usize,
    // The arguments a write under way is taking to the file.
    writing: HashSet<u64>,
    on_disk: HashMap<u64, DiskRange>,
    on_disk_bytes: u64,
    // The bytes the file holds, its forgotten arguments' included.
    file_length: u64,
    // Whether a write is under way, so no second one starts and the file stays.
    is_writing: bool,
    // Whether a write may have made the file.
    has_file: bool,
}

// One write to the file: the oldest arguments past the bounds, appended at `start`, after the file
// is first compacted to the arguments in `live` where forgotten bytes outgrew them.
struct ArgumentWrite {
    folder: PathBuf,
    file: PathBuf,
    start: u64,
    live: Option<Vec<(u64, DiskRange)>>,
    batch: Vec<(u64, Box<RawValue>)>,
}

// What a write did: each argument's place in the file, a compacted one's new place included, and
// the file's length; or why it failed, with the arguments it could not take.
enum ArgumentWriteOutcome {
    Written {
        ranges: Vec<(u64, DiskRange)>,
        file_length: u64,
    },
    Failed {
        error: io::Error,
        batch: Vec<(u64, Box<RawValue>)>,
    },
}

impl ToolCallArgumentStore {
    /// The store of a process of `session_id`, whose file goes under a name of its own in the
    /// data folder `data_folder`, made only once arguments pass the bounds.
    pub(crate) fn new(data_folder: &Path, session_id: SessionId) -> Self {
        Self::with_bounds(data_folder, session_id, TOOL_CALL_ARGUMENT_BOUNDS)
    }

    // The store keeping arguments in memory within `bounds`.
    fn with_bounds(
        data_folder: &Path,
        session_id: SessionId,
        bounds: ToolCallArgumentBounds,
    ) -> Self {
        let folder = tool_call_arguments_folder(data_folder);
        let file = folder.join(mint_uuid_v7().to_string());
        Self {
            shelf: Arc::new(Mutex::new(ArgumentShelf {
                session_id,
                folder,
                file,
                bounds,
                next_key: 0,
                in_memory: BTreeMap::new(),
                in_memory_bytes: 0,
                writing: HashSet::new(),
                on_disk: HashMap::new(),
                on_disk_bytes: 0,
                file_length: 0,
                is_writing: false,
                has_file: false,
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
    /// thread, logged at debug; what a failed write could not take stays in memory, logged.
    pub(crate) async fn spill_past_bounds(&self) {
        let Some(write) = lock(&self.shelf).take_write() else {
            return;
        };
        let keys: Vec<u64> = write.batch.iter().map(|(key, _)| *key).collect();
        let outcome = tokio::task::spawn_blocking(move || write.run()).await;
        lock(&self.shelf).finish_write(&keys, outcome);
    }
}

impl KeptToolCallArguments {
    /// The arguments, word for word, read back from the file on a blocking thread where they were
    /// written there. Fails with the system's error from the file, or `NotFound` for arguments a
    /// write lost to a panic.
    pub(crate) async fn read(self) -> io::Result<Box<RawValue>> {
        let (opened, range) = {
            let mut shelf = lock(&self.shelf);
            if let Some(arguments) = shelf.in_memory.remove(&self.key) {
                shelf.in_memory_bytes -= arguments.get().len();
                return Ok(arguments);
            }
            let Some(range) = shelf.on_disk.remove(&self.key) else {
                return Err(io::Error::new(
                    ErrorKind::NotFound,
                    "the arguments were lost to a failed write",
                ));
            };
            shelf.on_disk_bytes -= range.length as u64;
            // Opened here, so a later compaction's rename leaves this read on the file it read.
            (File::open(&shelf.file), range)
        };
        let read = async {
            let file = opened?;
            tokio::task::spawn_blocking(move || read_range(file, range))
                .await
                .map_err(io::Error::other)?
        }
        .await;
        lock(&self.shelf).remove_file_if_unused();
        let text = String::from_utf8(read?)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
        RawValue::from_string(text).map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
    }
}

impl Drop for KeptToolCallArguments {
    fn drop(&mut self) {
        lock(&self.shelf).forget(self.key);
    }
}

impl ArgumentShelf {
    // Takes the oldest arguments in memory past the bounds out for a write, with the arguments
    // on disk where the file's forgotten bytes outgrew them and the bounds; none while a write is
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
        let forgotten = self.file_length - self.on_disk_bytes;
        let live = (forgotten > self.on_disk_bytes + self.bounds.bytes as u64).then(|| {
            let mut live: Vec<(u64, DiskRange)> = self
                .on_disk
                .iter()
                .map(|(key, range)| (*key, *range))
                .collect();
            live.sort_by_key(|(_, range)| range.offset);
            live
        });
        self.is_writing = true;
        self.has_file = true;
        Some(ArgumentWrite {
            folder: self.folder.clone(),
            file: self.file.clone(),
            start: self.file_length,
            live,
            batch,
        })
    }

    // Takes a write's outcome: each argument written is on disk unless forgotten meanwhile, each
    // compacted one moves, and a failed write's arguments go back in memory; arguments a write
    // lost to a panic are gone.
    fn finish_write(&mut self, keys: &[u64], outcome: Result<ArgumentWriteOutcome, JoinError>) {
        self.is_writing = false;
        match outcome {
            Ok(ArgumentWriteOutcome::Written {
                ranges,
                file_length,
            }) => {
                self.file_length = file_length;
                let mut written_calls = 0;
                let mut written_bytes = 0;
                for (key, range) in ranges {
                    if self.writing.remove(&key) {
                        self.on_disk.insert(key, range);
                        self.on_disk_bytes += range.length as u64;
                        written_calls += 1;
                        written_bytes += range.length;
                    } else if let Some(moved) = self.on_disk.get_mut(&key) {
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
                tracing::warn!(
                    session_id = %self.session_id,
                    error = &error as &(dyn Error + 'static),
                    "tool call arguments past the memory bound could not be written to disk, so \
                     they stay in memory"
                );
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
        self.remove_file_if_unused();
    }

    // Forgets the arguments under `key`, wherever they are; the file goes once it keeps none.
    fn forget(&mut self, key: u64) {
        if let Some(arguments) = self.in_memory.remove(&key) {
            self.in_memory_bytes -= arguments.get().len();
        } else if !self.writing.remove(&key)
            && let Some(range) = self.on_disk.remove(&key)
        {
            self.on_disk_bytes -= range.length as u64;
            self.remove_file_if_unused();
        }
    }

    // Removes the file once it keeps no arguments and no write is under way; a failed removal is
    // logged, and the next start's sweep removes it.
    fn remove_file_if_unused(&mut self) {
        if !self.has_file || self.is_writing || !self.on_disk.is_empty() {
            return;
        }
        self.has_file = false;
        self.file_length = 0;
        if let Err(error) = remove_tree(&self.file) {
            tracing::warn!(
                session_id = %self.session_id,
                error = &error as &(dyn Error + 'static),
                "a file of tool call arguments that keeps none was not removed"
            );
        }
    }
}

impl ArgumentWrite {
    // Runs the write, answering where each argument went or the arguments a failure left; a
    // compaction a failure cut short leaves the file as it was and its copy removed.
    fn run(self) -> ArgumentWriteOutcome {
        let compacted = self.file.with_extension("compacting");
        match write_arguments(&self, &compacted) {
            Ok((ranges, file_length)) => ArgumentWriteOutcome::Written {
                ranges,
                file_length,
            },
            Err(error) => {
                if self.live.is_some()
                    && let Err(removal) = remove_tree(&compacted)
                {
                    tracing::warn!(
                        error = &removal as &(dyn Error + 'static),
                        "a compaction cut short left its copy of the tool call arguments' file"
                    );
                }
                ArgumentWriteOutcome::Failed {
                    error,
                    batch: self.batch,
                }
            }
        }
    }
}

// Appends `write`'s arguments to its file, after copying the live arguments into `compacted` and
// moving it over the file where the write compacts it; answers each argument's place and the
// file's length.
fn write_arguments(
    write: &ArgumentWrite,
    compacted: &Path,
) -> io::Result<(Vec<(u64, DiskRange)>, u64)> {
    create_private_folder(&write.folder)?;
    let mut ranges = Vec::new();
    let (mut target, mut offset) = match &write.live {
        None => (open_for_write(&write.file)?, write.start),
        Some(live) => {
            remove_tree(compacted)?;
            let mut target = create_new_file(compacted, TOOL_CALL_ARGUMENTS_FILE_MODE)?;
            let mut offset = 0;
            for (key, range) in live {
                let bytes = read_range(File::open(&write.file)?, *range)?;
                target.write_all(&bytes)?;
                ranges.push((*key, DiskRange { offset, ..*range }));
                offset += range.length as u64;
            }
            (target, offset)
        }
    };
    target.seek(SeekFrom::Start(offset))?;
    for (key, arguments) in &write.batch {
        let bytes = arguments.get().as_bytes();
        target.write_all(bytes)?;
        ranges.push((
            *key,
            DiskRange {
                offset,
                length: bytes.len(),
            },
        ));
        offset += bytes.len() as u64;
    }
    if write.live.is_some() {
        std::fs::rename(compacted, &write.file)?;
    }
    Ok((ranges, offset))
}

// The file open for writing, made readable by the person alone where it is missing.
fn open_for_write(file: &Path) -> io::Result<File> {
    match OpenOptions::new().write(true).open(file) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            create_new_file(file, TOOL_CALL_ARGUMENTS_FILE_MODE)
        }
        opened => opened,
    }
}

// The bytes `range` covers in `file`.
fn read_range(mut file: File, range: DiskRange) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(range.offset))?;
    let mut bytes = vec![0; range.length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}
