//! Primitives with no daemon concept, any program could use: keyed locks and waits, settling and
//! retrying, bounded waits and reads, a UTF-8 stream, a text cut, random hex, error descriptions,
//! the crash-safe file writes, the helper-mode child and the scheduler with its busy gate.

pub mod bounded_wait;
pub mod cleanup_failures;
pub mod elapsed;
pub mod error_description;
pub mod file;
pub mod helper_mode;
pub mod keyed_lock;
pub mod keyed_wait;
pub mod missing_entry;
pub mod mutex_lock;
#[cfg(any(test, feature = "test-support"))]
pub mod pause_point;
pub mod process_exit;
pub mod processor_bound;
pub mod random_hex;
pub mod retry;
pub mod scheduler;
pub mod settle_all;
pub mod standard_error;
pub mod text_cut;
pub mod utf8_stream;
