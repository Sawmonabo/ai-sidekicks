//! Sidecar runtime — Plan-024 Phase 1 scaffold.
//!
//! T-024-1-2 lands Content-Length framing in `src/framing.rs`.
//! T-024-1-3 lands serde-bound protocol types in `src/protocol.rs`.
//! T-024-1-4 lands per-session PTY holder in `src/pty_session.rs`.
//! T-024-1-5 lands the spawn smoke integration test.
//!
//! The dispatcher loop body — stdin → `framing::read_frame` →
//! kind-discriminant match → handler return → `framing::write_frame` →
//! stdout — is intentionally deferred past Phase 1. Phase 1 ships the
//! library substrate (`framing` / `protocol` / `pty_session`) consumed
//! directly by the integration tests in `tests/`; the binary's stdio
//! dispatcher lands when the daemon-side `RustSidecarPtyHost` (Phase 3
//! T-024-3-1) is wired and the sidecar must be driven over a real
//! stdio pipe.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    todo!("dispatcher loop body lands in Phase 2+ (see module rustdoc); Phase 1 ships only the library substrate")
}
