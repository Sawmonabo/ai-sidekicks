//! Callback tools: the daemon-side host every provider's callback-tool calls reach through the
//! `sidekicks` tool route, and each spawn's binding to it.

pub(crate) mod host;
pub(crate) mod spawn_binding;
