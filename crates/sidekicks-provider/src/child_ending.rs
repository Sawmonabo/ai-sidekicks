//! A child's end as the daemon asks it: a stop the child can answer, then a kill once a grace
//! passes with the child still running.

use std::io;
use std::pin::Pin;
use std::time::Duration;

use process_wrap::tokio::ChildWrapper;
use sidekicks_platforms::{ChildEnd, ask_child_to_stop};
use tokio::sync::watch;
use tokio::time::{Instant, Sleep};

/// The ends asked of one child, sent to the task that owns it; a kill is never replaced by a stop.
/// Dropped, its owner kills the child.
pub(crate) struct ChildEnds(watch::Sender<Option<ChildEnd>>);

impl ChildEnds {
    /// Nothing asked yet, with the receiver the child's owner reads each end from.
    pub(crate) fn new() -> (Self, watch::Receiver<Option<ChildEnd>>) {
        let (sender, receiver) = watch::channel(None);
        (Self(sender), receiver)
    }

    /// Asks the child to end as `end`; the same end asked again or a stop after a kill changes
    /// nothing.
    pub(crate) fn ask(&self, end: ChildEnd) {
        self.0.send_if_modified(|asked| {
            let is_changed = *asked != Some(ChildEnd::Kill) && *asked != Some(end);
            if is_changed {
                *asked = Some(end);
            }
            is_changed
        });
    }
}

/// The end asked of one child so far, with the kill a stop arms once its grace passes.
pub(crate) struct ChildEnding {
    grace: Duration,
    kill_due: Pin<Box<Sleep>>,
    is_kill_armed: bool,
    asked: Option<ChildEnd>,
}

impl ChildEnding {
    /// Nothing asked yet; a stop asked later arms a kill `grace` after it.
    pub(crate) fn new(grace: Duration) -> Self {
        Self {
            grace,
            kill_due: Box::pin(tokio::time::sleep(grace)),
            is_kill_armed: false,
            asked: None,
        }
    }

    /// The end asked last, `None` before any.
    pub(crate) fn asked(&self) -> Option<ChildEnd> {
        self.asked
    }

    /// Asks `child` to end as `end`: a stop arms the kill and a kill ends it at once, while the
    /// same end asked again or a stop after a kill changes nothing. Fails as the platform's ask
    /// fails, the end still counted as asked, so a stop that failed is still killed past its grace,
    /// as a canceled sign-in whose stop failed is.
    pub(crate) fn ask(&mut self, child: &mut dyn ChildWrapper, end: ChildEnd) -> io::Result<()> {
        if self.asked == Some(ChildEnd::Kill) || self.asked == Some(end) {
            return Ok(());
        }
        self.asked = Some(end);
        match end {
            ChildEnd::Stop => {
                self.kill_due.as_mut().reset(Instant::now() + self.grace);
                self.is_kill_armed = true;
                ask_child_to_stop(child)
            }
            ChildEnd::Kill => {
                self.is_kill_armed = false;
                child.start_kill()
            }
        }
    }

    /// Settles once a stop's grace has passed with no kill asked since; never before a stop.
    pub(crate) async fn kill_due(&mut self) {
        if !self.is_kill_armed {
            return std::future::pending().await;
        }
        self.kill_due.as_mut().await;
    }
}

/// Asks `child` to stop and waits out `grace`, killing it past that; settles once it exited or
/// was killed. A failed ask is logged, since the caller has nothing left to do with the child.
pub(crate) async fn stop_child(child: &mut dyn ChildWrapper, grace: Duration) {
    let mut ending = ChildEnding::new(grace);
    let mut end = ChildEnd::Stop;
    loop {
        if let Err(error) = ending.ask(child, end) {
            tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                "a provider's child process could not be asked to end"
            );
        }
        if end == ChildEnd::Kill {
            return;
        }
        tokio::select! {
            _waited = child.wait() => return,
            () = ending.kill_due() => end = ChildEnd::Kill,
        }
    }
}
