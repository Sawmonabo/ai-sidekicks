//! What the shell table holds for one shell of a session: its control lease, input, flow control
//! and size queue, the listener on its screen copy, its marks and how it stands, each terminal call
//! naming the shell's terminal while it runs. A change of holder closes a paste the shell had open
//! and forgets the appearance the last holder's pane reported. The record is what each of the
//! shell's output streams reads from, and ending a stream ends what its subscription carried.

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use bytes::Bytes;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TerminalColors, TerminalId, TerminalShellStatus};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_terminal::{
    OutputFilter, ScrollbackRead, TerminalAnswers, TerminalError, TerminalHandle, TerminalScreen,
    TerminalWriteError, Terminals,
};
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::control_lease::{
    EndedCallerCheck, LeaseBroadcast, LeaseReading, ShellControlLease, ShellLeaseCaller,
};
use crate::flow_control::{ReadChange, ShellFlowControl};
use crate::integration::injection::ShellMarkNonce;
use crate::integration::marks::{ShellMark, ShellMarkReader};
use crate::list::ShellListFollowers;
use crate::output::screen::{
    ShellScreenAppearance, ShellScreenHooks, ShellScreenListener, is_bracketed_paste_requested,
};
use crate::output::stream::{ShellOutputEnd, ShellOutputSource};
use crate::refusals::{output_subscription_not_found, terminal_not_found};
use crate::resize::{ResizeTerminal, ShellResizeError, ShellResizeQueue, ShellSize};
use crate::start::INITIAL_SHELL_SIZE;
use crate::write::{ShellInput, ShellInputHooks};
use sidekicks_ipc::registry::TransportId;

/// A shell's screen copy and scrollback window, as the terminal shares them with its read loop.
pub(crate) type ShellScreen = Arc<Mutex<TerminalScreen<ShellScreenListener>>>;

/// What every record of the table calls out to.
pub(crate) struct ShellRecordDeps {
    /// The daemon's terminals.
    pub(crate) terminals: Arc<Terminals>,
    /// This machine's own device id, which a run's hold names.
    pub(crate) machine_device_id: DeviceId,
    /// What a shell's terminal answers a program asking its name and version.
    pub(crate) terminal_version: String,
    /// Appends one change of a shell's holder to its session's event log.
    pub(crate) append_control_change: LeaseBroadcast,
    /// The console theme's terminal colors the desktop last reported, for a shell whose holder
    /// reported none.
    pub(crate) console_colors: Arc<Mutex<Option<Arc<TerminalColors>>>>,
    /// The daemon's runtime, which a record's work started from a drop runs on.
    pub(crate) runtime: Handle,
}

/// Whether a shell reports its marks, and whether a device typed into it since its last prompt
/// mark; the read loop's mark filter sets them.
#[derive(Default)]
pub(crate) struct ShellMarkState {
    is_reporting: AtomicBool,
    has_input_since_prompt: AtomicBool,
}

/// The read loop's filter that takes a shell's marks out of its output before the screen copy and
/// the scrollback see it, noting each prompt mark in the shell's mark state.
pub(crate) struct ShellMarkFilter {
    reader: ShellMarkReader,
    marks: Vec<ShellMark>,
    state: Arc<ShellMarkState>,
}

impl OutputFilter for ShellMarkFilter {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        self.marks.clear();
        self.reader.read(chunk, kept, &mut self.marks);
        if self
            .marks
            .iter()
            .any(|mark| matches!(mark, ShellMark::Prompt { .. }))
        {
            self.state
                .has_input_since_prompt
                .store(false, Ordering::SeqCst);
            self.state.is_reporting.store(true, Ordering::SeqCst);
        }
    }

    fn finish(&mut self, kept: &mut Vec<u8>) {
        self.reader.finish(kept);
    }
}

/// How a shell's record stands, read and changed only under its lock, never held across an await
/// and never taken while the screen's lock is wanted.
struct ShellRecordState {
    status: TerminalShellStatus,
    /// The terminal while the shell runs.
    handle: Option<TerminalHandle>,
    /// The screen copy and scrollback, kept after the program exits for its window.
    screen: Option<ShellScreen>,
    size: ShellSize,
    /// The colors and cell size the holding pane last reported, until the shell changes holder.
    pane_appearance: Option<ShellScreenAppearance>,
    /// The file the shell reads its nonce from, until the shell has read it or never will.
    mark_nonce: Option<ShellMarkNonce>,
    /// The nonce the orphan registry knows the shell's process by, until it is retired.
    spawn_nonce: Option<String>,
    /// Each open output subscription and its connection.
    streams: HashMap<SubscriptionId, TransportId>,
    /// Set once the shell left its session.
    is_removed: bool,
}

