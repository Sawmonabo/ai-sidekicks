//! Primitives with no daemon concept, any program could use: keyed locks and waits, settling and
//! retrying, a failure episode's first failure, bounded waits and reads, a UTF-8 stream, a child's
//! output tail, a text cut, random hex, error descriptions, the outbound HTTP client's shared
//! settings, the crash-safe file writes, the helper-mode child and the scheduler with its busy
//! gate. It sits over no other daemon crate and is taken by store, ipc, workspace, provider, mcp,
//! shell, session, approval, queue, artifact, recovery, the program and the terminal crate.

pub mod bounded_wait;
pub mod cleanup_failures;
pub mod elapsed;
pub mod error_description;
pub mod failure_episode;
pub mod file;
pub mod helper_mode;
pub mod keyed_lock;
pub mod keyed_wait;
pub mod missing_entry;
pub mod mutex_lock;
#[cfg(feature = "outbound-http")]
pub mod outbound_http;
pub mod output_tail;
#[cfg(any(test, feature = "test-support"))]
pub mod pause_point;
pub mod port_registration;
pub mod processor_bound;
pub mod random_hex;
pub mod retry;
pub mod scheduler;
pub mod settle_all;
pub mod standard_error;
pub mod text_cut;
pub mod utf8_stream;
pub(crate) mod wall_clock_deadline;
