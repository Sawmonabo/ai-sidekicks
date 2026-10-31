//! Terminals: the PTY each shell runs in, inside the daemon, and the screen copy of its output.
//!
//! [`Terminals`] starts each shell, carries its input, resize, pause and stops, and drains every
//! shell at the service's stop; each shell's output and exit reach the caller through its
//! [`TerminalOutput`], its screen copy and scrollback through its [`TerminalScreen`], and the
//! screen's answers to a program's questions go back through its [`TerminalAnswers`].

mod exit;
mod input;
mod kill;
mod osc_limit;
mod pty;
mod read_loop;
mod screen;
mod scrollback;

use std::collections::HashMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use bytes::Bytes;
use sidekicks_platforms::{ProcessTreeEnd, Spawner, terminal_ending_route, terminal_signal_route};
use tokio::runtime::Handle;
use tokio::sync::OnceCell;
use tokio::task::{JoinError, JoinSet};
use uuid::Uuid;

pub use exit::TerminalExit;
pub use input::answers::{ANSWER_BYTES_LIMIT, TerminalAnswers};
pub use input::queue::TerminalWriteError;
pub use kill::KillError;
pub use pty::{CommandLine, ShellCommand, SpawnRequest};
pub use read_loop::control::WriteTaken;
pub use read_loop::output::{OutputFilter, TerminalEvent, TerminalOutput};
pub use screen::{ScreenListener, ScrollbackRead, TerminalScreen};
pub use sidekicks_platforms::TerminalSignal;

use crate::input::answers::ConsoleInputRead;
use crate::kill::{ChildEnding, Escalation};
use crate::read_loop::control::TerminalControl;

/// One terminal's handle for its life, minted at its spawn and stored nowhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TerminalHandle(Uuid);

impl TerminalHandle {
    /// A fresh handle for a terminal being spawned.
    fn mint() -> Self {
        #[expect(
            clippy::disallowed_methods,
            reason = "a terminal handle is an ephemeral token no row or event stores"
        )]
        let id = Uuid::now_v7();
        Self(id)
    }
}

impl fmt::Display for TerminalHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A shell just started: its handle, its program's process id where the system gives one, its
/// screen copy and scrollback, and its output and exit.
pub struct SpawnedTerminal<L: EventListener> {
    /// The handle every later call names the terminal by.
    pub handle: TerminalHandle,
    /// The process id of the program the terminal started.
    pub process_id: Option<u32>,
    /// The screen copy and the scrollback window, under the lock the read loop takes them with.
    pub screen: Arc<Mutex<TerminalScreen<L>>>,
    /// The terminal's output, then its exit.
    pub output: TerminalOutput,
}

