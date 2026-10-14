//! The process's memory footprint the measurement tests read, as macOS accounts it.

/// The process's footprint as macOS accounts it: the memory the system charges the process now and
/// at its peak, with the line the `footprint` tool prints for it.
#[derive(Debug)]
pub struct ProcessFootprint {
    /// The bytes charged now.
    pub current_bytes: u64,
    /// The most bytes charged since the process began.
    pub peak_bytes: u64,
    /// The `footprint` tool's line for the process, or why it gave none.
    pub tool_line: String,
}
