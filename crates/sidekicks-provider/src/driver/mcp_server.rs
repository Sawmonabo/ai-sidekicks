//! The MCP servers a provider declares and runs: the read of their declarations, the strip of a
//! declared address, each session leg's status readings, the folder a sign-in through a provider's
//! own client runs in, and the write of a declaration and what the provider holds before and after
//! it; and what one working server of a session offers to attach.

pub(crate) mod address;
pub mod read;
pub mod resources;
pub(crate) mod sign_in_folder;
pub mod status;
pub mod write;
