//! What a refused clone's error tells: that the copy's place is on another volume than its source,
//! or that the source's volume makes no clones. Each platform's module reads it from the error.

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
