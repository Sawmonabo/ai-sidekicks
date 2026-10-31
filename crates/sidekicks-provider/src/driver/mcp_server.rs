//! The MCP servers a provider declares and runs: the read of their declarations, the strip of a
//! declared address, and each session leg's status readings.

pub(crate) mod address;
pub mod read;
pub mod status;
