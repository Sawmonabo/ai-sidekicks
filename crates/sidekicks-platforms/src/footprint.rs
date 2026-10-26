//! The process's memory footprint the measurement tests read, as macOS and Linux account it.

/// The process's footprint: the memory the process itself holds now and at its peak, mapped file
/// pages left out (macOS's physical footprint; on Linux its resident anonymous and shared memory
/// and its swapped-out pages), with the `footprint` tool's line for it, or why there is none.
#[derive(Debug)]
pub struct ProcessFootprint {
    /// The bytes charged now.
    pub current_bytes: u64,
    /// The most bytes charged since the process began on macOS, and since the process's first
    /// footprint reading on Linux.
    pub peak_bytes: u64,
    /// The `footprint` tool's line for the process, or why it gave none.
    pub tool_line: String,
}
