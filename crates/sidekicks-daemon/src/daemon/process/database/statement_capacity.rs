//! The read pool's statement capacity: every reading service's prepared set, summed.

use sidekicks_approval::reviewer_denials::REVIEWER_DENIALS_STATEMENT_CAPACITY;
use sidekicks_approval::rules::APPROVAL_RULES_STATEMENT_CAPACITY;
use sidekicks_approval::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;
use sidekicks_artifact::plans::service::PLANS_STATEMENT_CAPACITY;
use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
use sidekicks_mcp::binding::store::MCP_BINDING_STORE_STATEMENT_CAPACITY;
use sidekicks_mcp::client::dispatch::restart_sweep::MCP_RESTART_SWEEP_STATEMENT_CAPACITY;
use sidekicks_mcp::mutation::service::MCP_MUTATION_SERVICE_STATEMENT_CAPACITY;
use sidekicks_mcp::sign_in::admitted_client::MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY;
use sidekicks_mcp::sign_in::sign_out::owed::MCP_OWED_SIGN_OUT_STATEMENT_CAPACITY;
use sidekicks_provider::account::resolver::PROVIDER_ACCOUNTS_STATEMENT_CAPACITY;
use sidekicks_provider::driver::DRIVERS_STATEMENT_CAPACITY;
use sidekicks_provider::driver::capabilities::writer::DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY;
use sidekicks_provider::pricing::held::HELD_REQUEST_REPRICING_STATEMENT_CAPACITY;
use sidekicks_provider::runtime_binding::store::RUNTIME_BINDING_STORE_STATEMENT_CAPACITY;
use sidekicks_queue::provider_session::PROVIDER_SESSIONS_STATEMENT_CAPACITY;
use sidekicks_queue::service::RUN_QUEUE_STATEMENT_CAPACITY;
use sidekicks_recovery::damaged_history::DAMAGED_HISTORY_STATEMENT_CAPACITY;
use sidekicks_recovery::projection_rebuild::PROJECTION_REBUILD_STATEMENT_CAPACITY;
use sidekicks_recovery::restart_settle::RESTART_SETTLE_STATEMENT_CAPACITY;
use sidekicks_recovery::startup::STARTUP_RECOVERY_STATEMENT_CAPACITY;
use sidekicks_recovery::status::RECOVERY_STATUS_STATEMENT_CAPACITY;
use sidekicks_session::agent_tree::lookup::AGENT_TREE_LOOKUP_STATEMENT_CAPACITY;
use sidekicks_session::agent_tree::read::AGENT_TREE_READ_STATEMENT_CAPACITY;
use sidekicks_session::attention::{
    delivery::web_address::sender::WEB_ADDRESS_SENDER_STATEMENT_CAPACITY,
    service::ATTENTION_SERVICE_STATEMENT_CAPACITY,
};
use sidekicks_session::auto_title::SESSION_AUTO_TITLE_STATEMENT_CAPACITY;
use sidekicks_session::changes::SESSION_CHANGES_STATEMENT_CAPACITY;
use sidekicks_session::checkpoints::command_windows::COMMAND_WINDOWS_STATEMENT_CAPACITY;
use sidekicks_session::checkpoints::edits::EDIT_CHECKPOINTS_STATEMENT_CAPACITY;
use sidekicks_session::checkpoints::sweep::CHECKPOINT_SWEEP_STATEMENT_CAPACITY;
use sidekicks_session::conversations::SESSION_CONVERSATIONS_STATEMENT_CAPACITY;
use sidekicks_session::convert::SESSION_CONVERSION_STATEMENT_CAPACITY;
use sidekicks_session::create::SESSION_CREATION_STATEMENT_CAPACITY;
use sidekicks_session::directory::list_feed::rows::SESSION_LIST_ROWS_STATEMENT_CAPACITY;
use sidekicks_session::directory::provider_port::SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY;
use sidekicks_session::directory::run_activity::PROJECT_SESSION_ACTIVITY_STATEMENT_CAPACITY;
use sidekicks_session::draft_store::SESSION_DRAFT_STORE_STATEMENT_CAPACITY;
use sidekicks_session::idle_sleep::IDLE_SLEEP_STATEMENT_CAPACITY;
use sidekicks_session::interventions::service::INTERVENTION_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::links::service::SESSION_LINK_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::questions::service::QUESTION_STATEMENT_CAPACITY;
use sidekicks_session::readings::READINGS_STATEMENT_CAPACITY;
use sidekicks_session::related::ranking::RELATED_RANKING_STATEMENT_CAPACITY;
use sidekicks_session::review_note::store::REVIEW_NOTE_STORE_STATEMENT_CAPACITY;
use sidekicks_session::run::agent::RUN_AGENT_STATEMENT_CAPACITY;
use sidekicks_session::run::binding_cursors::RUN_BINDING_CURSORS_STATEMENT_CAPACITY;
use sidekicks_session::run::checkout::RUN_CHECKOUT_STATEMENT_CAPACITY;
use sidekicks_session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use sidekicks_session::run::folders::SESSION_LIVE_RUN_FOLDERS_STATEMENT_CAPACITY;
use sidekicks_session::run::held_tool_calls::HELD_TOOL_CALLS_STATEMENT_CAPACITY;
use sidekicks_session::run::live_bindings::LIVE_RUN_BINDINGS_STATEMENT_CAPACITY;
use sidekicks_session::run::pause::RUN_PAUSE_STATEMENT_CAPACITY;
use sidekicks_session::run::provider_choice::PROVIDER_CHOICE_STATEMENT_CAPACITY;
use sidekicks_session::run::turn_capture::TURN_CAPTURE_STATEMENT_CAPACITY;
use sidekicks_session::search::files::service::FILE_SEARCH_STATEMENT_CAPACITY;
use sidekicks_session::search::index::outbox::OUTBOX_STATEMENT_CAPACITY;
use sidekicks_session::service::SESSION_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::tags::SESSION_TAG_SERVICE_STATEMENT_CAPACITY;
use sidekicks_session::transcript::turn_attribution::RUN_STANDING_STATEMENT_CAPACITY;
use sidekicks_session::usage_record::USAGE_RECORD_STATEMENT_CAPACITY;
use sidekicks_session::working_folder::SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY;
use sidekicks_store::events::log_service::EVENT_LOG_STATEMENT_CAPACITY;
use sidekicks_store::machine::registry::MACHINE_REGISTRY_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::drafts::WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::kept_values::WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::library::WORKFLOW_LIBRARY_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::store::WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY;
use sidekicks_workflow::definitions::versions::history::WORKFLOW_VERSIONS_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::attention::WORKFLOW_RUN_ATTENTION_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::deletion::WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::step_payload::WORKFLOW_STEP_PAYLOAD_STATEMENT_CAPACITY;
use sidekicks_workflow::runs::store::WORKFLOW_RUN_STORE_STATEMENT_CAPACITY;
use sidekicks_workspace::clone::requests::CLONE_REQUESTS_STATEMENT_CAPACITY;
use sidekicks_workspace::execution_root::EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::folder::usage::REPO_FOLDER_USAGE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::turn_snapshot::service::TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::creation::WORKTREE_CREATOR_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::occupancy::MOUNT_OCCUPANCY_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::removed_store::REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::service::WORKTREE_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::status::WORKTREE_STATUS_READER_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::unfinished_discards::UNFINISHED_DISCARD_STATEMENT_CAPACITY;
use sidekicks_workspace::git::worktree::watch::WORKING_FOLDER_WATCH_STATEMENT_CAPACITY;
use sidekicks_workspace::project::records::PROJECT_RECORDS_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::health::REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::reattach::REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::mount::service::REPO_MOUNT_SERVICE_STATEMENT_CAPACITY;
use sidekicks_workspace::{
    run_setup_gates::execution_root::EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY,
    service::WORKSPACE_SERVICE_STATEMENT_CAPACITY,
};

