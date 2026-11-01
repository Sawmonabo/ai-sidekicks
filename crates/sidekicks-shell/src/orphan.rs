//! The defense against the daemon's children that outlive it: a durable registry of every
//! child started and not yet seen to end, swept at the next start, and the guard the terminal
//! table and the provider drivers report each child's life to.

pub mod guard;
pub(crate) mod nonce_search;
pub(crate) mod registry;
pub(crate) mod sweep;
