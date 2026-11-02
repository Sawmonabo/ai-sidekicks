//! The MCP servers a provider declares and runs: the read of their declarations, the strip of a
//! declared address, each session leg's status readings, and the folder a sign-in through a
//! provider's own client runs in.

pub(crate) mod address;
pub mod read;
pub(crate) mod sign_in_folder;
pub mod status;
