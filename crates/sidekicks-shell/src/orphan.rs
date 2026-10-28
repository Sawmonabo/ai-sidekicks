//! The defense against terminal children that outlive the daemon: a durable registry of every
//! child started and not yet seen to end, swept at the next start, and the guard the terminal
//! table reports each child's life to.

pub mod guard;
pub(crate) mod nonce_search;
pub(crate) mod registry;
pub(crate) mod sweep;
