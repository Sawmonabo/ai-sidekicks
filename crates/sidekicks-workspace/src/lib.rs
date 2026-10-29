//! Workspaces: projects, repositories and their clones, git and its worktrees, the managed write
//! watch, the one file watch every owner shares, a session's working folder and the gates a run
//! passes before its provider starts. It sits over std, store and ipc and is taken by workflow,
//! provider, shell, session, approval, artifact and the program.

pub mod askpass_prompt;
pub mod clone;
pub(crate) mod errors;
pub mod event_emitter;
pub mod execution_root;
pub(crate) mod file_watch;
pub mod folder;
pub mod git;
pub(crate) mod last_error;
pub mod machine_settings;
pub mod managed;
pub mod project;
pub(crate) mod projector;
pub mod repo;
pub mod row_guards;
pub mod run_setup_gates;
pub mod schema;
pub mod service;
#[cfg(any(test, feature = "test-support"))]
pub mod test_rows;
pub mod trust_envelope;
pub mod working_folder;
