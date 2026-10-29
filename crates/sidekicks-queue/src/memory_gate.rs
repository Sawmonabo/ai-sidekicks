//! The memory gate: what admits a person's run, an ingest worker or a workflow step to start.
//!
//! Ready entries wait in one line in the order they became ready; the gate weighs only the head,
//! against the machine's available memory read afresh, less a headroom, less the reservation of
//! everything admitted and not yet finished. When nothing is admitted the head starts whatever its
//! size, so work never stalls on a full machine. A start whose size is an estimate waits 1.5 s
//! after the last such start, so the reading shows the first one's growth before the next is
//! weighed. The gate weighs when an entry joins the line or gives up its reservation, when the
//! spacing ends, when the caller's tick asks, and once a second while the head waits for memory,
//! so memory another program frees is seen; with nothing waiting no timer runs.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::io;
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use sidekicks_provider::driver::ProviderDescriptor;
use tokio::sync::{Notify, watch};
use tokio::task::JoinError;
use tokio::time::{Instant, sleep_until};

const MEBIBYTE: u64 = 1024 * 1024;

/// Kept free of every reservation: a fifth of physical memory, and never less than 1 GiB.
const HEADROOM_FLOOR_BYTES: u64 = 1024 * MEBIBYTE;

const ESTIMATED_START_SPACING: Duration = Duration::from_millis(1_500);

/// How often the reading is taken again while the head waits for memory: one read of the system's
/// available memory a second, and none while nothing waits.
const WAITING_REWEIGH: Duration = Duration::from_secs(1);

/// A bun or Python step's interpreter footprint, its reservation until a peak is learned here.
const SCRIPT_STARTING_BYTES: u64 = 160 * MEBIBYTE;

/// What each pixel an ingest worker draws costs.
const INGEST_BYTES_PER_PIXEL: u64 = 9;

/// A quick Code step's thread beyond its interpreter's budget, the gate's
/// [`MemoryGateFigures::quick_thread_bytes`].
pub const QUICK_THREAD_BYTES: u64 = 32 * MEBIBYTE;

/// An ingest worker's own memory beyond the file it reads and the picture it draws, the gate's
/// [`MemoryGateFigures::ingest_worker_bytes`].
pub const INGEST_WORKER_BYTES: u64 = 128 * MEBIBYTE;

/// Reads the bytes the system can give now; blocking, so the gate calls it off the runtime.
pub(crate) type AvailableMemoryRead = Arc<dyn Fn() -> io::Result<u64> + Send + Sync>;

/// Reads the peak memory a process has reached, `None` once the process is gone or unreadable;
/// blocking, so the gate calls it off the runtime.
pub(crate) type ProcessPeakRead = Arc<dyn Fn(u32) -> io::Result<Option<u64>> + Send + Sync>;

/// The machine's figures the gate weighs by, each in bytes.
#[derive(Clone, Copy, Debug)]
pub struct MemoryGateFigures {
    /// The machine's physical memory, which sets the headroom.
    pub physical_memory_bytes: u64,
    /// A quick Code step's thread beyond its interpreter's budget.
    pub quick_thread_bytes: u64,
    /// An ingest worker's own memory beyond the file it reads and the picture it draws.
    pub ingest_worker_bytes: u64,
}

/// A provider start's footprint, its figures from the provider's descriptor: a new process of the
/// provider or one more conversation on a running one, each keeping its own learned peak.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ProviderStartEstimate {
    provider_id: &'static str,
    is_conversation: bool,
    starting_bytes: u64,
}

impl ProviderStartEstimate {
    /// The estimate of one start of `descriptor`'s provider: a conversation joining a running
    /// process of it where `joins_running_process` and the provider runs conversations that way,
    /// else a new process.
    pub(crate) fn new(descriptor: &ProviderDescriptor, joins_running_process: bool) -> Self {
        let conversation_bytes = descriptor
            .memory
            .conversation_bytes
            .filter(|_| joins_running_process);
        Self {
            provider_id: descriptor.id,
            is_conversation: conversation_bytes.is_some(),
            starting_bytes: conversation_bytes.unwrap_or(descriptor.memory.process_bytes),
        }
    }

    fn estimated_kind(&self) -> EstimatedKind {
        EstimatedKind::Provider {
            provider_id: self.provider_id,
            is_conversation: self.is_conversation,
        }
    }
}

/// The interpreter a script step runs in.
#[expect(dead_code, reason = "the workflow engine's bun and Python steps")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ScriptRuntime {
    /// Bun.
    Bun,
    /// Python.
    Python,
}

