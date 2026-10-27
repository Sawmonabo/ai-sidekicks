//! What a failed operation returns once cleaning up after it failed too.

use std::fmt::{self, Display};

use crate::settle_all::DescribeEach;

/// A failure kept whole, so its type and code still reach the caller, beside the failures of
/// cleaning up after it. Its source is the original, whose own source chain stays as it was.
#[derive(Debug, thiserror::Error)]
pub struct CleanupFailures<Original, Cleanup = Original> {
    #[source]
    original: Original,
    /// The cleanups' own failures, each kept whole.
    failures: Vec<Cleanup>,
    operation: &'static str,
}

impl<Original, Cleanup> CleanupFailures<Original, Cleanup> {
    /// `original` carrying `cleanup_failures`, each kept whole; with none, it reads as `original`
    /// alone. `operation` names what failed, as a log line says it.
    pub fn new(
        original: Original,
        cleanup_failures: Vec<Cleanup>,
        operation: &'static str,
    ) -> Self {
        Self {
            original,
            failures: cleanup_failures,
            operation,
        }
    }

    /// The failure the operation itself ended with.
    pub fn original(&self) -> &Original {
        &self.original
    }

    /// The failures of cleaning up after it, in the order they came; empty when cleanup succeeded.
    pub fn cleanup_failures(&self) -> &[Cleanup] {
        &self.failures
    }

    /// The original, and the cleanups' failures with the operation they cleaned up after.
    pub fn into_parts(self) -> (Original, Vec<Cleanup>, &'static str) {
        (self.original, self.failures, self.operation)
    }
}

impl<Original: Display, Cleanup: Display> Display for CleanupFailures<Original, Cleanup> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.original)?;
        if self.failures.is_empty() {
            return Ok(());
        }
        write!(
            formatter,
            "; cleaning up after {} failed too: {}",
            self.operation,
            DescribeEach(&self.failures)
        )
    }
}
