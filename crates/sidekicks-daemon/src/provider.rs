//! Providers: the drivers that run each provider's process, their capabilities, hand-over, the
//! shell commands their agents run, and the searches a provider needs.

pub(crate) mod callback_tools;
pub(crate) mod capability;
pub(crate) mod command;
pub(crate) mod command_search;
pub(crate) mod compaction_wait;
pub(crate) mod conversation_purge;
pub(crate) mod declared_output_speed;
pub(crate) mod driver;
pub(crate) mod event_disposition;
pub(crate) mod hand_over;
pub(crate) mod inbound_json;
pub(crate) mod left_conversations;
pub(crate) mod lenient_json;
pub(crate) mod outbound_text;
pub(crate) mod output_validation;
pub(crate) mod port;
pub(crate) mod process_registry;
pub(crate) mod project_rule_folders;
pub(crate) mod record_readers;
pub(crate) mod runtime_binding;
pub(crate) mod service_log;
pub(crate) mod spawn_environment;
pub(crate) mod spawned_version;
pub(crate) mod terminal_emission_gate;
pub(crate) mod thread_frame_router;
pub(crate) mod tool_server_name;
pub(crate) mod turn_evidence;
pub(crate) mod usage_delta_accountant;
