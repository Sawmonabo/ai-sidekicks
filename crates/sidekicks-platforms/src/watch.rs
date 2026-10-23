//! A folder's arrival watch, which hands back the records renamed into it, and a file's append
//! watch, which hands back the bytes appended to it. Each platform's module supplies the wake a
//! change raises; the folder's listing and the file's reads are shared.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use tokio::fs::File;
use tokio::io::AsyncReadExt;

use crate::atomic_replace::TEMPORARY_FILE_SUFFIX;
#[cfg(target_os = "linux")]
use crate::linux::watch::ChangeWake;
#[cfg(target_os = "macos")]
use crate::macos::watch::ChangeWake;
#[cfg(target_os = "windows")]
use crate::windows::watch::ChangeWake;

// The most bytes one read of an appended file hands back, so a burst of output is read in bounded
// pieces.
const APPEND_READ_LIMIT: usize = 64 * 1024;

/// A watch on a folder whose records arrive by rename, a record being written to a temporary name
/// and renamed into place, so a half-written record is never seen.
pub struct FolderArrivalWatch {
    folder: PathBuf,
    // The names the last listing held, so each arrival is reported once.
    known: HashSet<OsString>,
    wake: ChangeWake,
}

impl FolderArrivalWatch {
    /// Watches `folder`; the records it already holds are not arrivals. Fails with the system's
    /// error when the folder cannot be opened, watched or listed, and with `Unsupported` on
    /// Windows.
    pub async fn watch(folder: &Path) -> io::Result<Self> {
        let wake = ChangeWake::on_folder_renames(folder)?;
        let known = list_names(folder).await?;
        Ok(Self {
            folder: folder.to_path_buf(),
            known,
            wake,
        })
    }

    /// The paths of the records that arrived since the last call in name order, waiting until one
    /// does; a name ending in the temporary suffix a record is written under is never one. Fails
    /// with the system's error when the folder cannot be listed or the watch fails, and with
    /// `NotFound` once the folder is removed or renamed away.
    pub async fn next_arrivals(&mut self) -> io::Result<Vec<PathBuf>> {
        loop {
            let names = list_names(&self.folder).await?;
            let mut arrivals: Vec<PathBuf> = names
                .difference(&self.known)
                .map(|name| self.folder.join(name))
                .collect();
            arrivals.sort();
            self.known = names;
            if !arrivals.is_empty() {
                return Ok(arrivals);
            }
            self.wake.changed().await?;
        }
    }
}

/// A watch on a file a command writes, handing back each byte appended to it once, from its start;
/// it follows the open file, so the bytes written after its name is removed or replaced still come.
pub struct FileAppendWatch {
    file: File,
    // The bytes handed back so far, which the file's length never falls under while only appended.
    offset: u64,
    wake: ChangeWake,
}

impl FileAppendWatch {
    /// Watches the file at `path`, whose bytes so far are read first. Fails with the system's error
    /// when the file cannot be opened or watched, `NotFound` when its name is already gone, and
    /// with `Unsupported` on Windows.
    pub async fn watch(path: &Path) -> io::Result<Self> {
        let wake = ChangeWake::on_file_appends(path)?;
        let file = File::open(path).await?;
        Ok(Self {
            file,
            offset: 0,
            wake,
        })
    }

    /// The bytes appended since the last call, at most 64 KiB, waiting until there are some. Fails
    /// with the system's error when the file cannot be read or the watch fails, and with
    /// `InvalidData` once the file is shorter than the bytes already handed back, as a truncated
    /// file is; a command that empties and rewrites its own output between two reads loses the
    /// bytes up to where the last read stopped.
    pub async fn next_appended(&mut self) -> io::Result<Vec<u8>> {
        let mut buffer = vec![0_u8; APPEND_READ_LIMIT];
        loop {
            let count = self.read_appended(&mut buffer).await?;
            if count > 0 {
                buffer.truncate(count);
                return Ok(buffer);
            }
            self.wake.changed().await?;
        }
    }

    /// The bytes appended since the last call, at most 64 KiB, without waiting: empty when none
    /// are, for a caller reading the last bytes after the writer's end. Fails as
    /// [`Self::next_appended`] does.
    pub async fn drain(&mut self) -> io::Result<Vec<u8>> {
        let mut buffer = vec![0_u8; APPEND_READ_LIMIT];
        let count = self.read_appended(&mut buffer).await?;
        buffer.truncate(count);
        Ok(buffer)
    }

