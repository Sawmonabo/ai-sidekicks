use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::task::{Context, Wake, Waker};

use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;

use super::{CodexSessionInbound, QueueDepth, codex_session_inbound};
use crate::driver::test_registry::new_session_id;

// A reader the send wakes, which takes the item at once and records the depth it reads then.
struct TakingReader {
    receiver: Mutex<mpsc::UnboundedReceiver<CodexSessionInbound>>,
    depth: Arc<QueueDepth>,
    depth_at_take: Mutex<Option<usize>>,
}

impl Wake for TakingReader {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if lock(&self.receiver).try_recv().is_ok() {
            *lock(&self.depth_at_take) = Some(self.depth.items.load(Ordering::Relaxed));
        }
    }
}

// An item is counted before it is sent, so a reader that takes it the moment the send wakes it
// reads it counted and its count down never runs first. Killed by sending before counting (the
// reader reads a depth of 0).
#[test]
fn a_reader_taking_an_item_at_its_send_reads_it_counted() {
    let (sender, receiver) = codex_session_inbound(new_session_id());
    let reader = Arc::new(TakingReader {
        receiver: Mutex::new(receiver.receiver),
        depth: receiver.depth,
        depth_at_take: Mutex::new(None),
    });
    let waker = Waker::from(Arc::clone(&reader));
    assert!(
        lock(&reader.receiver)
            .poll_recv(&mut Context::from_waker(&waker))
            .is_pending(),
        "the reader waits on an empty queue"
    );

    assert!(sender.push(CodexSessionInbound::HeldThread {
        thread_id: "thread".to_owned(),
        is_held: true,
    }));

    assert_eq!(*lock(&reader.depth_at_take), Some(1));
}
