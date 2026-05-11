//! sidecar-rust-pty library crate.
//!
//! Internal modules are exposed here so integration tests in `tests/` can
//! access them. The binary entry point is `src/main.rs`.
//!
//! Plan-024 Phase 1.

pub mod framing;
pub mod protocol;
pub mod pty_session;
