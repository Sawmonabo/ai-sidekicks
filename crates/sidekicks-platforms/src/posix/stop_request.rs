//! The daemon's stop request on macOS and Linux: SIGTERM, which a supervisor and the system's
//! shutdown send, and SIGINT, the terminal's Ctrl-C, each heard through tokio's signal driver.

use std::io;

use tokio::signal::unix::{Signal, SignalKind, signal};

/// The stop request the daemon's start watches and its stop answers, held from
/// [`StopRequest::listen`] for the daemon's whole life, so neither signal ends it before its stop
/// has run.
#[derive(Debug)]
pub struct StopRequest {
    terminate: Signal,
    interrupt: Signal,
}

impl StopRequest {
    /// Starts listening for SIGTERM and SIGINT, from inside a tokio runtime. Fails when a handler
    /// cannot be installed.
    pub fn listen() -> io::Result<Self> {
        Ok(Self {
            terminate: signal(SignalKind::terminate())?,
            interrupt: signal(SignalKind::interrupt())?,
        })
    }

    /// Waits for the next stop request; also answers once the runtime is shutting down, when no
    /// signal can arrive any more.
    pub async fn requested(&mut self) {
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = self.interrupt.recv() => {}
        }
    }
}
