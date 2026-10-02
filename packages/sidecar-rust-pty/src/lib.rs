//! The sidecar's modules, shared by the binary (`src/main.rs`) and the integration tests in
//! `tests/`.

pub mod framing;
pub mod protocol;
pub mod pty_session;

// Windows-only modules, each also gated by a module-level `#![cfg(target_os = "windows")]`.
#[cfg(target_os = "windows")]
pub mod kill_translation;
#[cfg(target_os = "windows")]
pub mod tree_kill;
#[cfg(target_os = "windows")]
pub mod wsl_pass_through;
