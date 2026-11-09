//! Providers: the driver interface and the table of providers, a driver's reports and requests to
//! the run engine and the ports it reaches the daemon through, a run's execution posture,
//! background work, the record of each provider's builds, what the daemon keeps per provider
//! account, each provider's command in each place it runs, the code every provider shares, and
//! each provider's own driver. It sits over std, store, ipc, workspace and policy and is taken by
//! mcp, shell, session, approval, queue, artifact, recovery and the program.

pub mod account;
pub mod background_work;
pub mod bearer_token;
#[cfg(test)]
pub(crate) mod bounded_poll;
pub mod build_record;
pub mod callback_tools;
pub mod capability;
#[cfg(any(test, feature = "test-support"))]
pub mod captured_logs;
pub(crate) mod child_ending;
pub mod command;
pub mod command_search;
pub mod compaction_wait;
pub(crate) mod crash_window;
pub(crate) mod declared_output_speed;
pub mod driver;
pub(crate) mod event_disposition;
pub mod hand_over;
pub mod inbound_json;
pub mod installation;
pub mod left_conversations;
pub(crate) mod lenient_json;
pub mod mcp;
pub(crate) mod outbound_text;
pub(crate) mod output_validation;
pub mod port;
pub mod pricing;
pub mod process_exit;
pub mod process_identity;
pub mod process_registry;
pub(crate) mod project_rule_folders;
pub mod record_readers;
pub mod run;
pub mod runtime_binding;
pub mod service_log;
pub mod spawn_environment;
pub(crate) mod spawned_version;
pub(crate) mod standing_rule_id;
pub(crate) mod terminal_emission_gate;
pub(crate) mod thread_frame_router;
pub mod tool_call_arguments;
pub mod tool_server_name;
pub(crate) mod turn_evidence;
pub mod usage_delta_accountant;