/// What an admitted entry runs, which sets its reservation. A provider process and a script step
/// are estimates, replaced by the peak their workflow node, or else their kind, last reached; a
/// quick Code step reserves its budget, replaced by its node's interpreter peak, plus its thread,
/// its input and its output; an ingest worker reserves its file, its picture and its own memory.
/// `workflow_node_key` names the workflow node an entry runs, unique across workflows.
#[expect(
    dead_code,
    reason = "the workflow engine's script and quick Code steps and the ingest worker"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionWork {
    /// A provider process.
    Provider {
        /// Its starting footprint.
        start: ProviderStartEstimate,
        /// The workflow node it runs, `None` for a person's run.
        workflow_node_key: Option<String>,
    },
    /// A bun or Python step.
    Script {
        /// Its interpreter.
        runtime: ScriptRuntime,
        /// The workflow node it runs.
        workflow_node_key: Option<String>,
    },
    /// A quick Code step.
    QuickCode {
        /// Its interpreter's memory budget.
        budget_bytes: u64,
        /// Its input text, moved into its thread.
        input_bytes: u64,
        /// The most output text it may return.
        output_max_bytes: u64,
        /// The workflow node it runs.
        workflow_node_key: String,
    },
    /// An ingest worker.
    Ingest {
        /// The file it reads.
        file_bytes: u64,
        /// The pixels of the picture it draws.
        picture_pixels: u64,
    },
}

/// The start a provider or script entry's estimate and learned peak belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum EstimatedKind {
    Provider {
        provider_id: &'static str,
        is_conversation: bool,
    },
    Script(ScriptRuntime),
}

impl AdmissionWork {
    fn estimated_kind(&self) -> Option<EstimatedKind> {
        match self {
            Self::Provider { start, .. } => Some(start.estimated_kind()),
            Self::Script { runtime, .. } => Some(EstimatedKind::Script(*runtime)),
            Self::QuickCode { .. } | Self::Ingest { .. } => None,
        }
    }

    fn workflow_node_key(&self) -> Option<&str> {
        match self {
            Self::Provider {
                workflow_node_key, ..
            }
            | Self::Script {
                workflow_node_key, ..
            } => workflow_node_key.as_deref(),
            Self::QuickCode {
                workflow_node_key, ..
            } => Some(workflow_node_key),
            Self::Ingest { .. } => None,
        }
    }
}

/// Where an admission stands: in the line, holding its reservation, or parked on a person or a
/// provider limit and holding nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryAdmissionState {
    /// In the line.
    Waiting,
    /// Holding its reservation.
    Admitted,
    /// Waiting on a person or a provider limit, holding nothing.
    Parked,
}

/// How a wait in the line ended: admitted, or released before its turn came.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionOutcome {
    /// Admitted.
    Admitted,
    /// Released before its turn came.
    Withdrawn,
}

