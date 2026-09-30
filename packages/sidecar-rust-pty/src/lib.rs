//! Library crate exposing the sidecar's modules so the integration tests in `tests/` can use them.
//! The binary entry point is `src/main.rs`.

pub mod framing;
pub mod protocol;
pub mod pty_session;