/// One shell of a session, as the shell table holds it.
pub(crate) struct ShellRecord {
    /// The shell's session.
    pub(crate) session_id: SessionId,
    /// The shell.
    pub(crate) terminal_id: TerminalId,
    /// The key the open that made it carried.
    pub(crate) client_idempotency_key: ClientUuid,
    /// The base name of the program started, its title until it sets its own.
    pub(crate) program_name: String,
    /// Who may write to it, size it and close it.
    pub(crate) lease: Arc<ShellControlLease>,
    /// Its input on its way to the terminal.
    pub(crate) input: Arc<ShellInput>,
    /// The listener on its screen copy, which keeps the title the program set.
    pub(crate) listener: ShellScreenListener,
    /// Its marks' state, shared with the mark filter.
    pub(crate) marks: Arc<ShellMarkState>,
    /// Signals each chunk of output and each change of how the shell stands to its streams.
    pub(crate) progress: watch::Sender<ShellOutputEnd>,
    /// The answers the terminal takes for the program, once the shell started.
    answers: OnceLock<TerminalAnswers>,
    flow_control: Mutex<ShellFlowControl>,
    resize_queue: ShellResizeQueue,
    state: Mutex<ShellRecordState>,
    deps: Arc<ShellRecordDeps>,
    list: ShellListFollowers,
}

impl ShellRecord {
    /// A new shell's record, not yet started, at the size every shell starts at; `list` is its
    /// session's list, sent again on each change of holder or title.
    pub(crate) fn new(
        session_id: SessionId,
        terminal_id: TerminalId,
        client_idempotency_key: ClientUuid,
        program_name: String,
        deps: Arc<ShellRecordDeps>,
        list: ShellListFollowers,
    ) -> Arc<Self> {
        Arc::new_cyclic(|record: &Weak<Self>| {
            let lease = Arc::new(ShellControlLease::new(
                session_id,
                terminal_id.clone(),
                deps.machine_device_id.clone(),
                broadcast_change(record.clone(), Arc::clone(&deps.append_control_change)),
                refuse_ended_caller(record.clone(), terminal_id.clone()),
            ));
            let input = ShellInput::new(
                terminal_id.clone(),
                Arc::clone(&lease),
                input_hooks(record.clone()),
                deps.runtime.clone(),
            );
            let listener =
                ShellScreenListener::new(screen_hooks(record, &deps), INITIAL_SHELL_SIZE);
            Self {
                session_id,
                terminal_id,
                client_idempotency_key,
                program_name,
                lease,
                input,
                listener,
                marks: Arc::new(ShellMarkState::default()),
                progress: watch::Sender::new(ShellOutputEnd::Running),
                answers: OnceLock::new(),
                flow_control: Mutex::new(ShellFlowControl::new()),
                resize_queue: ShellResizeQueue::new(resize_terminal(record.clone())),
                state: Mutex::new(ShellRecordState {
                    status: TerminalShellStatus::Running {},
                    handle: None,
                    screen: None,
                    size: INITIAL_SHELL_SIZE,
                    pane_appearance: None,
                    mark_nonce: None,
                    spawn_nonce: None,
                    streams: HashMap::new(),
                    is_removed: false,
                }),
                deps,
                list,
            }
        })
    }

    /// The listener the terminal's screen copy reports to, keeping `answers` for the program's
    /// answers; the terminal's spawn calls it once, through the one-shot closure it takes.
    pub(crate) fn listen(&self, answers: TerminalAnswers) -> ShellScreenListener {
        self.answers.get_or_init(|| answers);
        self.listener.clone()
    }

    /// The mark filter the terminal's read loop takes the shell's marks out with, by `nonce`.
    pub(crate) fn mark_filter(&self, nonce: &str) -> ShellMarkFilter {
        ShellMarkFilter {
            reader: ShellMarkReader::new(nonce),
            marks: Vec::new(),
            state: Arc::clone(&self.marks),
        }
    }

