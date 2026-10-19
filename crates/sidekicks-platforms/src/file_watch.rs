//! What the system's file watch can do: whether one watch covers a whole tree, and on Linux the
//! ceiling on how many folders one user's programs may watch together.

use std::io;

/// Whether one watch on a folder reports every change in the tree under it, as `FSEvents` on
/// macOS and `ReadDirectoryChangesW` on Windows do; inotify on Linux watches one folder at a time,
/// so each folder of a tree takes a watch of its own.
pub const WATCHES_TREES: bool = !cfg!(target_os = "linux");

/// How many folders one user's programs may watch together on Linux, read from
/// `/proc/sys/fs/inotify/max_user_watches`; `None` on macOS and Windows, which set no such ceiling.
/// Fails with the read's error, or `InvalidData` when the file holds no number.
pub fn inotify_watch_ceiling() -> io::Result<Option<u64>> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")?;
        text.trim()
            .parse()
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(None)
    }
}
