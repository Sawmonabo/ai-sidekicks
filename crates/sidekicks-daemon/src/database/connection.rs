//! The daemon's connections to its database: the setup every one of them holds, and the one pool
//! of read-only connections every reading service shares.

pub(crate) mod read_pool;
pub(crate) mod setup;
