//! The index's folder as Tantivy's `Directory`: files written durably, held with the operating
//! system's file locks, and read by positioned reads or, on macOS, through a memory map.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

#[cfg(target_os = "macos")]
use tantivy::directory::MmapDirectory;
use tantivy::directory::error::{DeleteError, LockError, OpenReadError, OpenWriteError};
use tantivy::directory::{
    AntiCallToken, DirectoryLock, FileHandle, Lock, OwnedBytes, TerminatingWrite, WatchCallback,
    WatchHandle, WritePtr,
};
use tantivy::{Directory, HasLen};

/// How the index reads its files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadMode {
    /// Each read copies its byte range out of the file with a positioned read, so concurrent reads
    /// share one handle.
    #[cfg_attr(
        all(target_os = "macos", not(test)),
        expect(
            dead_code,
            reason = "on macOS only the tests read positioned, as other platforms do"
        )
    )]
    Positioned,
    /// Tantivy's memory map, built for macOS alone.
    #[cfg(target_os = "macos")]
    MemoryMap,
}

impl ReadMode {
    /// The mode an index opens in: the memory map on macOS, where it holds the smaller footprint,
    /// and positioned reads everywhere else.
    #[cfg(target_os = "macos")]
    pub const DEFAULT: ReadMode = ReadMode::MemoryMap;
    /// The mode an index opens in: positioned reads, never a memory map.
    #[cfg(not(target_os = "macos"))]
    pub const DEFAULT: ReadMode = ReadMode::Positioned;
}

/// The index's folder as Tantivy's `Directory`.
#[derive(Clone, Debug)]
pub struct FolderDirectory {
    root: PathBuf,
    #[cfg(target_os = "macos")]
    memory_map: Option<MmapDirectory>,
}

impl FolderDirectory {
    /// The existing folder `root`, its files read in `read_mode`.
    pub fn open(root: &Path, read_mode: ReadMode) -> io::Result<FolderDirectory> {
        // Off macOS positioned reads are the only mode, so the mode chooses nothing.
        #[cfg(not(target_os = "macos"))]
        let ReadMode::Positioned = read_mode;
        Ok(FolderDirectory {
            root: root.to_path_buf(),
            #[cfg(target_os = "macos")]
            memory_map: match read_mode {
                ReadMode::MemoryMap => Some(MmapDirectory::open(root).map_err(io::Error::other)?),
                ReadMode::Positioned => None,
            },
        })
    }
}

// The file Tantivy records each commit in; Tantivy does not export its name.
const COMMIT_FILE: &str = "meta.json";

// Tells apart the files a read cache keys by; a file handle lives for one searcher's segment.
static NEXT_FILE_ID: AtomicU64 = AtomicU64::new(0);

impl Directory for FolderDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
        #[cfg(target_os = "macos")]
        if let Some(memory_map) = &self.memory_map {
            return memory_map.get_file_handle(path);
        }
        let file = File::open(self.root.join(path)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                OpenReadError::FileDoesNotExist(path.to_path_buf())
            } else {
                OpenReadError::wrap_io_error(error, path.to_path_buf())
            }
        })?;
        let length = file
            .metadata()
            .map_err(|error| OpenReadError::wrap_io_error(error, path.to_path_buf()))?
            .len() as usize;
        let id = NEXT_FILE_ID.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::new(PositionedFile { id, file, length }))
    }

    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        fs::remove_file(self.root.join(path)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DeleteError::FileDoesNotExist(path.to_path_buf())
            } else {
                DeleteError::IoError {
                    io_error: Arc::new(error),
                    filepath: path.to_path_buf(),
                }
            }
        })
    }

    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        self.root
            .join(path)
            .try_exists()
            .map_err(|error| OpenReadError::wrap_io_error(error, path.to_path_buf()))
    }

    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.root.join(path))
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    OpenWriteError::FileAlreadyExists(path.to_path_buf())
                } else {
                    OpenWriteError::wrap_io_error(error, path.to_path_buf())
                }
            })?;
        Ok(BufWriter::new(Box::new(DurableFile(file))))
    }

    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        fs::read(self.root.join(path)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                OpenReadError::FileDoesNotExist(path.to_path_buf())
            } else {
                OpenReadError::wrap_io_error(error, path.to_path_buf())
            }
        })
    }

    // Written beside the target, flushed to disk, then renamed over it, so a reader sees the old
    // file or the new one whole. Tantivy syncs the folder before it writes a commit's `meta.json`,
    // which makes the commit's files and every earlier rename durable, but not after, so the
    // folder is synced once more here: a commit that has returned survives a crash of the system.
    fn atomic_write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        let mut temporary_name = path.as_os_str().to_owned();
        temporary_name.push(".tmp");
        let temporary = self.root.join(temporary_name);
        let mut file = File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_data()?;
        drop(file);
        fs::rename(&temporary, self.root.join(path))?;
        if path == Path::new(COMMIT_FILE) {
            self.sync_directory()?;
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn sync_directory(&self) -> io::Result<()> {
        File::open(&self.root)?.sync_data()
    }

    // Windows makes a file's directory entry durable with the file; syncing a folder handle is not
    // supported there.
    #[cfg(windows)]
    fn sync_directory(&self) -> io::Result<()> {
        Ok(())
    }

    // An operating-system lock, released when its file closes, so a crashed process leaves no
    // lock behind for the next open to trip on.
    fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(&lock.filepath))
            .map_err(LockError::wrap_io_error)?;
        if lock.is_blocking {
            file.lock().map_err(LockError::wrap_io_error)?;
        } else {
            file.try_lock().map_err(|error| match error {
                TryLockError::WouldBlock => LockError::LockBusy,
                TryLockError::Error(error) => LockError::wrap_io_error(error),
            })?;
        }
        Ok(DirectoryLock::from(Box::new(file)))
    }

    // Reloads happen after each commit, never on a watch.
    fn watch(&self, _: WatchCallback) -> tantivy::Result<WatchHandle> {
        Ok(WatchHandle::empty())
    }
}

