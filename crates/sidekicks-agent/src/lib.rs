//! Saved agent definitions, skills, plugins, and the shared tool server's provider-independent
//! part: the tool contracts, discovery, registration and the listener; it takes a session's
//! permission level and recorded links as values. It sits over no other daemon crate and no daemon
//! crate takes it yet.

pub mod definition;
pub mod plugin;
pub mod skill;
pub mod tools;