    /// Records the shell started on `handle` with `screen`, its nonces held until it ends.
    pub(crate) fn record_started(
        &self,
        handle: TerminalHandle,
        screen: ShellScreen,
        mark_nonce: ShellMarkNonce,
        spawn_nonce: String,
    ) {
        let mut state = self.lock_state();
        state.handle = Some(handle);
        state.screen = Some(screen);
        state.mark_nonce = Some(mark_nonce);
        state.spawn_nonce = Some(spawn_nonce);
    }

    /// Records that the shell could not start, for `cause`.
    pub(crate) fn record_did_not_start(&self, cause: String) {
        let cause = NonEmptyText::new(cause).unwrap_or_else(|| {
            NonEmptyText::new("the shell could not be started".to_owned())
                .expect("the fixed cause is not empty")
        });
        self.lock_state().status = TerminalShellStatus::DidNotStart { cause };
        self.progress.send_replace(ShellOutputEnd::DidNotStart);
    }

    /// How the shell's process stands.
    pub(crate) fn status(&self) -> TerminalShellStatus {
        self.lock_state().status.clone()
    }

    /// The terminal while the shell runs.
    pub(crate) fn handle(&self) -> Option<TerminalHandle> {
        self.lock_state().handle
    }

    /// Whether the shell has left its session.
    pub(crate) fn is_removed(&self) -> bool {
        self.lock_state().is_removed
    }

    /// Whether the shell reports its prompt and command marks.
    pub(crate) fn is_reporting_marks(&self) -> bool {
        self.marks.is_reporting.load(Ordering::SeqCst)
    }

    /// Whether a device typed into the shell since its last prompt mark.
    pub(crate) fn has_input_since_prompt(&self) -> bool {
        self.marks.has_input_since_prompt.load(Ordering::SeqCst)
    }

    /// The nonce file once the shell has marked a prompt with its nonce, so it has read it, taken
    /// so it is removed once.
    pub(crate) fn take_read_mark_nonce(&self) -> Option<ShellMarkNonce> {
        if !self.is_reporting_marks() {
            return None;
        }
        self.lock_state().mark_nonce.take()
    }

    /// Records the shell's end: its program's exit, its close or its leaving the session. Answers
    /// the terminal it ran on, if it still ran, and the nonces to discard and retire.
    pub(crate) fn record_end(
        &self,
        end: ShellOutputEnd,
        is_removed: bool,
    ) -> (
        Option<TerminalHandle>,
        Option<ShellMarkNonce>,
        Option<String>,
    ) {
        self.input.clear_pastes();
        let ended = {
            let mut state = self.lock_state();
            if let ShellOutputEnd::Exited { exit_code, .. } = end {
                state.status = TerminalShellStatus::Exited { exit_code };
            }
            state.is_removed |= is_removed;
            (
                state.handle.take(),
                state.mark_nonce.take(),
                state.spawn_nonce.take(),
            )
        };
        self.progress.send_replace(end);
        ended
    }

    /// Counts `transport_id` as a watcher of the shell for `subscription_id`.
    pub(crate) fn add_stream(&self, subscription_id: SubscriptionId, transport_id: TransportId) {
        self.lock_state()
            .streams
            .insert(subscription_id, transport_id);
        let change = self.lock_flow_control().add_watcher(transport_id);
        self.apply_read_change(change);
    }

    /// Records whether a connection fell behind on the shell, waking its streams.
    pub(crate) fn declare_flow_control(&self, transport_id: TransportId, is_behind: bool) {
        let change = self.lock_flow_control().declare(transport_id, is_behind);
        self.apply_read_change(change);
        self.progress.send_modify(|_| {});
    }

