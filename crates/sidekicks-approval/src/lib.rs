//! Approvals: the permission check every sensitive action passes, permission asks and the rules
//! that answer them, the asks the daemon answers itself, the approval seam of the app's own tools,
//! the check a workflow start passes, reviewer denials, the runs an ask blocks, the answers kept
//! while no live call held their card, the approval service with its store and projection, and a
//! workflow gate's card, held by its workflow wait. It sits over std, store, ipc, workspace,
//! policy, workflow, provider and session and is taken by recovery and the program.

pub(crate) mod ask_description;
pub(crate) mod callback_tool_approvals;
pub(crate) mod events;
pub mod orphaned_answers;
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
pub mod workflow_gate;
