//! The daemon's connections to its database: the setup every one of them holds, the writer's own
//! open, which creates the schema, and the one pool of read-only connections every reading service
//! shares.

pub mod read_pool;
pub mod setup;
pub mod writer_open;
