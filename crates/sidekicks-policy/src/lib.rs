//! The rules: the shell-line checks and the bound on reading a line, the destructive-git check, the
//! Cedar authorizer with its built-in rules, and the vocabulary of the ask rules a person sets. It
//! sits over the contracts alone and below provider and approval.

pub mod ask_rule;
pub mod authorizer;
pub mod destructive_git;
pub mod shell_commands;