    /// Records a new size from the holding pane, for the terminal, the screen's answers and every
    /// later opening frame; answers the terminal's resize.
    pub(crate) fn resize(
        &self,
        size: ShellSize,
    ) -> BoxFuture<'static, Result<(), ShellResizeError>> {
        self.lock_state().size = size;
        self.listener.record_size(size);
        self.resize_queue.request(size).boxed()
    }

    /// Keeps the colors and cell size the holding pane reported, until the shell changes holder.
    pub(crate) fn set_pane_appearance(&self, appearance: ShellScreenAppearance) {
        self.lock_state().pane_appearance = Some(appearance);
    }

    /// The open output subscriptions and their connections.
    pub(crate) fn streams(&self) -> Vec<(SubscriptionId, TransportId)> {
        self.lock_state()
            .streams
            .iter()
            .map(|(subscription_id, transport_id)| (*subscription_id, *transport_id))
            .collect()
    }

    /// The output offset the shell's output has reached, its exit's cursor.
    pub(crate) fn output_offset(&self) -> u64 {
        let screen = self.lock_state().screen.clone();
        screen.map_or(0, |screen| lock_screen(&screen).scrollback().output_offset)
    }

    fn apply_read_change(&self, change: Option<ReadChange>) {
        let (Some(change), Some(handle)) = (change, self.handle()) else {
            return;
        };
        let applied = match change {
            ReadChange::Pause => self.deps.terminals.pause(handle),
            ReadChange::Resume => self.deps.terminals.resume(handle),
        };
        // A terminal no longer tracked has ended, and its read with it.
        if let Err(error) = applied {
            tracing::debug!(
                terminal = self.terminal_id.as_str(),
                error = &error as &(dyn Error + 'static),
                "a shell's read change found its terminal gone"
            );
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, ShellRecordState> {
        self.state
            .lock()
            .expect("no panic holds a shell's record, since a panic ends the daemon")
    }

    fn lock_flow_control(&self) -> MutexGuard<'_, ShellFlowControl> {
        self.flow_control
            .lock()
            .expect("no panic holds a shell's flow control, since a panic ends the daemon")
    }
}

impl ShellOutputSource for ShellRecord {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn terminal_id(&self) -> &TerminalId {
        &self.terminal_id
    }

    fn read_holder(&self) -> BoxFuture<'_, LeaseReading> {
        self.lease.read_holder().boxed()
    }

    fn read_window(&self) -> ScrollbackRead {
        let screen = self.lock_state().screen.clone();
        screen.map_or(
            ScrollbackRead {
                bytes: Vec::new(),
                output_offset: 0,
            },
            |screen| lock_screen(&screen).scrollback(),
        )
    }

    fn read_output_after(&self, offset: u64, max: usize) -> Option<Vec<u8>> {
        let screen = self.lock_state().screen.clone();
        match screen {
            Some(screen) => lock_screen(&screen).output_after(offset, max),
            None => (offset == 0).then(Vec::new),
        }
    }

    fn size(&self) -> ShellSize {
        self.lock_state().size
    }

    fn is_connection_behind(&self, transport_id: TransportId) -> bool {
        self.lock_flow_control().is_behind(transport_id)
    }

    fn end_output_subscription(&self, subscription_id: SubscriptionId, transport_id: TransportId) {
        let is_last_of_connection = {
            let mut state = self.lock_state();
            if state.streams.remove(&subscription_id).is_none() {
                return;
            }
            !state.streams.values().any(|other| *other == transport_id)
        };
        if is_last_of_connection {
            let change = self.lock_flow_control().remove_watcher(transport_id);
            self.apply_read_change(change);
        }
        let lease = Arc::clone(&self.lease);
        let terminal_id = self.terminal_id.clone();
        self.deps.runtime.spawn(async move {
            if let Err(error) = lease.release_subscriptions(&[subscription_id]).await {
                tracing::warn!(
                    terminal = terminal_id.as_str(),
                    error = &error as &(dyn Error + 'static),
                    "a shell's hold could not be released as a pane closed"
                );
            }
        });
        self.input.close_paste_of(subscription_id);
    }
}

fn lock_screen(screen: &ShellScreen) -> MutexGuard<'_, TerminalScreen<ShellScreenListener>> {
    screen
        .lock()
        .expect("no panic holds a shell's screen, since a panic ends the daemon")
}

// Each change of holder forgets the last holder's pane appearance and closes a paste the shell
// had open, then is appended, and the session's list is sent again either way.
fn broadcast_change(record: Weak<ShellRecord>, append: LeaseBroadcast) -> LeaseBroadcast {
    Arc::new(move |change| {
        let record = record.upgrade();
        if let Some(record) = &record {
            record.lock_state().pane_appearance = None;
            record.input.close_open_paste();
        }
        let appended = append(change);
        async move {
            let appended = appended.await;
            if let Some(record) = record {
                record.list.mark_changed();
            }
            appended
        }
        .boxed()
    })
}

