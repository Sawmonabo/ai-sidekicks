//! The process's memory footprint the measurement tests read, as macOS and Linux account it.

/// The process's footprint: the memory the system charges the process now and at its peak (macOS's
/// physical footprint, Linux's resident set), with the `footprint` tool's line for it, or why there
/// is none.
#[derive(Debug)]
pub struct ProcessFootprint {
    /// The bytes charged now.
    pub current_bytes: u64,
    /// The most bytes charged since the process began.
    pub peak_bytes: u64,
    /// The `footprint` tool's line for the process, or why it gave none.
    pub tool_line: String,
}
