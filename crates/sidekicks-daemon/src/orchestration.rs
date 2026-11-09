//! Orchestration: the move of a provider's running sessions onto the account made its current one,
//! the acceptance of a switch of one agent's provider binding, what both switches settle with, the
//! setting and clearing of a session's goal, and the directory of sessions the session tools name.

pub(crate) mod account_switch;
pub(crate) mod binding_switch;
pub(crate) mod goal_service;
pub(crate) mod provider_switch;
pub(crate) mod session_directory;
