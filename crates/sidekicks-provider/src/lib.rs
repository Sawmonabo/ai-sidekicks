//! Providers: the driver interface and the table of providers, a driver's reports and requests to
//! the run engine and the ports it reaches the daemon through, a run's execution posture,
//! background work, the code every provider shares, and each provider's own driver.

pub mod account_homes;
pub mod background_work;
pub mod callback_tools;
pub mod capability;
mod claude;
mod codex;
pub mod command;
pub mod command_search;
pub mod compaction_wait;
pub(crate) mod crash_window;
pub(crate) mod declared_output_speed;
pub mod driver;
pub(crate) mod event_disposition;
pub(crate) mod hand_over;
pub mod inbound_json;
pub mod left_conversations;
pub(crate) mod lenient_json;
pub mod mcp;
pub(crate) mod outbound_text;
pub(crate) mod output_validation;
pub mod port;
pub mod process_identity;
pub mod process_registry;
pub(crate) mod project_rule_folders;
pub mod record_readers;
pub mod run;
pub mod runtime_binding;
pub mod service_log;
pub mod spawn_environment;
pub(crate) mod spawned_version;
pub(crate) mod terminal_emission_gate;
pub(crate) mod thread_frame_router;
pub(crate) mod tool_server_name;
pub(crate) mod turn_evidence;
pub(crate) mod usage_delta_accountant;
