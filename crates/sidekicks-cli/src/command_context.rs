//! The output streams one run of the command line writes to: the real process streams in `main`,
//! buffers in a test. A command's result goes to `stdout`; every diagnostic goes to `stderr`.

use std::io::Write;

/// The two streams a run writes to.
pub(crate) struct CommandContext<Out: Write, Err: Write> {
    /// Where a command's result goes, written only once the command can no longer fail.
    pub(crate) stdout: Out,
    /// Where every refusal and failure goes.
    pub(crate) stderr: Err,
}
