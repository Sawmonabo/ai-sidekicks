//! Saved agent definitions, skills, plugins, and the shared tool server's provider-independent
//! part: the tool contracts, discovery, registration and the listener. It sits over provider and
//! below mcp, shell and session, so a shell tool registers into the server from the shell crate
//! and session's spawn reads it; it takes a session's permission level and recorded links as
//! values, and a tool that calls queue or session registers from above, as the browser tools do.

pub mod definition;
pub mod plugin;
pub mod skill;
pub mod tools;
