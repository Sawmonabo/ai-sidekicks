//! The process at the other end of a local connection: how the daemon reads it, the reader over
//! the system's process table, the provider services whose processes it holds connections to, and
//! the check that tells an agent's process from the person's own client.

pub(crate) mod contract;
pub(crate) mod descent;
pub(crate) mod provider_services;
pub(crate) mod system_reader;
