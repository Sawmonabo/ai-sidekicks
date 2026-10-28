//! What the system's file watch can do: whether one watch covers a whole tree, whether git's watch
//! outlives a move of the tree it watches, and on Linux the ceiling on how many folders one user's
//! programs may watch together.

use std::io;

/// Whether one watch on a folder reports every change in the tree under it, as `FSEvents` on
/// macOS and `ReadDirectoryChangesW` on Windows do; inotify on Linux watches one folder at a time,
/// so each folder of a tree takes a watch of its own.
pub const WATCHES_TREES: bool = !cfg!(target_os = "linux");

/// Whether git's file watch over a linked tree keeps running after the tree's folder is moved, so
/// a stop sent from the moved folder still has one to end: only on Linux, where inotify ignores a
/// move of the watched folder; on macOS the watch ends when its folder's path changes, and on
/// Windows it finds the move within a minute and ends.
pub const DOES_WATCH_OUTLIVE_TREE_MOVE: bool = cfg!(target_os = "linux");

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