/// Why a call on the terminals was refused or failed.
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    /// No live terminal has the handle: it was never started or has been closed.
    #[error("no terminal has the handle {0}")]
    UnknownTerminal(TerminalHandle),
    /// The terminals are draining for the service's stop, so no shell starts.
    #[error("the terminals are draining for the service's stop, so no shell starts")]
    Draining,
    /// The shell could not be started.
    #[error("the shell could not be started")]
    Spawn(#[source] io::Error),
    /// The terminal could not be resized.
    #[error("the terminal could not be resized")]
    Resize(#[source] io::Error),
    /// The input did not reach the terminal.
    #[error(transparent)]
    Write(#[from] TerminalWriteError),
    /// A signal or a stop did not reach the program.
    #[error(transparent)]
    Kill(#[from] KillError),
    /// The close's task ended before it finished, as when the runtime stops.
    #[error("the terminal's close did not finish")]
    Close(#[source] JoinError),
}

/// How the drain at the service's stop ended the terminals that were still running.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainResult {
    /// Terminals whose program exited on the graceful stop within the drain's bound.
    pub drained: usize,
    /// Terminals whose program was ended outright, by the bound's kill or a stop's escalation.
    pub forced: usize,
}

/// The live terminals, by handle; a terminal leaves only once its close succeeds.
type LiveTerminals = Arc<Mutex<HashMap<TerminalHandle, Arc<TerminalEntry>>>>;

/// The daemon's live terminals: each shell's PTY, its read loop and its stops.
pub struct Terminals {
    /// The thread every shell, `taskkill.exe` and console helper starts on.
    spawner: Spawner,
    /// The daemon's `console` mode, which ends a terminal on Windows and reads how much input
    /// waits on its console.
    console_helper: Arc<CommandLine>,
    /// The live terminals, by handle.
    live: LiveTerminals,
    /// Set once a drain began, so no new terminal spawns.
    is_draining: AtomicBool,
    /// The one drain's result, which a later drain answers with.
    drain_result: OnceCell<DrainResult>,
}

impl Terminals {
    /// Terminals whose shells, `taskkill.exe` and console helper start on `spawner`'s thread,
    /// ended on Windows, and their consoles' waiting input read, through `console_helper` (the
    /// daemon's `console` mode, to which each call adds the program's process id, after
    /// `input` for a reading).
    pub fn new(spawner: Spawner, console_helper: CommandLine) -> Self {
        Self {
            spawner,
            console_helper: Arc::new(console_helper),
            live: Arc::new(Mutex::new(HashMap::new())),
            is_draining: AtomicBool::new(false),
            drain_result: OnceCell::new(),
        }
    }

    /// Starts a shell's `shell` mode on the spawner thread, writes it the shell's launch from a
    /// task on the current runtime and starts its read loop there. `listen` makes, from the
    /// shell's answers, the listener that hears the screen copy under its lock and must not block;
    /// `filter` takes each chunk of output first. Refused while draining; fails with
    /// `InvalidInput` for a size the terminal cannot take or a launch the frame cannot carry, and
    /// when the mode, its launch's write or its loop cannot start.
    pub async fn spawn<L, F>(
        &self,
        request: SpawnRequest,
        listen: impl FnOnce(TerminalAnswers) -> L,
        filter: F,
    ) -> Result<SpawnedTerminal<L>, TerminalError>
    where
        L: ScreenListener,
        F: OutputFilter,
    {
        if self.is_draining.load(Ordering::SeqCst) {
            return Err(TerminalError::Draining);
        }
        let (rows, columns) = (request.rows, request.columns);
        screen::check_screen_size(rows, columns).map_err(TerminalError::Spawn)?;
        let frame = request.launch_frame().map_err(TerminalError::Spawn)?;
        let runtime = Handle::current();
        let spawn_runtime = runtime.clone();
        let mut opened = self
            .spawner
            .run(move || pty::open_pty(&request, &spawn_runtime))
            .await
            .and_then(|opened| opened)
            .map_err(TerminalError::Spawn)?;
        if let Err(error) = opened.hold.write_launch(&runtime, frame) {
            read_loop::release_off_runtime(
                "unlaunched shell",
                Box::new(move || opened.release(|| {})),
            );
            return Err(TerminalError::Spawn(error));
        }
        let handle = TerminalHandle::mint();
        let console_read = sidekicks_platforms::child_process_id(&opened.pty)
            .filter(|_| sidekicks_platforms::DOES_CONSOLE_COUNT_WAITING_INPUT)
            .map(|process_id| self.console_input_read(process_id));
        let started = read_loop::start_read_loop(
            &runtime,
            &format!("terminal {handle}"),
            opened,
            console_read,
            move |answers| TerminalScreen::new(rows, columns, listen(answers)),
            filter,
        )
        .map_err(TerminalError::Spawn)?;
        let entry = Arc::new(TerminalEntry {
            control: started.control,
            escalation: Escalation::new(),
            spawner: self.spawner.clone(),
            console_helper: Arc::clone(&self.console_helper),
            is_escalated: AtomicBool::new(false),
        });
        let process_id = entry.control.process_id();
        {
            // The drain sets its flag under this lock, so a shell is either in its snapshot or
            // refused here.
            let mut live = lock_live(&self.live);
            if !self.is_draining.load(Ordering::SeqCst) {
                live.insert(handle, Arc::clone(&entry));
                return Ok(SpawnedTerminal {
                    handle,
                    process_id,
                    screen: started.screen,
                    output: started.output,
                });
            }
        }
        entry.control.begin_close();
        tokio::spawn(async move {
            let kill = terminal_signal_route(TerminalSignal::Kill);
            if let Err(error) = kill::deliver_signal(&entry, &entry.escalation, kill).await {
                tracing::warn!(
                    %handle,
                    error = &error as &(dyn Error + 'static),
                    "a shell started as the drain began could not be killed"
                );
            }
        });
        Err(TerminalError::Draining)
    }

    /// Resizes the terminal and its screen copy; fails for an unknown handle, with
    /// `InvalidInput` for a size the terminal cannot take, and for a refused resize.
    pub async fn resize(
        &self,
        handle: TerminalHandle,
        rows: u16,
        columns: u16,
    ) -> Result<(), TerminalError> {
        let entry = self.entry(handle)?;
        screen::check_screen_size(rows, columns).map_err(TerminalError::Resize)?;
        entry
            .control
            .resize(rows, columns)
            .await
            .map_err(TerminalError::Resize)
    }

    /// Hands `bytes` to the terminal's input behind every write and answer handed over before it,
    /// at once and without waiting, so writes keep the order of the calls; the [`WriteTaken`]
    /// resolves once the terminal's write queue takes the write, which it does while the queue
    /// holds fewer than 64 KiB. Fails at once for an unknown handle and a terminal closing or
    /// ended.
    pub fn queue_write(
        &self,
        handle: TerminalHandle,
        bytes: Bytes,
    ) -> Result<WriteTaken, TerminalError> {
        Ok(self.entry(handle)?.control.queue_write(bytes)?)
    }

    /// Stops reading the terminal, so its output waits in the system's buffer and the program
    /// blocks once that fills; fails only for an unknown handle.
    pub fn pause(&self, handle: TerminalHandle) -> Result<(), TerminalError> {
        self.entry(handle)?.control.pause();
        Ok(())
    }

    /// Reads the terminal again; the output that waited arrives in order. Fails only for an
    /// unknown handle.
    pub fn resume(&self, handle: TerminalHandle) -> Result<(), TerminalError> {
        self.entry(handle)?.control.resume();
        Ok(())
    }

    /// Sends `signal` to the terminal's program as the system delivers it, answering once the
    /// delivery has begun; a program that has exited gets nothing. Fails for an unknown handle and
    /// a delivery the system refused.
    pub async fn kill(
        &self,
        handle: TerminalHandle,
        signal: TerminalSignal,
    ) -> Result<(), TerminalError> {
        let entry = self.entry(handle)?;
        kill::deliver_signal(&entry, &entry.escalation, terminal_signal_route(signal)).await?;
        Ok(())
    }

    /// Closes the terminal and answers once its program has exited, ending it by a hangup, a stop
    /// and a kill in turn; nothing about it is reported once the close begins. The close runs on
    /// in its own task when the caller stops waiting, and the terminal stays tracked until it
    /// succeeds. An unknown handle needs nothing; fails when the program outlives its kill.
    pub async fn close(&self, handle: TerminalHandle) -> Result<(), TerminalError> {
        let Some(entry) = lock_live(&self.live).get(&handle).cloned() else {
            return Ok(());
        };
        entry.control.begin_close();
        let live = Arc::clone(&self.live);
        let closing = tokio::spawn(async move {
            kill::end_through_endings(&*entry, &entry.escalation, terminal_ending_route).await?;
            let mut live = lock_live(&live);
            if live
                .get(&handle)
                .is_some_and(|tracked| Arc::ptr_eq(tracked, &entry))
            {
                live.remove(&handle);
            }
            Ok::<(), KillError>(())
        });
        match closing.await {
            Ok(ended) => Ok(ended?),
            Err(error) => Err(TerminalError::Close(error)),
        }
    }

    /// Ends every running shell at the service's stop: each gets the graceful stop and, once
    /// `bound` passes without its exit, the kill. From here on no shell starts; a later drain
    /// answers with the first one's result.
    pub async fn drain(&self, bound: Duration) -> DrainResult {
        *self
            .drain_result
            .get_or_init(|| self.drain_once(bound))
            .await
    }

    /// Stops every running terminal within `bound`, the work the first drain does.
    async fn drain_once(&self, bound: Duration) -> DrainResult {
        let running: Vec<Arc<TerminalEntry>> = {
            let live = lock_live(&self.live);
            self.is_draining.store(true, Ordering::SeqCst);
            live.values()
                .filter(|entry| {
                    !entry.control.is_exit_reported() && !entry.control.has_child_exited()
                })
                .cloned()
                .collect()
        };
        let mut drains = JoinSet::new();
        for entry in running {
            drains.spawn(drain_terminal(entry, bound));
        }
        let mut result = DrainResult::default();
        while let Some(outcome) = drains.join_next().await {
            match outcome {
                Ok(DrainOutcome::Drained) => result.drained += 1,
                Ok(DrainOutcome::Forced) => result.forced += 1,
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        "a terminal's drain did not finish"
                    );
                    result.forced += 1;
                }
            }
        }
        result
    }

    /// The process ids of the programs the live terminals started whose exit has not come, a
    /// terminal whose close failed among them; every program a terminal runs descends from one.
    pub fn process_ids(&self) -> Vec<u32> {
        lock_live(&self.live)
            .values()
            .filter_map(|entry| running_process_id(entry))
            .collect()
    }

    /// The process id of the program the terminal `handle` started, `None` once it exited or for a
    /// terminal that is gone.
    pub fn process_id(&self, handle: TerminalHandle) -> Option<u32> {
        lock_live(&self.live)
            .get(&handle)
            .and_then(|entry| running_process_id(entry))
    }

    /// Reads how much input waits on the console of the program `process_id`, through the console
    /// helper.
    fn console_input_read(&self, process_id: u32) -> ConsoleInputRead {
        let spawner = self.spawner.clone();
        let console_helper = Arc::clone(&self.console_helper);
        Arc::new(move || {
            let spawner = spawner.clone();
            let console_helper = Arc::clone(&console_helper);
            Box::pin(async move {
                let arguments: Vec<OsString> = console_helper
                    .arguments
                    .iter()
                    .map(OsString::from)
                    .collect();
                sidekicks_platforms::read_console_waiting_input(
                    &spawner,
                    OsStr::new(&console_helper.program),
                    &arguments,
                    process_id,
                )
                .await
            })
        })
    }

    /// The live terminal `handle` names; fails with `UnknownTerminal` once it is gone.
    fn entry(&self, handle: TerminalHandle) -> Result<Arc<TerminalEntry>, TerminalError> {
        lock_live(&self.live)
            .get(&handle)
            .cloned()
            .ok_or(TerminalError::UnknownTerminal(handle))
    }
}

/// The process id of the program `entry` started, while its exit has not come.
fn running_process_id(entry: &TerminalEntry) -> Option<u32> {
    if entry.control.has_child_exited() {
        return None;
    }
    entry.control.process_id()
}

/// Locks the live terminals.
fn lock_live(
    live: &Mutex<HashMap<TerminalHandle, Arc<TerminalEntry>>>,
) -> MutexGuard<'_, HashMap<TerminalHandle, Arc<TerminalEntry>>> {
    live.lock()
        .expect("no panic holds the terminals' lock, since a panic ends the daemon")
}

/// How one terminal's drain ended.
enum DrainOutcome {
    /// It ended on the graceful stop.
    Drained,
    /// It took the kill, or an outright end of its tree had begun.
    Forced,
}

/// Gives one terminal the graceful stop, then the kill once `bound` passes without its end; the
/// bound covers the stop's delivery too.
async fn drain_terminal(entry: Arc<TerminalEntry>, bound: Duration) -> DrainOutcome {
    let stopped = tokio::time::timeout(bound, async {
        let stop = terminal_signal_route(TerminalSignal::Terminate);
        if let Err(error) = kill::deliver_signal(&entry, &entry.escalation, stop).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the graceful stop did not reach a terminal at the drain"
            );
        }
        entry.control.ended().await;
    })
    .await;
    if stopped.is_ok() {
        return if entry.is_escalated.load(Ordering::SeqCst) {
            DrainOutcome::Forced
        } else {
            DrainOutcome::Drained
        };
    }
    let kill = terminal_signal_route(TerminalSignal::Kill);
    if let Err(error) = kill::deliver_signal(&entry, &entry.escalation, kill).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the kill did not reach a terminal at the drain"
        );
    }
    DrainOutcome::Forced
}

