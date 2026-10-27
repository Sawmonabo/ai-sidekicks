//! Saved agent definitions, skills, plugins, and the shared tool server's provider-independent
//! part: the tool contracts, discovery, registration and the listener. It sits below session,
//! whose spawn reads it, and takes a session's permission level and recorded links as values; a
//! tool that calls queue or session registers into the server from above, as the browser and
//! shell tools do.

pub mod definition;
pub mod plugin;
pub mod skill;
pub mod tools;
