//! The MCP servers a provider declares and runs: the read of their declarations, the strip and
//! fold of a declared address, each session leg's status readings, the folder a sign-in through a
//! provider's own client runs in, and the write of a declaration and what the provider holds before
//! and after it; what one working server of a session offers to attach; and when a session's own
//! switch of its servers reaches the provider.

pub mod address;
pub mod read;
pub mod resources;
pub mod session_switch;
pub(crate) mod sign_in_folder;
pub mod status;
pub mod write;
