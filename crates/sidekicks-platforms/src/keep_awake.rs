//! The service's keep-awake hold: one thread made for the hold owns `keepawake`'s guard, so the
//! guard is created and dropped on the thread Windows binds it to, and the hold ends with the
//! service's own process on every system. Neither purpose stops a sleep the person asks for.

use std::io;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;
use tokio::sync::oneshot;

/// The name the system shows for the hold: macOS names its power assertion by it in
/// `pmset -g assertions`, and Linux names its inhibitor by it.
pub const KEEP_AWAKE_REASON: &str = "AI Sidekicks";

/// What the machine is kept awake for, which sets how much of it stays awake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepAwakePurpose {
    /// An agent works: the machine and its screen stay awake while it sits idle.
    AgentWorks,
    /// Other devices reach this machine: the machine stays awake while it sits idle, the screen
    /// may sleep.
    OtherDevices,
}

impl KeepAwakePurpose {
    // Whether the screen is kept awake too.
    fn keeps_display_awake(self) -> bool {
        match self {
            Self::AgentWorks => true,
            Self::OtherDevices => false,
        }
    }
}

/// The system refused to keep the machine awake; whatever the hold held before stays held.
#[derive(Debug, thiserror::Error)]
#[error("the system refused to keep the machine awake for {purpose:?}")]
pub struct KeepAwakeRefused {
    /// What the refused hold was for.
    pub purpose: KeepAwakePurpose,
    /// The system's refusal.
    #[source]
    pub source: keepawake::Error,
}

// One request to the hold's thread.
enum HoldCommand {
    // Hold the machine awake for this purpose, answering whether the system allowed it.
    Take(
        KeepAwakePurpose,
        oneshot::Sender<Result<(), KeepAwakeRefused>>,
    ),
    // Let go of whatever is held.
    Release,
}

/// The service's one keep-awake hold, held by the thread made for it; dropping it lets go of the
/// hold and ends the thread.
pub struct KeepAwakeHold {
    // Taken by the drop, so the thread's channel closes before the thread is joined.
    commands: Option<mpsc::Sender<HoldCommand>>,
    thread: Option<JoinHandle<()>>,
}

impl KeepAwakeHold {
    /// Starts the hold's thread, holding nothing. Fails when the thread cannot be made.
    pub fn new() -> io::Result<Self> {
        Self::start(take_keepawake_guard)
    }

    // Starts the hold's thread over `take_guard`, which takes one guard the drop releases.
    fn start<Guard>(
        take_guard: impl FnMut(KeepAwakePurpose) -> keepawake::Result<Guard> + Send + 'static,
    ) -> io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("keep-awake".to_owned())
            .spawn(move || run_hold(&receiver, take_guard))?;
        Ok(Self {
            commands: Some(commands),
            thread: Some(thread),
        })
    }

    /// Holds the machine awake for `purpose`, keeping what is held when it already holds that.
    /// Moving to another purpose takes the new hold before letting go of the old, so no instant
    /// holds nothing. Fails with [`KeepAwakeRefused`] when the system refuses, which the caller
    /// logs once per change; the old hold stays and the next call tries again.
    pub async fn take(&self, purpose: KeepAwakePurpose) -> Result<(), KeepAwakeRefused> {
        let (answer, answered) = oneshot::channel();
        self.send(HoldCommand::Take(purpose, answer));
        answered
            .await
            .expect("the hold's thread answers every request while its handle lives")
    }

    /// Lets go of the hold; holding nothing already, it does nothing.
    pub fn release(&self) {
        self.send(HoldCommand::Release);
    }

    fn send(&self, command: HoldCommand) {
        self.commands
            .as_ref()
            .expect("the commands are taken only by the drop")
            .send(command)
            .expect("the hold's thread runs while its handle lives");
    }
}

impl Drop for KeepAwakeHold {
    fn drop(&mut self) {
        // Closing the channel ends the thread's loop, which drops the guard as it returns.
        self.commands = None;
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("the keep-awake thread panicked");
        }
    }
}

