//! The machine the daemon runs on: its id, owner and name, its two keys for other devices, its
//! registrations, and their tables.

pub mod identity_key;
pub mod local;
pub mod registry;
pub(crate) mod schema;
