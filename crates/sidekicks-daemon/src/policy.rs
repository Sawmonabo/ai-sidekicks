//! Policy: the authorizer, its rules, shell-line, destructive-git and background-work checks, the
//! asks the daemon answers itself and the execution posture.

pub(crate) mod authorizer;
pub(crate) mod background_work;
pub(crate) mod destructive_git;
pub(crate) mod execution_posture_service;
pub(crate) mod provider_ask_answers;
pub(crate) mod shell_commands;
pub(crate) mod workflow_start;