/// A use of an admission its state does not allow, or a peak read that failed.
#[derive(Debug, thiserror::Error)]
pub enum MemoryAdmissionError {
    /// The admission's state does not allow the act.
    #[error("a memory admission that is {state:?} cannot {act}")]
    WrongState {
        /// Where the admission stood.
        state: MemoryAdmissionState,
        /// What was asked of it.
        act: &'static str,
    },
    /// The process's peak could not be read.
    #[error("the process's peak memory could not be read")]
    ReadPeak(#[source] io::Error),
    /// The peak read stopped before it answered.
    #[error("the process's peak memory read stopped before it answered")]
    PeakReadStopped(#[source] JoinError),
}

type EntryId = u64;

struct AdmissionEntry {
    work: AdmissionWork,
    state: MemoryAdmissionState,
    held_bytes: u64,
    observed_peak_bytes: Option<u64>,
    outcome: watch::Sender<Option<AdmissionOutcome>>,
}

struct GateState {
    line: VecDeque<EntryId>,
    entries: HashMap<EntryId, AdmissionEntry>,
    next_entry_id: EntryId,
    learned_peak_by_node: HashMap<String, u64>,
    learned_peak_by_kind: HashMap<EstimatedKind, u64>,
    held_bytes: u64,
    admitted_count: usize,
    // The last estimated start still admitted, and when it started: an ended one spaces nothing.
    last_estimated_start: Option<(EntryId, Instant)>,
}

struct GateShared {
    figures: MemoryGateFigures,
    headroom_bytes: u64,
    read_available: AvailableMemoryRead,
    read_peak: ProcessPeakRead,
    state: Mutex<GateState>,
    /// Wakes the weighing task when the line or a reservation changes, or the gate ends.
    changed: Arc<Notify>,
}

impl Drop for GateShared {
    fn drop(&mut self) {
        // The weighing task holds only a weak reference; waking it lets it see the gate is gone.
        self.changed.notify_one();
    }
}

/// What one weigh found: nothing waits, the head waits until an instant, or a fresh reading of
/// the machine's available memory is needed.
enum Weighed {
    Idle,
    WaitUntil(Instant),
    NeedsReading,
}

/// The daemon's one memory gate. Learned peaks live only in its memory, so a restart re-learns.
/// Made inside a tokio runtime, whose task does the weighing.
pub struct MemoryGate {
    shared: Arc<GateShared>,
}

impl MemoryGate {
    /// The gate over the machine `figures` describe, reading its available memory through
    /// `read_available` and a process's peak through `read_peak`. Must be called inside a tokio
    /// runtime.
    pub fn new(
        figures: MemoryGateFigures,
        read_available: AvailableMemoryRead,
        read_peak: ProcessPeakRead,
    ) -> Self {
        let changed = Arc::new(Notify::new());
        let shared = Arc::new(GateShared {
            figures,
            headroom_bytes: (figures.physical_memory_bytes / 5).max(HEADROOM_FLOOR_BYTES),
            read_available,
            read_peak,
            state: Mutex::new(GateState {
                line: VecDeque::new(),
                entries: HashMap::new(),
                next_entry_id: 0,
                learned_peak_by_node: HashMap::new(),
                learned_peak_by_kind: HashMap::new(),
                held_bytes: 0,
                admitted_count: 0,
                last_estimated_start: None,
            }),
            changed: Arc::clone(&changed),
        });
        tokio::spawn(weigh_until_gone(Arc::downgrade(&shared), changed));
        Self { shared }
    }

    /// Puts `work` at the tail of the line; its `admitted()` answers once the gate admits it.
    pub(crate) fn enqueue(&self, work: AdmissionWork) -> MemoryAdmission {
        let mut state = self.shared.lock();
        let id = state.next_entry_id;
        state.next_entry_id += 1;
        let (outcome, _) = watch::channel(None);
        state.entries.insert(
            id,
            AdmissionEntry {
                work,
                state: MemoryAdmissionState::Waiting,
                held_bytes: 0,
                observed_peak_bytes: None,
                outcome,
            },
        );
        state.line.push_back(id);
        drop(state);
        self.shared.changed.notify_one();
        MemoryAdmission {
            shared: Arc::clone(&self.shared),
            id,
        }
    }

    /// Weighs the head against a fresh reading; the caller's tick calls it to see memory freed.
    pub(crate) fn weigh(&self) {
        self.shared.changed.notify_one();
    }
}

/// One entry's place in the gate, from joining the line until it is dropped.
pub(crate) struct MemoryAdmission {
    shared: Arc<GateShared>,
    id: EntryId,
}

impl MemoryAdmission {
    /// Where the admission stands.
    pub(crate) fn state(&self) -> MemoryAdmissionState {
        self.shared.lock().entry(self.id).state
    }

    /// The outcome of the latest wait in the line, `None` while it waits.
    pub(crate) fn admitted(&self) -> watch::Receiver<Option<AdmissionOutcome>> {
        self.shared.lock().entry(self.id).outcome.subscribe()
    }

    /// Reads the peak of process `process_id`, which the entry runs, and keeps the largest seen
    /// for the release to learn; a process no longer readable adds nothing. Refused unless
    /// admitted or parked; fails when the read does.
    pub(crate) async fn observe_process_peak(
        &self,
        process_id: u32,
    ) -> Result<(), MemoryAdmissionError> {
        self.require(
            "observe a process peak",
            &[MemoryAdmissionState::Admitted, MemoryAdmissionState::Parked],
        )?;
        let read_peak = Arc::clone(&self.shared.read_peak);
        let peak_bytes = tokio::task::spawn_blocking(move || read_peak(process_id))
            .await
            .map_err(MemoryAdmissionError::PeakReadStopped)?
            .map_err(MemoryAdmissionError::ReadPeak)?;
        if let Some(peak_bytes) = peak_bytes {
            keep_peak(self.shared.lock().entry_mut(self.id), peak_bytes);
        }
        Ok(())
    }

    /// Keeps a quick step's interpreter peak, in bytes, for the release to learn. Refused unless
    /// admitted or parked.
    #[expect(
        dead_code,
        reason = "the workflow step runner reports a quick Code step's interpreter peak here"
    )]
    pub(crate) fn observe_interpreter_peak(
        &self,
        peak_bytes: u64,
    ) -> Result<(), MemoryAdmissionError> {
        let mut state = self.shared.lock();
        let entry = state.entry_mut(self.id);
        require(
            entry,
            "observe an interpreter peak",
            &[MemoryAdmissionState::Admitted, MemoryAdmissionState::Parked],
        )?;
        keep_peak(entry, peak_bytes);
        Ok(())
    }