// Refuses a caller whose shell left its session, or whose pane subscription is not its own open
// one to this shell.
fn refuse_ended_caller(record: Weak<ShellRecord>, terminal_id: TerminalId) -> EndedCallerCheck {
    Arc::new(move |caller: &ShellLeaseCaller| {
        let Some(record) = record.upgrade() else {
            return Err(terminal_not_found(&terminal_id));
        };
        let state = record.lock_state();
        if state.is_removed {
            return Err(terminal_not_found(&terminal_id));
        }
        if state.streams.get(&caller.output_subscription_id)
            != Some(&caller.connection.transport_id)
        {
            return Err(output_subscription_not_found(
                &terminal_id,
                &caller.output_subscription_id,
            ));
        }
        Ok(())
    })
}

// The input's way to the terminal while the shell runs; a write after its end goes nowhere.
fn input_hooks(record: Weak<ShellRecord>) -> ShellInputHooks {
    let writer = record.clone();
    let answerer = record.clone();
    ShellInputHooks {
        queue_write: Box::new(move |bytes: Bytes| {
            let queued = writer.upgrade().map(|record| {
                record
                    .marks
                    .has_input_since_prompt
                    .store(true, Ordering::SeqCst);
                record
                    .handle()
                    .map(|handle| record.deps.terminals.queue_write(handle, bytes))
            });
            async move {
                match queued {
                    Some(Some(Ok(taken))) => taken.taken().await,
                    Some(Some(Err(TerminalError::Write(error)))) => Err(error),
                    Some(Some(Err(_unknown))) => Err(TerminalWriteError::Closed),
                    Some(None) => Err(TerminalWriteError::Ended),
                    None => Err(TerminalWriteError::Closed),
                }
            }
            .boxed()
        }),
        queue_answer: Box::new(move |answer: Bytes| {
            if let Some(record) = answerer.upgrade()
                && let Some(answers) = record.answers.get()
            {
                answers.queue(answer);
            }
        }),
        is_bracketed_paste_requested: Box::new(move || {
            record
                .upgrade()
                .and_then(|record| record.lock_state().screen.clone())
                .is_some_and(|screen| is_bracketed_paste_requested(&lock_screen(&screen)))
        }),
    }
}

// The screen copy's appearance from the holding pane, else the console theme; its answers go to
// the shell's input; a new title sends the session's list again.
fn screen_hooks(record: &Weak<ShellRecord>, deps: &Arc<ShellRecordDeps>) -> ShellScreenHooks {
    let reader = record.clone();
    let answerer = record.clone();
    let titler = record.clone();
    let console_colors = Arc::clone(&deps.console_colors);
    ShellScreenHooks {
        terminal_version: deps.terminal_version.clone(),
        read_appearance: Box::new(move || {
            let pane = reader
                .upgrade()
                .and_then(|record| record.lock_state().pane_appearance.clone());
            let console = console_colors
                .lock()
                .expect("no panic holds the console colors, since a panic ends the daemon")
                .clone();
            ShellScreenAppearance {
                colors: pane
                    .as_ref()
                    .and_then(|pane| pane.colors.clone())
                    .or(console),
                cell_size: pane.and_then(|pane| pane.cell_size),
            }
        }),
        answer: Box::new(move |answer| {
            if let Some(record) = answerer.upgrade() {
                record.input.answer(answer);
            }
        }),
        report_title_change: Box::new(move || {
            if let Some(record) = titler.upgrade() {
                record.list.mark_changed();
            }
        }),
    }
}

// Applies a size to the terminal while the shell runs; a shell that stopped keeps it as the size
// it was last drawn at.
fn resize_terminal(record: Weak<ShellRecord>) -> ResizeTerminal {
    Box::new(move |size: ShellSize| {
        let running = record
            .upgrade()
            .and_then(|record| record.handle().map(|handle| (record, handle)));
        async move {
            match running {
                Some((record, handle)) => {
                    record
                        .deps
                        .terminals
                        .resize(handle, size.rows, size.columns)
                        .await
                }
                None => Ok(()),
            }
        }
        .boxed()
    })
}
