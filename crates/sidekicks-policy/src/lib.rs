//! The rules: the shell-line checks and the bound on reading a line, the destructive-git check, the
//! read-only command check, the Cedar authorizer with its built-in rules, the workflow start rule,
//! and the vocabulary of the ask rules a person sets. It sits over no other daemon crate and is
//! taken by provider, workflow, approval and the program.

pub mod ask_rule;
pub mod authorizer;
pub mod destructive_git;
pub mod read_only_command;
pub mod shell_commands;
pub mod workflow_start;
