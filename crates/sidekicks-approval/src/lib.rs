//! Approvals: the permission check every sensitive action passes, permission asks and the rules
//! that answer them, the asks the daemon answers itself, the approval seam of the app's own tools,
//! the check a workflow start passes, reviewer denials, the runs an ask blocks, and the approval
//! service with its store and projection. It sits over std, store, ipc, workspace, policy, provider
//! and session and is taken by recovery and the program.

pub(crate) mod ask_description;
pub(crate) mod callback_tool_approvals;
pub(crate) mod events;
pub mod permission_asks;
pub mod permission_check;
pub mod projection;
pub(crate) mod provider_ask_answers;
pub(crate) mod refusals;
pub mod request_create;
pub mod reviewer_denials;
pub mod rules;
pub mod run_blocking;
pub mod schema;
pub mod service;
pub mod store;
pub(crate) mod workflow_start;
