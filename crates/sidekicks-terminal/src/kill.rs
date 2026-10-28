//! Stopping a shell's program: a signal as the running system delivers it, the console break's
//! escalation to an outright end, and a close's hangup, stop and kill in turn.

use std::error::Error;
use std::future::{Future, pending};
use std::io;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use sidekicks_platforms::{
    HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute,
};
use sidekicks_std::mutex_lock::lock;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::input::queue::TerminalWriteError;

/// How long a console break is given before the program's tree is ended outright.
const CONSOLE_BREAK_GRACE: Duration = Duration::from_secs(2);

/// How long each of a close's endings lasts, its delivery included, before the next is tried.
const ENDING_STEP: Duration = Duration::from_secs(2);

/// A close's endings, in the order it tries them.
const CLOSE_ENDINGS: [TerminalSignal; 3] = [
    TerminalSignal::Hangup,
    TerminalSignal::Terminate,
    TerminalSignal::Kill,
];

/// What a stop does to one shell's program; the terminal implements it, a test fakes it.
pub(crate) trait ChildEnding: Send + Sync + 'static {
    /// The program's process id, when the system gave one.
    fn process_id(&self) -> Option<u32>;
    /// Sends `signal` to the program's process; succeeds, sending nothing, once it has exited.
    fn send_signal(&self, signal: TerminalSignal) -> io::Result<()>;
    /// Writes byte `0x03` to the terminal's input; fails when the write is refused or left
    /// unwritten.
    fn write_interrupt(&self) -> impl Future<Output = Result<(), TerminalWriteError>> + Send;
    /// Sends a break event to the console of the process `process_id`; fails when it cannot be
    /// sent.
    fn send_console_break(&self, process_id: u32) -> impl Future<Output = io::Result<()>> + Send;
    /// Ends the process `process_id` and every process it started outright; fails when the system
    /// could not end them.
    fn end_tree(&self, process_id: u32) -> impl Future<Output = io::Result<ProcessTreeEnd>> + Send;
    /// Whether the program has exited.
    fn has_child_exited(&self) -> bool;
    /// Resolves once the program has exited.
    fn child_exited(&self) -> impl Future<Output = ()> + Send;
    /// Reports the exit of an outright end the system never confirmed, unless an exit came first.
    fn report_forced_end(&self);
}

/// A terminal's one pending escalation: every signal cancels it first, so a stale one cannot end
/// the program later, possibly under a reused process id.
pub(crate) struct Escalation {
    pending: Mutex<Option<AbortHandle>>,
}

impl Escalation {
    /// No escalation pending.
    pub(crate) fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }

    /// Makes `handle`'s task the pending escalation, aborting the one it replaces.
    fn arm(&self, handle: AbortHandle) {
        // The slot holds no invariant a panic could break, so a poisoned lock is still sound.
        let replaced = lock(&self.pending).replace(handle);
        if let Some(replaced) = replaced {
            replaced.abort();
        }
    }

    /// Aborts `handle`'s task when it is still the pending escalation, leaving a later one armed.
    fn disarm(&self, handle: &AbortHandle) {
        let mut pending = lock(&self.pending);
        if pending
            .as_ref()
            .is_some_and(|armed| armed.id() == handle.id())
        {
            pending.take();
            handle.abort();
        }
    }

    /// Aborts the pending escalation, if one is armed.
    fn cancel(&self) {
        let pending = lock(&self.pending).take();
        if let Some(pending) = pending {
            pending.abort();
        }
    }
}

impl Drop for Escalation {
    fn drop(&mut self) {
        if let Some(pending) = self
            .pending
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            pending.abort();
        }
    }
}