/// One live terminal: its loop's control, its pending escalation and how it is ended on Windows.
struct TerminalEntry {
    /// Its read loop's control.
    control: Arc<TerminalControl>,
    /// Its pending escalation from a stop to an outright end.
    escalation: Escalation,
    /// The thread its ending programs start on.
    spawner: Spawner,
    /// The daemon's `console` mode, which ends it on Windows.
    console_helper: Arc<CommandLine>,
    /// Set once an outright end of its tree began, so the drain counts its exit as forced.
    is_escalated: AtomicBool,
}

impl ChildEnding for TerminalEntry {
    fn process_id(&self) -> Option<u32> {
        self.control.process_id()
    }

    fn send_signal(&self, signal: TerminalSignal) -> io::Result<()> {
        self.control.send_signal(signal)
    }

    fn write_interrupt(&self) -> impl Future<Output = Result<(), TerminalWriteError>> + Send {
        self.control.write(Bytes::from_static(&[0x03]))
    }

    fn send_console_break(&self, process_id: u32) -> impl Future<Output = io::Result<()>> + Send {
        let arguments: Vec<OsString> = self
            .console_helper
            .arguments
            .iter()
            .map(OsString::from)
            .collect();
        async move {
            sidekicks_platforms::run_console_helper(
                &self.spawner,
                OsStr::new(&self.console_helper.program),
                &arguments,
                process_id,
            )
            .await
        }
    }

    fn end_tree(&self, process_id: u32) -> impl Future<Output = io::Result<ProcessTreeEnd>> + Send {
        self.is_escalated.store(true, Ordering::SeqCst);
        sidekicks_platforms::end_process_tree(&self.spawner, process_id)
    }

    fn has_child_exited(&self) -> bool {
        self.control.has_child_exited()
    }

    fn child_exited(&self) -> impl Future<Output = ()> + Send {
        self.control.child_exited()
    }

    fn report_forced_end(&self) {
        self.control.report_forced_end();
    }
}