use crate::daemon::backup::run::BACKUP_STATEMENT_CAPACITY;
use crate::daemon::configuration::DAEMON_CONFIGURATION_STATEMENT_CAPACITY;
use crate::daemon::retention_methods::RETENTION_STATEMENT_CAPACITY;
use crate::data_acts::purge::rows::SESSION_PURGE_STATEMENT_CAPACITY;
use crate::ipc::handlers::approval::APPROVAL_METHODS_STATEMENT_CAPACITY;
use crate::ipc::handlers::driver::DRIVER_METHODS_STATEMENT_CAPACITY;
use crate::ipc::handlers::session::snapshots::SESSION_SNAPSHOTS_STATEMENT_CAPACITY;

/// The statements each read connection keeps prepared: every reading service's set, summed, so a
/// statement stays prepared on whichever connection a read borrows. A statement another set in the
/// sum already counts is not counted twice: each set counts only the statements no other one holds.
pub(super) const READ_POOL_STATEMENT_CAPACITY: usize = AGENT_TREE_LOOKUP_STATEMENT_CAPACITY
    // The agent tree read's set holds the sweep's, which reads through the same statements.
    + AGENT_TREE_READ_STATEMENT_CAPACITY
    + APPROVAL_METHODS_STATEMENT_CAPACITY
    + APPROVAL_REQUEST_READER_STATEMENT_CAPACITY
    + APPROVAL_RULES_STATEMENT_CAPACITY
    + ARTIFACT_STATEMENT_CAPACITY
    // The attention service's set holds the attention read's.
    + ATTENTION_SERVICE_STATEMENT_CAPACITY
    + BACKUP_STATEMENT_CAPACITY
    + CHECKPOINT_SWEEP_STATEMENT_CAPACITY
    + CLONE_REQUESTS_STATEMENT_CAPACITY
    + COMMAND_WINDOWS_STATEMENT_CAPACITY
    + SESSION_CONVERSATIONS_STATEMENT_CAPACITY
    + DAEMON_CONFIGURATION_STATEMENT_CAPACITY
    + DAMAGED_HISTORY_STATEMENT_CAPACITY
    + DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY
    + DRIVER_METHODS_STATEMENT_CAPACITY
    + DRIVERS_STATEMENT_CAPACITY
    + EDIT_CHECKPOINTS_STATEMENT_CAPACITY
    + EVENT_LOG_STATEMENT_CAPACITY
    + EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY
    + EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY
    + FILE_SEARCH_STATEMENT_CAPACITY
    // The repricing of held requests: its start's key read and its page reads.
    + HELD_REQUEST_REPRICING_STATEMENT_CAPACITY
    + HELD_TOOL_CALLS_STATEMENT_CAPACITY
    + IDLE_SLEEP_STATEMENT_CAPACITY
    + INTERVENTION_SERVICE_STATEMENT_CAPACITY
    + LIVE_RUN_BINDINGS_STATEMENT_CAPACITY
    + MACHINE_REGISTRY_STATEMENT_CAPACITY
    + MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY
    + MCP_BINDING_STORE_STATEMENT_CAPACITY
    + MCP_MUTATION_SERVICE_STATEMENT_CAPACITY
    + MCP_OWED_SIGN_OUT_STATEMENT_CAPACITY
    + MCP_RESTART_SWEEP_STATEMENT_CAPACITY
    + MOUNT_OCCUPANCY_STATEMENT_CAPACITY
    + OUTBOX_STATEMENT_CAPACITY
    + PLANS_STATEMENT_CAPACITY
    + PROJECT_RECORDS_STATEMENT_CAPACITY
    + PROJECT_SESSION_ACTIVITY_STATEMENT_CAPACITY
    + PROJECTION_REBUILD_STATEMENT_CAPACITY
    + PROVIDER_ACCOUNTS_STATEMENT_CAPACITY
    + PROVIDER_CHOICE_STATEMENT_CAPACITY
    + PROVIDER_SESSIONS_STATEMENT_CAPACITY
    + QUESTION_STATEMENT_CAPACITY
    + READINGS_STATEMENT_CAPACITY
    + RECOVERY_STATUS_STATEMENT_CAPACITY
    + RELATED_RANKING_STATEMENT_CAPACITY
    + REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY
    + REPO_FOLDER_USAGE_STATEMENT_CAPACITY
    + REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY
    + REPO_MOUNT_REATTACH_SERVICE_STATEMENT_CAPACITY
    + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY
    + RESTART_SETTLE_STATEMENT_CAPACITY
    + RETENTION_STATEMENT_CAPACITY
    + REVIEW_NOTE_STORE_STATEMENT_CAPACITY
    + REVIEWER_DENIALS_STATEMENT_CAPACITY
    + RUN_BINDING_CURSORS_STATEMENT_CAPACITY
    + RUN_ENGINE_STATEMENT_CAPACITY
    + RUN_PAUSE_STATEMENT_CAPACITY
    + RUN_QUEUE_STATEMENT_CAPACITY
    + RUNTIME_BINDING_STORE_STATEMENT_CAPACITY
    + SESSION_AUTO_TITLE_STATEMENT_CAPACITY
    + SESSION_CHANGES_STATEMENT_CAPACITY
    + SESSION_CONVERSION_STATEMENT_CAPACITY
    + SESSION_CREATION_STATEMENT_CAPACITY
    + SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY
    + SESSION_DRAFT_STORE_STATEMENT_CAPACITY
    + SESSION_LINK_SERVICE_STATEMENT_CAPACITY
    + SESSION_LIST_ROWS_STATEMENT_CAPACITY
    + SESSION_LIVE_RUN_FOLDERS_STATEMENT_CAPACITY
    + SESSION_PURGE_STATEMENT_CAPACITY
    + SESSION_SERVICE_STATEMENT_CAPACITY
    + SESSION_SNAPSHOTS_STATEMENT_CAPACITY
    + SESSION_TAG_SERVICE_STATEMENT_CAPACITY
    + SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY
    + STARTUP_RECOVERY_STATEMENT_CAPACITY
    + TURN_CAPTURE_STATEMENT_CAPACITY
    + TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY
    + UNFINISHED_DISCARD_STATEMENT_CAPACITY
    + USAGE_RECORD_STATEMENT_CAPACITY
    + WEB_ADDRESS_SENDER_STATEMENT_CAPACITY
    + WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY
    + WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY
    + WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY
    + WORKFLOW_LIBRARY_STATEMENT_CAPACITY
    + WORKFLOW_RUN_ATTENTION_STATEMENT_CAPACITY
    + WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY
    + WORKFLOW_RUN_STORE_STATEMENT_CAPACITY
    + WORKFLOW_STEP_PAYLOAD_STATEMENT_CAPACITY
    + WORKFLOW_VERSIONS_STATEMENT_CAPACITY
    + WORKING_FOLDER_WATCH_STATEMENT_CAPACITY
    + WORKSPACE_SERVICE_STATEMENT_CAPACITY
    + WORKTREE_CREATOR_STATEMENT_CAPACITY
    + WORKTREE_SERVICE_STATEMENT_CAPACITY
    + WORKTREE_STATUS_READER_STATEMENT_CAPACITY
    // The reviewer denials', the run engine's, the live run folders' and the agent tree read's
    // sets each hold the run agent reader's, which is counted once.
    - 3 * RUN_AGENT_STATEMENT_CAPACITY
    // The session service's, the run engine's, the binding cursors', the turn capture's, the event
    // log's and the usage record's sets each hold the read of where a run stands, which is counted
    // once.
    - 5 * RUN_STANDING_STATEMENT_CAPACITY
    // The turn capture's and the command windows' sets each hold the read of a run's checkout,
    // which is counted once.
    - RUN_CHECKOUT_STATEMENT_CAPACITY;