// A written file made durable when Tantivy finishes it.
struct DurableFile(File);

impl Write for DurableFile {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl TerminatingWrite for DurableFile {
    fn terminate_ref(&mut self, _: AntiCallToken) -> io::Result<()> {
        self.0.flush()?;
        self.0.sync_data()
    }
}

#[derive(Debug)]
struct PositionedFile {
    id: u64,
    file: File,
    length: usize,
}

impl HasLen for PositionedFile {
    fn len(&self) -> usize {
        self.length
    }
}

impl FileHandle for PositionedFile {
    fn read_bytes(&self, range: Range<usize>) -> io::Result<OwnedBytes> {
        let key = (self.id, range.start, range.end);
        if let Some(bytes) = ReadCache::lookup(key) {
            return Ok(bytes);
        }
        let mut buffer = vec![0u8; range.len()];
        read_exactly_at(&self.file, &mut buffer, range.start as u64)?;
        let bytes = OwnedBytes::new(buffer);
        ReadCache::store(key, &bytes);
        Ok(bytes)
    }
}

#[cfg(unix)]
fn read_exactly_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buffer, offset)
}

// `seek_read` may return fewer bytes than asked, so it is called until the buffer is full.
#[cfg(windows)]
fn read_exactly_at(file: &File, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !buffer.is_empty() {
        match std::os::windows::fs::FileExt::seek_read(file, buffer, offset) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(read) => {
                buffer = &mut std::mem::take(&mut buffer)[read..];
                offset += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

type RangeKey = (u64, usize, usize);

// The most bytes one search's read cache holds; a range read past it is read again when asked.
const READ_CACHE_BYTES_MAX: usize = 16 * 1024 * 1024;

/// The byte ranges one search has read with positioned reads, so a posting list it reads again
/// (counting, ranking, then a page's hits) is copied out of its file once, up to a byte cap.
/// Freed with the search.
#[derive(Debug, Default)]
pub struct ReadCache {
    ranges: Mutex<CachedRanges>,
}

#[derive(Debug, Default)]
struct CachedRanges {
    by_key: HashMap<RangeKey, OwnedBytes>,
    bytes: usize,
    // The ranges the cap kept out, each counted once, so a measurement reads the search's whole
    // working set.
    #[cfg(all(test, feature = "measurements"))]
    refused: std::collections::HashSet<RangeKey>,
    #[cfg(all(test, feature = "measurements"))]
    refused_bytes: usize,
}

thread_local! {
    static CURRENT_READ_CACHE: RefCell<Option<Arc<ReadCache>>> = const { RefCell::new(None) };
}

impl ReadCache {
    /// Routes this thread's positioned reads through `cache` until the returned guard drops.
    pub fn enter(cache: &Arc<ReadCache>) -> ReadCacheGuard {
        let previous = CURRENT_READ_CACHE.with(|current| current.replace(Some(cache.clone())));
        ReadCacheGuard { previous }
    }

    fn lookup(key: RangeKey) -> Option<OwnedBytes> {
        CURRENT_READ_CACHE.with(|current| {
            let current = current.borrow();
            let ranges = current
                .as_ref()?
                .ranges
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            ranges.by_key.get(&key).cloned()
        })
    }

    fn store(key: RangeKey, bytes: &OwnedBytes) {
        CURRENT_READ_CACHE.with(|current| {
            if let Some(cache) = current.borrow().as_ref() {
                let mut ranges = cache.ranges.lock().unwrap_or_else(PoisonError::into_inner);
                if ranges.bytes + bytes.len() > READ_CACHE_BYTES_MAX {
                    #[cfg(all(test, feature = "measurements"))]
                    if ranges.refused.insert(key) {
                        ranges.refused_bytes += bytes.len();
                    }
                } else if ranges.by_key.insert(key, bytes.clone()).is_none() {
                    ranges.bytes += bytes.len();
                }
            }
        });
    }

    /// The bytes the cache holds, and the bytes of the ranges its cap kept out.
    #[cfg(all(test, feature = "measurements"))]
    pub(crate) fn held_and_refused_bytes(&self) -> (usize, usize) {
        let ranges = self.ranges.lock().unwrap_or_else(PoisonError::into_inner);
        (ranges.bytes, ranges.refused_bytes)
    }
}

/// Puts back the read cache that was current before `ReadCache::enter`.
pub struct ReadCacheGuard {
    previous: Option<Arc<ReadCache>>,
}

impl Drop for ReadCacheGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CURRENT_READ_CACHE.with(|current| current.replace(previous));
    }
}
