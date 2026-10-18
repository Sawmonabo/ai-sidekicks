//! The output streams one run of the command line writes to: the real process streams in `main`,
//! buffers in a test. A command's result goes to `stdout`; every diagnostic goes to `stderr`.

use std::io::Write;

/// The two streams a run writes to, and whether both are terminals that show styles.
pub(crate) struct CommandContext<Output: Write, ErrorOutput: Write> {
    /// Where a command's result goes, written only once the command can no longer fail.
    pub(crate) stdout: Output,
    /// Where every refusal and failure goes.
    pub(crate) stderr: ErrorOutput,
    /// Whether output may carry terminal styles: true only when both streams are terminals, so no
    /// file or pipe ever receives an escape code.
    pub(crate) is_styled: bool,
}
