//! The per-session append lock. It orders a session's writes and nothing more: a caller holding a
//! session queues its writes before any other caller's on that session. It does not make a read
//! and a later write one step, because an append lets the lock go once its row is queued, before
//! the commit, so a read taken under the lock may miss a queued row; every read that decides a
//! write therefore goes inside that write as a guarded statement, with the row count it expects.
//!
//! - The scope is one session, so a long hold on one session never blocks another.
//! - The lock is process-local. Two daemon processes on one database file are caught only by the
//!   unique sequence constraint, which fails loudly instead of duplicating a sequence.
//! - A producer holding a session appends through the log service's `append_held` with its hold,
//!   so its appends never wait on the lock it already holds.

use std::sync::LazyLock;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

/// The per-session append lock every service over the daemon's database shares. A session id is
/// held as its 16 bytes, so either hex spelling of one id takes one lock.
pub static SESSION_APPEND_LOCK: LazyLock<KeyedLock<SessionId>> = LazyLock::new(KeyedLock::new);

/// A hold on one session's append lock, which code appending on that session takes by reference.
pub type SessionAppendHold = KeyHold<'static, SessionId>;
