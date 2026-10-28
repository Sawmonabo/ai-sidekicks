//! Deadlines kept on the wall clock by one thread of the process, `wall-clock deadlines`, started
//! on first use and parked while none is due. A tokio timer follows a test's paused clock, which
//! jumps whenever the runtime idles and so would fire a deadline while work on another thread is
//! still under way; this thread reads only the system's clock. It is no task of tokio's blocking
//! pool, so it holds no pool thread and the runtime's stop never waits on it.

use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::collections::binary_heap::PeekMut;
use std::io;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crate::mutex_lock::lock;

static DEADLINES: Mutex<Deadlines> = Mutex::new(Deadlines {
    due: BinaryHeap::new(),
    next_id: 0,
    is_thread_started: false,
});

// Woken when a deadline is set, so the thread waits for the earliest one again.
static DEADLINE_SET: Condvar = Condvar::new();

// Every deadline not yet passed or dropped, earliest first, and whether the thread runs.
struct Deadlines {
    due: BinaryHeap<Reverse<DueDeadline>>,
    next_id: u64,
    is_thread_started: bool,
}

// One deadline: when it passes, its id, and where its passing is answered. Ordered by the instant,
// then the id, so two deadlines never compare equal.
struct DueDeadline {
    at: Instant,
    id: u64,
    passed: oneshot::Sender<()>,
}

impl PartialEq for DueDeadline {
    fn eq(&self, other: &Self) -> bool {
        (self.at, self.id) == (other.at, other.id)
    }
}

impl Eq for DueDeadline {}

impl PartialOrd for DueDeadline {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DueDeadline {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.at, self.id).cmp(&(other.at, other.id))
    }
}

/// A deadline set by [`deadline_after`], removed when dropped, so one no longer waited for leaves
/// nothing behind.
pub(crate) struct Deadline {
    id: u64,
}

impl Drop for Deadline {
    fn drop(&mut self) {
        lock(&DEADLINES)
            .due
            .retain(|Reverse(due)| due.id != self.id);
    }
}

/// Sets a deadline `wait` of wall-clock time from now: the receiver answers once it passes, while
/// the returned [`Deadline`] is held. Fails when the deadlines' thread cannot start.
pub(crate) fn deadline_after(wait: Duration) -> io::Result<(Deadline, oneshot::Receiver<()>)> {
    let (passed, passed_received) = oneshot::channel();
    let at = Instant::now() + wait;
    let mut deadlines = lock(&DEADLINES);
    if !deadlines.is_thread_started {
        std::thread::Builder::new()
            .name("wall-clock deadlines".to_owned())
            .spawn(keep_deadlines)?;
        deadlines.is_thread_started = true;
    }
    let id = deadlines.next_id;
    deadlines.next_id += 1;
    deadlines.due.push(Reverse(DueDeadline { at, id, passed }));
    drop(deadlines);
    DEADLINE_SET.notify_one();
    Ok((Deadline { id }, passed_received))
}

// The deadlines' thread: answers each deadline as it passes and sleeps until the earliest one left,
// or until one is set while none is.
fn keep_deadlines() {
    let mut deadlines = lock(&DEADLINES);
    loop {
        let now = Instant::now();
        while let Some(earliest) = deadlines.due.peek_mut()
            && earliest.0.at <= now
        {
            let Reverse(due) = PeekMut::pop(earliest);
            // A caller that stopped waiting no longer listens; the answer is dropped.
            due.passed.send(()).unwrap_or_default();
        }
        let earliest_at = deadlines.due.peek().map(|Reverse(due)| due.at);
        deadlines = match earliest_at {
            Some(at) => {
                DEADLINE_SET
                    .wait_timeout(deadlines, at.saturating_duration_since(now))
                    .unwrap_or_else(PoisonError::into_inner)
                    .0
            }
            None => DEADLINE_SET
                .wait(deadlines)
                .unwrap_or_else(PoisonError::into_inner),
        };
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use tokio::sync::oneshot::error::TryRecvError;

    use super::{DEADLINES, deadline_after};
    use crate::mutex_lock::lock;

    // How many deadlines are set and neither passed nor dropped.
    fn pending_count() -> usize {
        lock(&DEADLINES).due.len()
    }

    // The earliest deadline is answered first whatever order they were set in, one dropped
    // leaves and only it, and the later one stays set. Killed by the heap ordered latest first,
    // by a drop that removes the wrong entries, and by the drop deleted.
    #[tokio::test]
    async fn the_earliest_deadline_answers_first_and_a_dropped_one_leaves() {
        let (long, mut long_passed) =
            deadline_after(Duration::from_secs(10)).expect("the deadline is set");
        let (dropped, _dropped_passed) =
            deadline_after(Duration::from_secs(10)).expect("the deadline is set");
        let (_short, short_passed) =
            deadline_after(Duration::from_millis(50)).expect("the deadline is set");
        let before_drop = pending_count();
        drop(dropped);
        let after_drop = pending_count();
        let started = Instant::now();

        short_passed.await.expect("the short deadline passes");

        let waited = started.elapsed();
        assert!(waited < Duration::from_secs(5), "{waited:?}");
        assert_eq!(long_passed.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(
            (after_drop, pending_count()),
            (before_drop - 1, before_drop - 2)
        );
        drop(long);
        assert_eq!(pending_count(), before_drop - 3);
    }
}
