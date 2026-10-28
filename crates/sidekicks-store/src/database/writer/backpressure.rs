//! The write queue's backpressure warning: the queue checks its depth as it admits each write, and
//! the first time the depth reaches the warning mark it writes a `persistence_backpressure` line to
//! the service log, naming the write's session and category. It warns again only once the depth
//! has fallen below half that mark, so a queue hovering at the mark warns once rather than at every
//! batch.

use crate::database::writer::WRITE_QUEUE_CAPACITY;
use crate::database::writer::messages::WriteJob;

/// The depth, in entries queued, in flight and waiting past the cap, at which the queue warns:
/// 80% of its cap, well before a write has to wait.
const WARNING_DEPTH: usize = 8_000;

/// The depth below which a queue that warned may warn again: half the warning mark.
const REARM_DEPTH: usize = WARNING_DEPTH / 2;

/// Whether the queue has warned since its depth last fell below [`REARM_DEPTH`].
#[derive(Default)]
pub(super) struct BackpressureAlert {
    has_warned: bool,
}

impl BackpressureAlert {
    /// Checks the queue's depth as `write` is taken: `depth` before it, `size` its own entries.
    /// Re-arms when the depth before it has fallen below the re-arm mark, and warns once when the
    /// write takes the depth to the warning mark.
    pub(super) fn check_admission(&mut self, depth: usize, size: usize, write: &WriteJob) {
        if self.has_warned && depth < REARM_DEPTH {
            self.has_warned = false;
        }
        let depth = depth + size;
        if self.has_warned || depth < WARNING_DEPTH {
            return;
        }
        self.has_warned = true;
        let event = write.events.last().map(|row| &row.envelope);
        tracing::warn!(
            session_id = event.map(|event| tracing::field::display(event.session_id())),
            event_category = event.map(|event| event.category().as_str()),
            depth,
            capacity = WRITE_QUEUE_CAPACITY,
            "persistence_backpressure: the write queue is nearly full"
        );
    }
}
