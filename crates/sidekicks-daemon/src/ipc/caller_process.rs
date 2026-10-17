//! The process at the other end of a local connection: how the daemon reads it, the reader over
//! the system's process table, and the provider services whose processes it holds connections to.

pub(crate) mod contract;
pub(crate) mod provider_services;
pub(crate) mod system_reader;