    /// Gives up the reservation while the entry waits on a person or a provider limit. Refused
    /// unless admitted.
    pub(crate) fn park(&self) -> Result<(), MemoryAdmissionError> {
        let mut state = self.shared.lock();
        require(
            state.entry(self.id),
            "park",
            &[MemoryAdmissionState::Admitted],
        )?;
        state.free_reservation(self.id);
        state.entry_mut(self.id).state = MemoryAdmissionState::Parked;
        drop(state);
        self.shared.changed.notify_one();
        Ok(())
    }

    /// Rejoins the line at its tail after a park, taking a reservation again at admission; its
    /// `admitted()` reads `None` until then. Refused unless parked.
    pub(crate) fn resume(&self) -> Result<(), MemoryAdmissionError> {
        let mut state = self.shared.lock();
        let entry = state.entry_mut(self.id);
        require(entry, "resume", &[MemoryAdmissionState::Parked])?;
        entry.state = MemoryAdmissionState::Waiting;
        entry.outcome.send_replace(None);
        state.line.push_back(self.id);
        drop(state);
        self.shared.changed.notify_one();
        Ok(())
    }

    fn require(
        &self,
        act: &'static str,
        allowed: &[MemoryAdmissionState],
    ) -> Result<(), MemoryAdmissionError> {
        require(self.shared.lock().entry(self.id), act, allowed)
    }
}

impl Drop for MemoryAdmission {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        match state.entry(self.id).state {
            MemoryAdmissionState::Waiting => {
                state.line.retain(|id| *id != self.id);
            }
            MemoryAdmissionState::Admitted => state.free_reservation(self.id),
            MemoryAdmissionState::Parked => {}
        }
        let entry = state
            .entries
            .remove(&self.id)
            .expect("an admission's entry lives until the admission is dropped");
        entry.outcome.send_if_modified(|outcome| {
            let is_waiting = outcome.is_none();
            if is_waiting {
                *outcome = Some(AdmissionOutcome::Withdrawn);
            }
            is_waiting
        });
        state.learn(&entry);
        drop(state);
        self.shared.changed.notify_one();
    }
}

fn require(
    entry: &AdmissionEntry,
    act: &'static str,
    allowed: &[MemoryAdmissionState],
) -> Result<(), MemoryAdmissionError> {
    if allowed.contains(&entry.state) {
        Ok(())
    } else {
        Err(MemoryAdmissionError::WrongState {
            state: entry.state,
            act,
        })
    }
}

fn keep_peak(entry: &mut AdmissionEntry, peak_bytes: u64) {
    entry.observed_peak_bytes = Some(entry.observed_peak_bytes.unwrap_or(0).max(peak_bytes));
}

impl GateShared {
    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state
            .lock()
            .expect("no panic holds the gate's lock, since a panic ends the daemon")
    }

    /// Admits from the head while it fits, against `room_bytes` once anything is admitted.
    fn weigh(&self, room_bytes: Option<u64>) -> Weighed {
        let mut state = self.lock();
        while let Some(&head) = state.line.front() {
            let work = &state.entry(head).work;
            let is_estimate = work.estimated_kind().is_some();
            if is_estimate
                && let Some((_, last)) = state.last_estimated_start
                && Instant::now() < last + ESTIMATED_START_SPACING
            {
                return Weighed::WaitUntil(last + ESTIMATED_START_SPACING);
            }
            let bytes = state.reservation_bytes(work, &self.figures);
            if state.admitted_count > 0 {
                let Some(room_bytes) = room_bytes else {
                    return Weighed::NeedsReading;
                };
                if bytes > room_bytes.saturating_sub(state.held_bytes) {
                    return Weighed::WaitUntil(Instant::now() + WAITING_REWEIGH);
                }
            }
            state.line.pop_front();
            if is_estimate {
                state.last_estimated_start = Some((head, Instant::now()));
            }
            state.held_bytes += bytes;
            state.admitted_count += 1;
            let entry = state.entry_mut(head);
            entry.state = MemoryAdmissionState::Admitted;
            entry.held_bytes = bytes;
            entry.outcome.send_replace(Some(AdmissionOutcome::Admitted));
        }
        Weighed::Idle
    }

    /// The machine's available memory less the headroom; a failed read is logged and read as no
    /// room, so the gate still admits one entry at a time.
    async fn read_room(&self) -> u64 {
        let read_available = Arc::clone(&self.read_available);
        let available = match tokio::task::spawn_blocking(move || read_available()).await {
            Ok(Ok(available)) => available,
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the available memory could not be read, so the gate admits one entry at a time"
                );
                0
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the available memory read stopped, so the gate admits one entry at a time"
                );
                0
            }
        };
        available.saturating_sub(self.headroom_bytes)
    }
}

