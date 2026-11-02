//! The process at the other end of a local connection: how the daemon reads it, the reader over
//! the system's process table, the provider services whose processes it holds connections to, the
//! check that tells an agent's process from the person's own client, and the chain that tells a
//! provider's hook running the daemon's own program.

pub mod contract;
pub mod descent;
mod provider_hook;
pub mod provider_services;
pub mod system_reader;
