//! A WAL checkpoint the database writer runs on its connection, and what SQLite reports of it.

/// A WAL checkpoint mode the writer runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointMode {
    /// Moves nothing; it only reads the log's counts.
    Noop,
    /// Moves what it can without waiting on any reader or writer.
    Passive,
    /// Moves every frame, then truncates the log to nothing.
    Truncate,
}

impl CheckpointMode {
    /// The mode as `PRAGMA wal_checkpoint(…)` spells it.
    pub(crate) fn as_sql(self) -> &'static str {
        match self {
            Self::Noop => "NOOP",
            Self::Passive => "PASSIVE",
            Self::Truncate => "TRUNCATE",
        }
    }
}

/// What a WAL checkpoint reports, in SQLite's own terms; both counts are -1 when the database is
/// not in WAL mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointResult {
    /// Whether another connection kept the checkpoint from finishing.
    pub(crate) is_busy: bool,
    /// Frames in the write-ahead log.
    pub(crate) log_frames: i64,
    /// Frames of the log moved into the database file since the log last restarted, by this
    /// checkpoint and every one before it.
    pub(crate) checkpointed_frames: i64,
}
