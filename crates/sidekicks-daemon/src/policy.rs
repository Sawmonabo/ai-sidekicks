//! Policy: the authorizer, its rules, shell-line, destructive-git and background-work checks, the
//! asks the daemon answers itself, the execution posture, the permission check every sensitive
//! action passes and the approval seam of the app's own tools.

pub(crate) mod background_work;
pub(crate) mod callback_tool_approvals;
pub(crate) mod execution_posture_service;
pub(crate) mod permission_check;
pub(crate) mod provider_ask_answers;
pub(crate) mod workflow_start;