    // Reads into `buffer` what was appended since the last read, counting it handed back.
    async fn read_appended(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = self.file.metadata().await?.len();
        if length < self.offset {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "the watched file holds {length} bytes, fewer than the {} already read",
                    self.offset
                ),
            ));
        }
        let count = self.file.read(buffer).await?;
        self.offset += u64::try_from(count).map_err(io::Error::other)?;
        Ok(count)
    }
}

// The names in `folder`, the temporary names records are written under left out.
async fn list_names(folder: &Path) -> io::Result<HashSet<OsString>> {
    let mut entries = tokio::fs::read_dir(folder).await?;
    let mut names = HashSet::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        if !name
            .as_encoded_bytes()
            .ends_with(TEMPORARY_FILE_SUFFIX.as_bytes())
        {
            names.insert(name);
        }
    }
    Ok(names)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::io::{ErrorKind, Seek, Write};
    use std::path::Path;
    use std::time::Duration;

    use rstest::rstest;
    use tokio::time::{sleep, timeout};

    use super::{FileAppendWatch, FolderArrivalWatch};
    use crate::atomic_replace::TEMPORARY_FILE_SUFFIX;

    // How long a change may take to be seen.
    const SEEN_WITHIN: Duration = Duration::from_secs(5);

    // How long a write that must not be seen is waited on.
    const UNSEEN_FOR: Duration = Duration::from_millis(300);

    // How long a change waits, so the watch is already waiting when it comes.
    const CHANGE_DELAY: Duration = Duration::from_millis(50);

    // Fails when a write to a temporary name is taken for a record, or a rename into the folder
    // does not wake the waiting watch.
    #[tokio::test]
    async fn folder_arrival_watch_sees_a_rename_and_not_a_temporary_write() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let mut watch = FolderArrivalWatch::watch(folder.path())
            .await
            .expect("the folder is watched");
        let temporary = folder
            .path()
            .join(format!("record.1{TEMPORARY_FILE_SUFFIX}"));
        let record = folder.path().join("record");

        let (early, ()) = tokio::join!(timeout(UNSEEN_FOR, watch.next_arrivals()), async {
            sleep(CHANGE_DELAY).await;
            fs::write(&temporary, b"half").expect("the temporary file is written");
        });
        let (arrivals, ()) = tokio::join!(timeout(SEEN_WITHIN, watch.next_arrivals()), async {
            sleep(CHANGE_DELAY).await;
            fs::rename(&temporary, &record).expect("the record is renamed into place");
        });

        assert!(
            early.is_err(),
            "a temporary write was an arrival: {early:?}"
        );
        assert_eq!(
            arrivals
                .expect("the rename is seen in time")
                .expect("the folder is listed"),
            vec![record]
        );
    }

    // Fails when the folder's watch goes on waiting after the folder is renamed away, since no
    // record can arrive in it any more.
    #[tokio::test]
    async fn folder_arrival_watch_fails_once_its_folder_is_renamed_away() {
        let parent = tempfile::tempdir().expect("a scratch folder");
        let folder = parent.path().join("channel");
        fs::create_dir(&folder).expect("the folder is made");
        let mut watch = FolderArrivalWatch::watch(&folder)
            .await
            .expect("the folder is watched");

        let (arrivals, ()) = tokio::join!(timeout(SEEN_WITHIN, watch.next_arrivals()), async {
            sleep(CHANGE_DELAY).await;
            fs::rename(&folder, parent.path().join("moved")).expect("the folder is renamed");
        });

        let failure = arrivals
            .expect("the rename is seen in time")
            .expect_err("the watch fails");
        assert_eq!(failure.kind(), ErrorKind::NotFound);
    }

    // Fails when the bytes written before the watch are skipped, an append does not wake the
    // waiting watch, or a byte is handed back twice.
    #[tokio::test]
    async fn file_append_watch_hands_back_each_appended_byte_once() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("output");
        let mut writer = fs::File::create(&path).expect("the file is made");
        writer
            .write_all(b"first ")
            .expect("the first bytes are written");
        let mut watch = FileAppendWatch::watch(&path)
            .await
            .expect("the file is watched");

        let first = timeout(SEEN_WITHIN, watch.next_appended()).await;
        let (second, ()) = tokio::join!(timeout(SEEN_WITHIN, watch.next_appended()), async {
            sleep(CHANGE_DELAY).await;
            writer.write_all(b"second").expect("the append is written");
        });

        assert_eq!(
            first
                .expect("the first bytes in time")
                .expect("the file reads"),
            b"first "
        );
        assert_eq!(
            second
                .expect("the append is seen in time")
                .expect("the file reads"),
            b"second"
        );
    }

    // Fails when the watch ends, or stops waking, once the file's name is removed, renamed away or
    // replaced by another file's, while its writer goes on writing through its open descriptor.
    #[rstest]
    #[case::removed(|path: &Path| fs::remove_file(path).expect("the file's name is removed"))]
    #[case::renamed_away(|path: &Path| {
        fs::rename(path, path.with_extension("moved")).expect("the file is renamed away");
    })]
    #[case::renamed_over(|path: &Path| {
        let other = path.with_extension("other");
        fs::write(&other, b"other").expect("another file is written");
        fs::rename(&other, path).expect("the other file is renamed over the name");
    })]
    #[tokio::test]
    async fn file_append_watch_follows_its_file_past_its_name(#[case] lose_name: fn(&Path)) {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("output");
        let mut writer = fs::File::create(&path).expect("the file is made");
        let mut watch = FileAppendWatch::watch(&path)
            .await
            .expect("the file is watched");

        let (after, ()) = tokio::join!(timeout(SEEN_WITHIN, watch.next_appended()), async {
            sleep(CHANGE_DELAY).await;
            lose_name(&path);
            writer.write_all(b"after").expect("the append is written");
        });

        assert_eq!(
            after
                .expect("the append is seen in time")
                .expect("the file reads"),
            b"after"
        );
    }

    // Fails when a file whose name is gone before the watch fails as anything but missing.
    #[tokio::test]
    async fn file_append_watch_of_a_missing_file_fails_as_not_found() {
        let folder = tempfile::tempdir().expect("a scratch folder");

        let failure = FileAppendWatch::watch(&folder.path().join("output")).await;

        assert_eq!(
            failure.err().map(|failure| failure.kind()),
            Some(ErrorKind::NotFound)
        );
    }

    // Fails when a drain waits for an append, or does not hand back what was appended.
    #[tokio::test]
    async fn file_append_watch_drains_without_waiting() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("output");
        let mut writer = fs::File::create(&path).expect("the file is made");
        let mut watch = FileAppendWatch::watch(&path)
            .await
            .expect("the file is watched");

        let quiet = timeout(SEEN_WITHIN, watch.drain()).await;
        writer.write_all(b"last").expect("the append is written");
        let appended = timeout(SEEN_WITHIN, watch.drain()).await;

        assert_eq!(
            quiet
                .expect("a quiet file drains in time")
                .expect("the file reads"),
            b""
        );
        assert_eq!(
            appended
                .expect("the append drains in time")
                .expect("the file reads"),
            b"last"
        );
    }

    // Fails when a file cut shorter than what was read goes on being read from the old offset,
    // which skips the bytes written at its new start.
    #[tokio::test]
    async fn file_append_watch_fails_once_its_file_is_truncated() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("output");
        let mut writer = fs::File::create(&path).expect("the file is made");
        writer
            .write_all(b"first ")
            .expect("the first bytes are written");
        let mut watch = FileAppendWatch::watch(&path)
            .await
            .expect("the file is watched");
        let first = timeout(SEEN_WITHIN, watch.next_appended()).await;

        let (after_truncation, ()) =
            tokio::join!(timeout(SEEN_WITHIN, watch.next_appended()), async {
                sleep(CHANGE_DELAY).await;
                writer.set_len(0).expect("the file is truncated");
                writer.rewind().expect("the writer goes back to the start");
                writer.write_all(b"x").expect("a new first byte is written");
            });

        first
            .expect("the first bytes in time")
            .expect("the file reads");
        let failure = after_truncation
            .expect("the truncation is seen in time")
            .expect_err("the watch fails");
        assert_eq!(failure.kind(), ErrorKind::InvalidData);
    }
}