/// Why a signal or a stop did not reach a shell's program.
#[derive(Debug, thiserror::Error)]
pub enum KillError {
    /// The system gave the program no process id, so a stop that names one cannot reach it.
    #[error("the terminal's program has no process id, so the stop cannot reach it")]
    NoProcessId,
    /// The system refused the signal.
    #[error("the signal did not reach the terminal's program")]
    Signal(#[source] io::Error),
    /// The interrupt byte was not written to the terminal's input.
    #[error("the interrupt could not be written to the terminal's input")]
    Interrupt(#[source] TerminalWriteError),
    /// The break event was not sent to the program's console.
    #[error("the break could not be sent to the console of the terminal's program")]
    ConsoleBreak(#[source] io::Error),
    /// The program was still running once its kill's wait had passed.
    #[error("the terminal's program, {}, did not end when killed", describe_process(*process_id))]
    OutlivedKill {
        /// The program's process id, when the system gave one.
        process_id: Option<u32>,
    },
}

/// Names a process for an error message.
fn describe_process(process_id: Option<u32>) -> String {
    match process_id {
        Some(process_id) => format!("process {process_id}"),
        None => "with no process id".to_owned(),
    }
}

/// Delivers a signal by `route` after cancelling the pending escalation, answering once the
/// delivery has begun; a program that has exited gets nothing. A console break arms the outright
/// end of the program's tree for after its grace, and an outright end runs on without the caller,
/// its exit arriving through the output. Fails when the program has no process id the route needs
/// or the system refused the delivery; a console break that fails arms no end of the tree.
pub(crate) async fn deliver_signal<E: ChildEnding>(
    ending: &Arc<E>,
    escalation: &Escalation,
    route: TerminalSignalRoute,
) -> Result<(), KillError> {
    escalation.cancel();
    if ending.has_child_exited() {
        return Ok(());
    }
    match route {
        TerminalSignalRoute::Signal(_) | TerminalSignalRoute::WriteInterrupt => {
            deliver_ending(&**ending, route).await
        }
        TerminalSignalRoute::ConsoleBreak => {
            let process_id = ending.process_id().ok_or(KillError::NoProcessId)?;
            // Armed before the break is sent, so a program that ignores the break is still ended.
            let deadline = Instant::now() + CONSOLE_BREAK_GRACE;
            let escalating = Arc::clone(ending);
            let task = tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;
                // An exited program's process id may already belong to another process.
                if !escalating.has_child_exited() {
                    // Its own task, so a later signal's cancel cannot stop an end already begun.
                    tokio::spawn(async move { hard_stop(&*escalating, process_id).await });
                }
            });
            let escalating_task = task.abort_handle();
            escalation.arm(task.abort_handle());
            let sent = ending.send_console_break(process_id).await;
            if sent.is_err() {
                // A break that never went out arms no end of the tree.
                escalation.disarm(&escalating_task);
            }
            sent.map_err(KillError::ConsoleBreak)
        }
        TerminalSignalRoute::EndTree => {
            let process_id = ending.process_id().ok_or(KillError::NoProcessId)?;
            let stopping = Arc::clone(ending);
            tokio::spawn(async move { hard_stop(&*stopping, process_id).await });
            Ok(())
        }
    }
}

/// Ends the program's tree outright, then reports its forced exit unless the program's own exit
/// came first: the report waits for the end to succeed, fail or pass its bound.
async fn hard_stop<E: ChildEnding>(ending: &E, process_id: u32) {
    end_tree_within_bound(ending, process_id).await;
    if !ending.has_child_exited() {
        ending.report_forced_end();
    }
}

/// Ends the program's tree outright and waits for that up to its bound, logging how it went.
async fn end_tree_within_bound<E: ChildEnding>(ending: &E, process_id: u32) {
    match tokio::time::timeout(HELPER_PROGRAM_TIME_LIMIT, ending.end_tree(process_id)).await {
        Ok(Ok(tree_end)) => {
            tracing::debug!(
                process_id,
                ?tree_end,
                "a terminal's program tree was ended outright"
            );
        }
        Ok(Err(error)) => {
            tracing::warn!(
                process_id,
                error = &error as &(dyn Error + 'static),
                "a terminal's program tree could not be ended outright; its exit is reported anyway"
            );
        }
        Err(elapsed) => {
            tracing::warn!(
                process_id,
                %elapsed,
                "the outright end of a terminal's program tree did not finish in time; its exit is \
                 reported anyway"
            );
        }
    }
}

/// Ends the program for a close after cancelling the pending escalation: a hangup, a stop and a
/// kill in turn, each reaching it by `route_of` and each lasting at most its step, its delivery
/// included, stopping once the program has exited. Nothing is reported, since a closing terminal
/// reports nothing; a failed
/// ending is logged and the next tried. Fails when the program outlives its kill.
pub(crate) async fn end_through_endings<E: ChildEnding>(
    ending: &E,
    escalation: &Escalation,
    route_of: fn(TerminalSignal) -> TerminalSignalRoute,
) -> Result<(), KillError> {
    escalation.cancel();
    for signal in CLOSE_ENDINGS {
        if ending.has_child_exited() {
            return Ok(());
        }
        // The delivery and the wait run together, so a slow delivery cannot stretch the step.
        let delivered_then_waited = async {
            if let Err(error) = deliver_ending(ending, route_of(signal)).await {
                tracing::warn!(
                    ?signal,
                    error = &error as &(dyn Error + 'static),
                    "a closing terminal's ending did not reach it"
                );
            }
            pending::<()>().await;
        };
        let step = async {
            tokio::select! {
                () = delivered_then_waited => {}
                () = ending.child_exited() => {}
            }
        };
        // Timing out only moves on to the next ending; the last check below says how it went.
        if tokio::time::timeout(ENDING_STEP, step).await.is_ok() {
            return Ok(());
        }
    }
    if ending.has_child_exited() {
        return Ok(());
    }
    Err(KillError::OutlivedKill {
        process_id: ending.process_id(),
    })
}

/// Delivers a signal by `route` once, arming nothing and reporting nothing; an outright end is
/// waited for up to its bound.
async fn deliver_ending<E: ChildEnding>(
    ending: &E,
    route: TerminalSignalRoute,
) -> Result<(), KillError> {
    match route {
        TerminalSignalRoute::Signal(signal) => {
            ending.send_signal(signal).map_err(KillError::Signal)
        }
        TerminalSignalRoute::WriteInterrupt => {
            ending.write_interrupt().await.map_err(KillError::Interrupt)
        }
        TerminalSignalRoute::ConsoleBreak => {
            let process_id = ending.process_id().ok_or(KillError::NoProcessId)?;
            ending
                .send_console_break(process_id)
                .await
                .map_err(KillError::ConsoleBreak)
        }
        TerminalSignalRoute::EndTree => {
            let process_id = ending.process_id().ok_or(KillError::NoProcessId)?;
            end_tree_within_bound(ending, process_id).await;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use rstest::rstest;
    use sidekicks_platforms::{ProcessTreeEnd, TerminalSignal, TerminalSignalRoute};
    use tokio::sync::watch;

    use super::{
        CONSOLE_BREAK_GRACE, ChildEnding, Escalation, HELPER_PROGRAM_TIME_LIMIT, deliver_signal,
    };
    use crate::input::queue::TerminalWriteError;

    const ROOT_PROCESS_ID: u32 = 4242;
    const ONE_MILLISECOND: Duration = Duration::from_millis(1);
    /// The last moment before the console break's grace runs out; the build fails were the grace
    /// shorter than a millisecond.
    const JUST_BEFORE_GRACE: Duration = CONSOLE_BREAK_GRACE
        .checked_sub(ONE_MILLISECOND)
        .expect("the console break's grace is longer than a millisecond");
    /// The last moment before a helper program's time limit; the build fails were the limit
    /// shorter than a millisecond.
    const JUST_BEFORE_TIME_LIMIT: Duration = HELPER_PROGRAM_TIME_LIMIT
        .checked_sub(ONE_MILLISECOND)
        .expect("a helper program's time limit is longer than a millisecond");

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Call {
        Signal(TerminalSignal),
        Interrupt,
        ConsoleBreak(u32),
        EndTree(u32),
        ForcedEnd,
    }

    #[derive(Clone, Copy, Debug)]
    enum TreeEnding {
        Ends,
        Fails,
        NeverReturns,
    }

    /// A program at one root process id that records every call a stop makes on it.
    struct FakeChild {
        tree_ending: TreeEnding,
        calls: Mutex<Vec<Call>>,
        has_exited: watch::Sender<bool>,
    }

    impl FakeChild {
        fn new(tree_ending: TreeEnding) -> Arc<Self> {
            Arc::new(Self {
                tree_ending,
                calls: Mutex::new(Vec::new()),
                has_exited: watch::Sender::new(false),
            })
        }

        fn record(&self, call: Call) {
            self.calls.lock().unwrap().push(call);
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ChildEnding for FakeChild {
        fn process_id(&self) -> Option<u32> {
            Some(ROOT_PROCESS_ID)
        }

        fn send_signal(&self, signal: TerminalSignal) -> io::Result<()> {
            self.record(Call::Signal(signal));
            Ok(())
        }

        fn write_interrupt(&self) -> impl Future<Output = Result<(), TerminalWriteError>> + Send {
            self.record(Call::Interrupt);
            async { Ok(()) }
        }

        fn send_console_break(
            &self,
            process_id: u32,
        ) -> impl Future<Output = io::Result<()>> + Send {
            self.record(Call::ConsoleBreak(process_id));
            async { Ok(()) }
        }

        fn end_tree(
            &self,
            process_id: u32,
        ) -> impl Future<Output = io::Result<ProcessTreeEnd>> + Send {
            self.record(Call::EndTree(process_id));
            let tree_ending = self.tree_ending;
            async move {
                match tree_ending {
                    TreeEnding::Ends => Ok(ProcessTreeEnd::Ended),
                    TreeEnding::Fails => Err(io::Error::other("taskkill.exe exited with code 1")),
                    TreeEnding::NeverReturns => std::future::pending().await,
                }
            }
        }

        fn has_child_exited(&self) -> bool {
            *self.has_exited.borrow()
        }

        fn child_exited(&self) -> impl Future<Output = ()> + Send {
            let mut has_exited = self.has_exited.subscribe();
            async move {
                assert!(
                    has_exited
                        .wait_for(|has_child_exited| *has_child_exited)
                        .await
                        .is_ok()
                );
            }
        }

        fn report_forced_end(&self) {
            self.record(Call::ForcedEnd);
        }
    }

    /// Lets every spawned task run as far as it can at the paused clock's current instant.
    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    async fn advance(by: Duration) {
        tokio::time::advance(by).await;
        settle().await;
    }

    #[rstest]
    #[tokio::test(start_paused = true)]
    async fn hard_stop_ends_the_root_tree_and_reports_the_exit(
        #[values(TerminalSignalRoute::ConsoleBreak, TerminalSignalRoute::EndTree)]
        route: TerminalSignalRoute,
        #[values(TreeEnding::Ends, TreeEnding::Fails, TreeEnding::NeverReturns)]
        tree_ending: TreeEnding,
    ) {
        let child = FakeChild::new(tree_ending);
        let escalation = Escalation::new();
        deliver_signal(&child, &escalation, route).await.unwrap();
        settle().await;

        let mut expected = Vec::new();
        if route == TerminalSignalRoute::ConsoleBreak {
            expected.push(Call::ConsoleBreak(ROOT_PROCESS_ID));
            assert_eq!(
                child.calls(),
                expected,
                "the break goes at once, the tree end waits"
            );
            advance(JUST_BEFORE_GRACE).await;
            assert_eq!(
                child.calls(),
                expected,
                "nothing ends the tree before the grace"
            );
            advance(ONE_MILLISECOND).await;
        }
        expected.push(Call::EndTree(ROOT_PROCESS_ID));

        match tree_ending {
            TreeEnding::Ends | TreeEnding::Fails => {}
            TreeEnding::NeverReturns => {
                assert_eq!(child.calls(), expected, "no report before the bound");
                advance(JUST_BEFORE_TIME_LIMIT).await;
                assert_eq!(child.calls(), expected, "no report before the bound");
                advance(ONE_MILLISECOND).await;
            }
        }
        expected.push(Call::ForcedEnd);
        assert_eq!(child.calls(), expected);
    }

    #[tokio::test(start_paused = true)]
    async fn child_exiting_in_the_grace_is_not_ended() {
        let child = FakeChild::new(TreeEnding::Ends);
        let escalation = Escalation::new();
        deliver_signal(&child, &escalation, TerminalSignalRoute::ConsoleBreak)
            .await
            .unwrap();
        settle().await;
        child.has_exited.send_replace(true);
        advance(CONSOLE_BREAK_GRACE + HELPER_PROGRAM_TIME_LIMIT).await;
        assert_eq!(child.calls(), [Call::ConsoleBreak(ROOT_PROCESS_ID)]);
    }
}
