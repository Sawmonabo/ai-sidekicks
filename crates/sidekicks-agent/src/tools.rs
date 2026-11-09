//! The shared tool server's provider-independent part: the tool contracts, discovery, registration,
//! the MCP server and the listener a provider's process reaches. A tool registers here from the
//! crate above this one that implements it: the shell tools from the shell crate, and a tool that
//! calls queue or session from a crate above those.

mod admission;
pub mod entries;
pub mod gate;
pub mod group;
pub mod listener;
pub mod server;
pub mod session;
