//! What a refused clone's error tells: that the copy's place is on another volume than its source,
//! or that the source's volume makes no clones. Each platform's module reads it from the error.
//! Also whether a clone can go into a file already made.

/// Whether a clone can go into a file already made and open for writing, as Linux's `FICLONE` and
/// Windows' block cloning do; macOS's `clonefile` makes only a new file at a path.
pub const CAN_CLONE_INTO_OPEN_FILE: bool = !cfg!(target_os = "macos");

/// Why the system refused to clone a file, read from the clone's error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CloneRefusal {
    /// The copy's place is on another volume than the source, and a clone never crosses volumes.
    #[error("the copy's place is on another volume than its source")]
    AcrossVolumes,
    /// The source's volume makes no clones.
    #[error("the source's volume makes no clones")]
    Unsupported,
}