impl GateState {
    fn entry(&self, id: EntryId) -> &AdmissionEntry {
        self.entries
            .get(&id)
            .expect("an admission's entry lives until the admission is dropped")
    }

    fn entry_mut(&mut self, id: EntryId) -> &mut AdmissionEntry {
        self.entries
            .get_mut(&id)
            .expect("an admission's entry lives until the admission is dropped")
    }

    fn reservation_bytes(&self, work: &AdmissionWork, figures: &MemoryGateFigures) -> u64 {
        let node_peak = work
            .workflow_node_key()
            .and_then(|key| self.learned_peak_by_node.get(key))
            .copied();
        match work {
            AdmissionWork::QuickCode {
                budget_bytes,
                input_bytes,
                output_max_bytes,
                ..
            } => {
                node_peak.unwrap_or(*budget_bytes)
                    + figures.quick_thread_bytes
                    + input_bytes
                    + output_max_bytes
            }
            AdmissionWork::Ingest {
                file_bytes,
                picture_pixels,
            } => file_bytes + picture_pixels * INGEST_BYTES_PER_PIXEL + figures.ingest_worker_bytes,
            AdmissionWork::Provider { start, .. } => node_peak
                .or_else(|| {
                    self.learned_peak_by_kind
                        .get(&start.estimated_kind())
                        .copied()
                })
                .unwrap_or(start.starting_bytes),
            AdmissionWork::Script { runtime, .. } => node_peak
                .or_else(|| {
                    self.learned_peak_by_kind
                        .get(&EstimatedKind::Script(*runtime))
                        .copied()
                })
                .unwrap_or(SCRIPT_STARTING_BYTES),
        }
    }

    fn free_reservation(&mut self, id: EntryId) {
        let entry = self.entry_mut(id);
        let held_bytes = std::mem::take(&mut entry.held_bytes);
        self.held_bytes -= held_bytes;
        self.admitted_count -= 1;
        if self
            .last_estimated_start
            .is_some_and(|(last, _)| last == id)
        {
            self.last_estimated_start = None;
        }
    }

    /// Keeps the entry's observed peak for its node and, beside a quick step's, for its kind: a
    /// quick step's interpreter peak is bounded by its own node's budget, so it is never a kind's.
    fn learn(&mut self, entry: &AdmissionEntry) {
        let Some(peak_bytes) = entry.observed_peak_bytes else {
            return;
        };
        if let AdmissionWork::Ingest { .. } = entry.work {
            return;
        }
        if let Some(key) = entry.work.workflow_node_key() {
            self.learned_peak_by_node.insert(key.to_owned(), peak_bytes);
        }
        if let Some(kind) = entry.work.estimated_kind() {
            self.learned_peak_by_kind.insert(kind, peak_bytes);
        }
    }
}

/// The gate's one weighing task: it weighs on each change and when its one timer falls due, and
/// ends once the gate and every admission are gone.
async fn weigh_until_gone(shared: Weak<GateShared>, changed: Arc<Notify>) {
    let mut wake = pin!(sleep_until(Instant::now()));
    let mut is_wake_armed = false;
    loop {
        if is_wake_armed {
            tokio::select! {
                () = changed.notified() => {}
                () = wake.as_mut() => {}
            }
        } else {
            changed.notified().await;
        }
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let mut room_bytes = None;
        loop {
            match shared.weigh(room_bytes) {
                Weighed::Idle => {
                    is_wake_armed = false;
                    break;
                }
                Weighed::WaitUntil(at) => {
                    wake.as_mut().reset(at);
                    is_wake_armed = true;
                    break;
                }
                Weighed::NeedsReading => room_bytes = Some(shared.read_room().await),
            }
        }
    }
}

#[cfg(test)]
mod tests;