// The hold's thread: answers each request until the channel closes, then drops what it holds.
fn run_hold<Guard>(
    commands: &mpsc::Receiver<HoldCommand>,
    mut take_guard: impl FnMut(KeepAwakePurpose) -> keepawake::Result<Guard>,
) {
    let mut held: Option<(KeepAwakePurpose, Guard)> = None;
    for command in commands {
        match command {
            HoldCommand::Take(purpose, answer) => {
                let result = if held
                    .as_ref()
                    .is_some_and(|(current, _)| *current == purpose)
                {
                    Ok(())
                } else {
                    take_guard(purpose)
                        .map(|guard| {
                            // The new guard is held before the old one drops.
                            let previous = held.replace((purpose, guard));
                            drop(previous);
                        })
                        .map_err(|source| KeepAwakeRefused { purpose, source })
                };
                if answer.send(result).is_err() {
                    tracing::debug!("a keep-awake request's caller stopped waiting for its answer");
                }
            }
            HoldCommand::Release => held = None,
        }
    }
}

// Takes `keepawake`'s guard for `purpose`, named for the app; never `sleep`, which no macOS
// supports and which on Linux would block a suspend the person asks for.
fn take_keepawake_guard(purpose: KeepAwakePurpose) -> keepawake::Result<keepawake::KeepAwake> {
    keepawake::Builder::default()
        .display(purpose.keeps_display_awake())
        .idle(true)
        .reason(KEEP_AWAKE_REASON)
        .app_name(KEEP_AWAKE_REASON)
        .app_reverse_domain(APP_BUNDLE_IDENTIFIER)
        .create()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{KeepAwakeHold, KeepAwakePurpose};

    // What happened to the stand-in guards, in order.
    #[derive(Debug, PartialEq)]
    enum GuardEvent {
        Taken(KeepAwakePurpose),
        Dropped(KeepAwakePurpose),
    }

    // A guard that records its taking and its drop.
    struct RecordedGuard {
        purpose: KeepAwakePurpose,
        events: Arc<Mutex<Vec<GuardEvent>>>,
    }

    impl Drop for RecordedGuard {
        fn drop(&mut self) {
            self.events
                .lock()
                .expect("no test thread panics holding the log")
                .push(GuardEvent::Dropped(self.purpose));
        }
    }

    fn drain(events: &Mutex<Vec<GuardEvent>>) -> Vec<GuardEvent> {
        std::mem::take(
            &mut *events
                .lock()
                .expect("no test thread panics holding the log"),
        )
    }

    #[tokio::test]
    async fn the_hold_keeps_one_guard_and_never_none_between_purposes() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&events);
        let hold = KeepAwakeHold::start(move |purpose| {
            recorder
                .lock()
                .expect("no test thread panics holding the log")
                .push(GuardEvent::Taken(purpose));
            Ok(RecordedGuard {
                purpose,
                events: Arc::clone(&recorder),
            })
        })
        .expect("the hold's thread starts");

        hold.take(KeepAwakePurpose::AgentWorks).await.expect("held");
        hold.take(KeepAwakePurpose::OtherDevices)
            .await
            .expect("held");
        hold.take(KeepAwakePurpose::OtherDevices)
            .await
            .expect("held");
        assert_eq!(
            drain(&events),
            [
                GuardEvent::Taken(KeepAwakePurpose::AgentWorks),
                GuardEvent::Taken(KeepAwakePurpose::OtherDevices),
                GuardEvent::Dropped(KeepAwakePurpose::AgentWorks),
            ]
        );

        hold.release();
        // A take answers only after the release before it ran on the same thread.
        hold.take(KeepAwakePurpose::AgentWorks).await.expect("held");
        assert_eq!(
            drain(&events),
            [
                GuardEvent::Dropped(KeepAwakePurpose::OtherDevices),
                GuardEvent::Taken(KeepAwakePurpose::AgentWorks),
            ]
        );

        drop(hold);
        assert_eq!(
            drain(&events),
            [GuardEvent::Dropped(KeepAwakePurpose::AgentWorks)]
        );
        // The thread's guard taker, which holds the other reference, went with the thread.
        assert_eq!(Arc::strong_count(&events), 1);
    }
}
