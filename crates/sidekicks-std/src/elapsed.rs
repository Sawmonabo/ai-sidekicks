//! Time measured on the runtime's monotonic clock, as the wire's millisecond figures carry it.

use tokio::time::Instant;

use sidekicks_contracts::wire::integer::{MAX_SAFE_INTEGER, SafeInt};

/// The milliseconds since `started_at`, capped at the largest safe integer; a wall-clock change
/// does not skew it.
pub fn elapsed_ms_since(started_at: Instant) -> SafeInt<0> {
    let elapsed_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    SafeInt::new(elapsed_ms.min(MAX_SAFE_INTEGER))
        .expect("a figure capped at the largest safe integer is one")
}
