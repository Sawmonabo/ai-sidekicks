//! Providers: the drivers that run each provider's agent, their capabilities, hand-over and the
//! searches a provider needs.

pub(crate) mod compaction_wait;
mod driver;
mod operating_system;
pub(crate) mod outbound_text;
pub(crate) mod port;
pub(crate) mod record_readers;
pub(crate) mod tool_server_name;
pub(crate) mod turn_evidence;
