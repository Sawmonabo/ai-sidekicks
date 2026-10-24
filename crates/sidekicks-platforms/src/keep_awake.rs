//! The service's keep-awake hold: one thread made for the hold owns `keepawake`'s guard, so the
//! guard is created and dropped on the thread Windows binds it to, and the hold ends with the
//! service's own process on every system. Neither purpose stops a sleep the person asks for.

use std::io;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use sidekicks_contracts::app_identity::{APP_BUNDLE_IDENTIFIER, APP_DISPLAY_NAME};
use tokio::sync::oneshot;

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

#[cfg(any(test, feature = "test-support"))]
impl KeepAwakeRefused {
    /// A refusal for `purpose` that a test's stand-in guard taker answers with, its source a
    /// fixed message rather than any system's error.
    pub fn stand_in(purpose: KeepAwakePurpose) -> Self {
        Self {
            purpose,
            source: keepawake::BuilderError::from("the test refused the hold".to_owned()).into(),
        }
    }
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

    /// Starts the hold's thread over `take_guard`, a test's stand-in for the system: it takes one
    /// guard per call, which the hold drops on letting go, or answers a refusal. Fails when the
    /// thread cannot be made.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_guard_taker<Guard, TakeGuard>(take_guard: TakeGuard) -> io::Result<Self>
    where
        TakeGuard: FnMut(KeepAwakePurpose) -> Result<Guard, KeepAwakeRefused> + Send + 'static,
    {
        Self::start(take_guard)
    }

    // Starts the hold's thread over `take_guard`, which takes one guard the drop releases.
    fn start<Guard, TakeGuard>(take_guard: TakeGuard) -> io::Result<Self>
    where
        TakeGuard: FnMut(KeepAwakePurpose) -> Result<Guard, KeepAwakeRefused> + Send + 'static,
    {
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
    mut take_guard: impl FnMut(KeepAwakePurpose) -> Result<Guard, KeepAwakeRefused>,
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
                    take_guard(purpose).map(|guard| {
                        // The new guard is held before the old one drops.
                        let previous = held.replace((purpose, guard));
                        drop(previous);
                    })
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
fn take_keepawake_guard(
    purpose: KeepAwakePurpose,
) -> Result<keepawake::KeepAwake, KeepAwakeRefused> {
    keepawake::Builder::default()
        .display(purpose.keeps_display_awake())
        .idle(true)
        .reason(APP_DISPLAY_NAME)
        .app_name(APP_DISPLAY_NAME)
        .app_reverse_domain(APP_BUNDLE_IDENTIFIER)
        .create()
        .map_err(|source| KeepAwakeRefused { purpose, source })
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
        let hold = KeepAwakeHold::with_guard_taker(move |purpose| {
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

    // The real hold as macOS's power manager lists it; ignored in the normal run.
    #[cfg(target_os = "macos")]
    mod power_manager {
        use std::process::Command;
        use std::time::Duration;

        use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;

        use crate::{KeepAwakeHold, KeepAwakePurpose};

        const WAIT: Duration = Duration::from_secs(10);

        // Set only for the child the killed-process test starts, which holds until it is killed.
        const HOLDER_VARIABLE: &str = "SIDEKICKS_KEEP_AWAKE_TEST_HOLDER";
        const HOLDER_TEST: &str =
            "keep_awake::tests::power_manager::a_hold_kept_until_the_process_is_killed";

        // The power manager's assertions of process `pid` that name the app.
        fn assertions_of(pid: u32) -> Vec<String> {
            let listed = Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset runs");
            assert!(listed.status.success(), "pmset lists the assertions");
            String::from_utf8_lossy(&listed.stdout)
                .lines()
                .filter(|line| {
                    line.contains(&format!("pid {pid}(")) && line.contains(APP_DISPLAY_NAME)
                })
                .map(str::to_owned)
                .collect()
        }

        // Reads `pid`'s assertions until `is_done` holds them, failing after the wait.
        async fn wait_for_assertions(pid: u32, is_done: impl Fn(&[String]) -> bool) -> Vec<String> {
            let deadline = tokio::time::Instant::now() + WAIT;
            loop {
                let assertions = assertions_of(pid);
                if is_done(&assertions) || tokio::time::Instant::now() >= deadline {
                    return assertions;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }

        // The hold the system lists keeps the machine and its screen awake while idle and never
        // blocks a sleep the person asks for; it goes when the hold drops and when its process is
        // killed. Killed by the guard taken off the hold's thread and by a hold that blocks every
        // sleep. Needs macOS's power manager: run with `--run-ignored only -E 'test(/pmset/)'`.
        #[tokio::test]
        #[ignore = "takes a real hold from macOS's power manager and reads it with pmset"]
        async fn pmset_lists_the_hold_until_it_drops_or_its_process_is_killed() {
            let pid = std::process::id();
            let hold = KeepAwakeHold::new().expect("the hold's thread starts");
            hold.take(KeepAwakePurpose::AgentWorks)
                .await
                .expect("the system allows the hold");
            let held = assertions_of(pid);
            for kind in ["PreventUserIdleDisplaySleep", "PreventUserIdleSystemSleep"] {
                assert!(held.iter().any(|line| line.contains(kind)), "{held:?}");
            }
            assert!(
                !held.iter().any(|line| line.contains("PreventSystemSleep")),
                "{held:?}"
            );
            drop(hold);
            assert_eq!(assertions_of(pid), Vec::<String>::new());

            let mut holder =
                Command::new(std::env::current_exe().expect("the test knows its program"))
                    .args(["--exact", HOLDER_TEST, "--ignored", "--nocapture"])
                    .env(HOLDER_VARIABLE, "1")
                    .spawn()
                    .expect("the holder starts");
            let holder_pid = holder.id();
            let listed = wait_for_assertions(holder_pid, |lines| !lines.is_empty()).await;
            assert!(!listed.is_empty(), "the holder's hold is listed");
            holder.kill().expect("the test kills its own child");
            holder.wait().expect("the killed holder is reaped");
            let left = wait_for_assertions(holder_pid, <[String]>::is_empty).await;
            assert_eq!(left, Vec::<String>::new(), "a killed process's hold goes");
        }

        // The child of the test above: holds the machine awake until it is killed.
        #[tokio::test]
        #[ignore = "the pmset test's child, which holds until it is killed"]
        async fn a_hold_kept_until_the_process_is_killed() {
            if std::env::var_os(HOLDER_VARIABLE).is_none() {
                return;
            }
            let hold = KeepAwakeHold::new().expect("the hold's thread starts");
            hold.take(KeepAwakePurpose::AgentWorks)
                .await
                .expect("the system allows the hold");
            tokio::time::sleep(Duration::from_secs(120)).await;
        }
    }
}
