//! A capture for tests whose opens settle as the test says and whose calls the test reads, for
//! every leg that opens a window.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{mpsc, watch};

use super::{
    CommandCapture, CommandWindowEnd, CommandWindowId, CommandWindowOpenError, CommandWindowStart,
};

/// A call a test's capture was handed, its window named by its open's ordinal, from 1.
#[derive(Debug, PartialEq, Eq)]
pub enum CaptureCall {
    /// A window was asked to open.
    Open(usize),
    /// The window's command began, covered or not.
    Began(usize, bool),
    /// The window was closed as its command ended.
    Close(usize, CommandWindowEnd),
    /// A command that ran with no window was recorded as run uncovered.
    Uncovered(CommandWindowStart),
}

/// A capture whose opens settle as the test sets `opens`: held while it reads `None`, then each
/// opened or failed as it reads; each call is handed to the test, each window named by its open's
/// ordinal.
struct HeldCapture {
    opens: watch::Receiver<Option<bool>>,
    calls: mpsc::UnboundedSender<CaptureCall>,
    /// How many opens it was asked.
    opened: AtomicUsize,
    /// Each start it was asked to open, in order.
    starts: Arc<Mutex<Vec<CommandWindowStart>>>,
}

impl CommandCapture for HeldCapture {
    fn open_window(
        &self,
        start: CommandWindowStart,
    ) -> BoxFuture<'_, Result<CommandWindowId, CommandWindowOpenError>> {
        lock(&self.starts).push(start);
        let mut opens = self.opens.clone();
        let window = self.opened.fetch_add(1, Ordering::SeqCst) + 1;
        // A call after the test ended, the close of a window it left open, reaches no one.
        self.calls
            .send(CaptureCall::Open(window))
            .unwrap_or_default();
        async move {
            let opened = *opens
                .wait_for(Option::is_some)
                .await
                .expect("the test holds the opens");
            if opened == Some(true) {
                Ok(CommandWindowId::new(window.to_string()))
            } else {
                Err(CommandWindowOpenError::CaptureFailed(
                    "the test failed it".into(),
                ))
            }
        }
        .boxed()
    }

    fn command_began(&self, window: &CommandWindowId, is_covered: bool) -> BoxFuture<'_, ()> {
        let window = window.as_str().parse().expect("an open's ordinal");
        self.calls
            .send(CaptureCall::Began(window, is_covered))
            .unwrap_or_default();
        async {}.boxed()
    }

    fn close_window(&self, window: CommandWindowId, end: CommandWindowEnd) -> BoxFuture<'_, ()> {
        let window = window.as_str().parse().expect("an open's ordinal");
        self.calls
            .send(CaptureCall::Close(window, end))
            .unwrap_or_default();
        async {}.boxed()
    }

    fn record_uncovered_command(&self, start: CommandWindowStart) -> BoxFuture<'_, ()> {
        self.calls
            .send(CaptureCall::Uncovered(start))
            .unwrap_or_default();
        async {}.boxed()
    }
}

// A test capture's registration, as a leg takes it.
type CaptureRegistration = Arc<PortRegistration<Arc<dyn CommandCapture>>>;

/// A capture registration nothing registered, so a leg opens no window.
pub fn unregistered_capture() -> CaptureRegistration {
    Arc::new(PortRegistration::new("command capture"))
}

/// A registered capture whose opens settle as `opens` sets them, held while it reads `None`, and
/// whose calls arrive on the receiver.
pub fn held_capture(
    opens: watch::Receiver<Option<bool>>,
) -> (CaptureRegistration, mpsc::UnboundedReceiver<CaptureCall>) {
    let (capture, called, _starts) = held_capture_with_starts(opens);
    (capture, called)
}

/// A capture as [`held_capture`] makes it, which also keeps each start it is asked to open, in
/// order, in the list it answers third.
pub fn held_capture_with_starts(
    opens: watch::Receiver<Option<bool>>,
) -> (
    CaptureRegistration,
    mpsc::UnboundedReceiver<CaptureCall>,
    Arc<Mutex<Vec<CommandWindowStart>>>,
) {
    let capture = unregistered_capture();
    let (called, starts) = register_held_capture(&capture, opens);
    (capture, called, starts)
}

/// Registers into `capture`, a registration the caller holds, a capture whose opens settle as
/// `opens` sets them; answers the receiver its calls arrive on and the list of the starts it is
/// asked to open, in order. Panics when `capture` is already registered.
pub fn register_held_capture(
    capture: &PortRegistration<Arc<dyn CommandCapture>>,
    opens: watch::Receiver<Option<bool>>,
) -> (
    mpsc::UnboundedReceiver<CaptureCall>,
    Arc<Mutex<Vec<CommandWindowStart>>>,
) {
    let (calls, called) = mpsc::unbounded_channel();
    let starts = Arc::default();
    capture
        .register(Arc::new(HeldCapture {
            opens,
            calls,
            opened: AtomicUsize::new(0),
            starts: Arc::clone(&starts),
        }))
        .expect("the capture registers once");
    (called, starts)
}

/// The next call `called` takes; panics when none comes within 5 s.
pub async fn next_call(called: &mut mpsc::UnboundedReceiver<CaptureCall>) -> CaptureCall {
    tokio::time::timeout(Duration::from_secs(5), called.recv())
        .await
        .expect("a call comes")
        .expect("the capture stays")
}

/// Panics, naming `what`, unless `called` takes no call for 200 ms.
pub async fn no_call(called: &mut mpsc::UnboundedReceiver<CaptureCall>, what: &str) {
    let call = tokio::time::timeout(Duration::from_millis(200), called.recv()).await;
    // A closed channel is no call: the capture was handed away, not called.
    assert!(!matches!(call, Ok(Some(_))), "{what}: {call:?}");
}
