//! What a test's thread logs, captured as text so the test can check no line carries a secret.

use std::io::Write;
use std::sync::{Arc, Mutex};

use tracing::subscriber::DefaultGuard;
use tracing_subscriber::layer::SubscriberExt as _;

/// Every line logged on the test's thread while its guard lives, tasks a current-thread runtime
/// runs there included.
#[derive(Clone, Default)]
pub struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

impl CapturedLogs {
    /// Starts capturing the thread's log, until the guard drops.
    pub fn start() -> (Self, DefaultGuard) {
        let logs = Self::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(move || writer.clone())
                .with_ansi(false),
        );
        (logs, tracing::subscriber::set_default(subscriber))
    }

    /// The text logged so far.
    pub fn text(&self) -> String {
        String::from_utf8(self.0.lock().expect("the capture is not poisoned").clone())
            .expect("the log is text")
    }
}

impl Write for CapturedLogs {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("the capture is not poisoned")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
