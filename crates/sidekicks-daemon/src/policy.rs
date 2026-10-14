//! Policy: the authorizer, its rules, shell-line and destructive-git checks and the execution
//! posture.

pub(crate) mod authorizer;
pub(crate) mod destructive_git;
pub(crate) mod execution_posture_service;
pub(crate) mod shell_commands;
pub(crate) mod workflow_start;
