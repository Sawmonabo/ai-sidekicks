//! Sidecar runtime — Plan-024 Phase 1 scaffold.
//!
//! T-024-1-2 lands Content-Length framing in `src/framing.rs`.
//! T-024-1-3 lands serde-bound protocol types in `src/protocol.rs`.
//! T-024-1-4 lands per-session PTY holder in `src/pty_session.rs`.
//! T-024-1-5 lands the spawn smoke integration test.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Dispatcher will be wired up incrementally across T-024-1-2/3/4.
    // The shape: stdin -> framing::read_frame -> kind-discriminant match -> handler return -> framing::write_frame -> stdout.
    todo!("dispatcher loop wires up after T-024-1-2 (framing) + T-024-1-3 (protocol) + T-024-1-4 (pty_session)")
}
