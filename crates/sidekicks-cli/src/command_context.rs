//! The output streams one run of the command line writes to: the real process streams in `main`,
//! buffers in a test. A command's result goes to `stdout`; every diagnostic goes to `stderr`.

use std::io::Write;

/// The two streams a run writes to, and whether each shows terminal styles.
pub(crate) struct CommandContext<Output: Write, ErrorOutput: Write> {
    /// Where a command's result goes, written only once the command can no longer fail.
    pub(crate) stdout: Output,
    /// Where every refusal and failure goes.
    pub(crate) stderr: ErrorOutput,
    /// Whether text written to `stdout` may carry terminal styles.
    pub(crate) is_stdout_styled: bool,
    /// Whether text written to `stderr` may carry terminal styles.
    pub(crate) is_stderr_styled: bool,
}
