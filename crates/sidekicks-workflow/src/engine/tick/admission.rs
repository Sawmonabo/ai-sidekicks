//! A step's wait at the memory gate as the tick reports it, a hold written when it starts and
//! every 30 seconds while it lasts, and the order ready steps enter the gate in.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::engine::ports::StepAdmissionOutcome;
use crate::engine::tick::{StepReport, StepReportKind};

/// How often a held step repeats its `workflow.phase.waitingOnMemory` report while the hold lasts.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const MEMORY_WAIT_REPEAT: Duration = Duration::from_secs(30);

/// How a step's wait at the memory gate ended.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum GateWaitEnd {
    /// The gate admitted the step, and its `Admitted` report was sent.
    Admitted,
    /// The gate released the step before its turn, or its place closed.
    Withdrawn {
        /// When the hold began, `None` when the gate never held the step.
        hold_started_at: Option<WireInstant>,
    },
    /// The step was canceled while it waited.
    Canceled {
        /// When the hold began, `None` when no hold report went out before the cancel.
        hold_started_at: Option<WireInstant>,
    },
    /// The tick stopped taking reports, so the wait was given up.
    ReportsClosed,
}

/// Waits for the gate's answer on `admission` for `step`, reporting the hold on `reports`: a
/// `WaitingOnMemory` when it starts and every [`MEMORY_WAIT_REPEAT`] after, each carrying the
/// first's instant, then `Admitted`. A step the gate already decided reports no hold.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) async fn wait_at_gate(
    step: WorkflowStepKey,
    mut admission: watch::Receiver<Option<StepAdmissionOutcome>>,
    cancel: &CancellationToken,
    reports: &mpsc::Sender<StepReport>,
) -> GateWaitEnd {
    let decided = *admission.borrow_and_update();
    match decided {
        Some(StepAdmissionOutcome::Admitted) => {
            let admitted = StepReportKind::Admitted {
                hold_started_at: None,
            };
            return match send(reports, &step, WireInstant::now(), admitted).await {
                Ok(()) => GateWaitEnd::Admitted,
                Err(ReportsClosed) => GateWaitEnd::ReportsClosed,
            };
        }
        Some(StepAdmissionOutcome::Withdrawn) => {
            return GateWaitEnd::Withdrawn {
                hold_started_at: None,
            };
        }
        None => {}
    }
    let hold_started_at = WireInstant::now();
    if let Some(end) = send_hold(
        reports,
        &step,
        hold_started_at.clone(),
        &hold_started_at,
        false,
        cancel,
    )
    .await
    {
        return end;
    }
    let repeat = tokio::time::sleep(MEMORY_WAIT_REPEAT);
    tokio::pin!(repeat);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return GateWaitEnd::Canceled { hold_started_at: Some(hold_started_at) };
            }
            changed = admission.changed() => {
                if changed.is_err() {
                    return GateWaitEnd::Withdrawn { hold_started_at: Some(hold_started_at) };
                }
                let outcome = *admission.borrow_and_update();
                match outcome {
                    Some(StepAdmissionOutcome::Admitted) => {
                        let admitted = StepReportKind::Admitted {
                            hold_started_at: Some(hold_started_at),
                        };
                        return match send(reports, &step, WireInstant::now(), admitted).await {
                            Ok(()) => GateWaitEnd::Admitted,
                            Err(ReportsClosed) => GateWaitEnd::ReportsClosed,
                        };
                    }
                    Some(StepAdmissionOutcome::Withdrawn) => {
                        return GateWaitEnd::Withdrawn { hold_started_at: Some(hold_started_at) };
                    }
                    None => {}
                }
            }
            () = &mut repeat => {
                let at = WireInstant::now();
                let sent = send_hold(reports, &step, at, &hold_started_at, true, cancel);
                if let Some(end) = sent.await {
                    return end;
                }
                let next = repeat.deadline() + MEMORY_WAIT_REPEAT;
                repeat.as_mut().reset(next);
            }
        }
    }
}

// Sends `step`'s hold report made at `at`, unless `cancel` fires first, so a full channel never
// keeps a canceled step waiting; `Some` is how the wait ends. A cancel carries the hold's start
// only when `is_hold_reported`, an earlier hold report having gone out.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
async fn send_hold(
    reports: &mpsc::Sender<StepReport>,
    step: &WorkflowStepKey,
    at: WireInstant,
    hold_started_at: &WireInstant,
    is_hold_reported: bool,
    cancel: &CancellationToken,
) -> Option<GateWaitEnd> {
    let held = StepReportKind::WaitingOnMemory {
        hold_started_at: hold_started_at.clone(),
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => Some(GateWaitEnd::Canceled {
            hold_started_at: is_hold_reported.then(|| hold_started_at.clone()),
        }),
        sent = send(reports, step, at, held) => {
            sent.err().map(|ReportsClosed| GateWaitEnd::ReportsClosed)
        }
    }
}

/// The tick's report channel is closed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct ReportsClosed;

/// Sends `kind` for `step`, made at `at`, on `reports`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) async fn send(
    reports: &mpsc::Sender<StepReport>,
    step: &WorkflowStepKey,
    at: WireInstant,
    kind: StepReportKind,
) -> Result<(), ReportsClosed> {
    let report = StepReport {
        step: step.clone(),
        at,
        kind,
    };
    reports.send(report).await.map_err(|_closed| ReportsClosed)
}

/// Where the line of entries to the gate stands.
#[derive(Debug, Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct GateEntryPlaces {
    /// The place the next turn takes.
    next: u64,
    /// The lowest place whose turn is still open; every place below it is done.
    lowest_open: u64,
    /// The places above `lowest_open` whose turns are done.
    finished: BTreeSet<u64>,
}

/// The line state and the signal that it moved, shared by the order and its turns.
#[derive(Debug, Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct GateEntryLine {
    /// The places.
    places: Mutex<GateEntryPlaces>,
    /// Woken each time the lowest open place moves up.
    moved: Notify,
}

/// The order ready steps enter the memory gate in: the order their drivers take their turns, each
/// once its params are evaluated, so a step is ready for the gate when its evaluation ends and the
/// line keeps that order exactly; siblings readied in one turn take theirs in the order they were
/// readied, through their [`SiblingEntry`]. Clones share one line.
#[derive(Clone, Debug, Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct GateEntryOrder {
    /// The line its turns share.
    line: Arc<GateEntryLine>,
}

impl GateEntryOrder {
    /// The next turn in the line, behind every turn taken before it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn take_turn(&self) -> GateEntryTurn {
        let mut places = lock(&self.line.places);
        let place = places.next;
        places.next += 1;
        GateEntryTurn {
            line: Arc::clone(&self.line),
            place,
        }
    }

    /// The entries of `count` steps of one run readied in one turn, in the order the walk readied
    /// them, which is their nodes' order.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn sibling_entries(&self, count: usize) -> Vec<SiblingEntry> {
        let mut previous: Option<CancellationToken> = None;
        (0..count)
            .map(|_| {
                let released = CancellationToken::new();
                SiblingEntry {
                    order: self.clone(),
                    previous: previous.replace(released.clone()),
                    released,
                }
            })
            .collect()
    }
}

/// One step's place among the steps readied with it in one turn: it takes its turn in the line
/// only once the sibling before it has taken its own or given its place up, so the siblings enter
/// in the order they were readied whichever evaluation ends first, while a step readied in another
/// turn still enters as soon as its own evaluation ends. Dropping it gives its place up.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct SiblingEntry {
    /// The line it takes its turn in.
    order: GateEntryOrder,
    /// Canceled once the sibling before it has taken its turn or given its place up; `None` for
    /// the first sibling.
    previous: Option<CancellationToken>,
    /// Canceled when this entry is dropped, which releases the sibling after it.
    released: CancellationToken,
}

impl SiblingEntry {
    /// Waits for the sibling before it, takes the step's turn, which releases the sibling after
    /// it, and waits for that turn in the line, answering it; `None`, with no turn held, when
    /// `cancel` comes first.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) async fn wait_for_turn(self, cancel: &CancellationToken) -> Option<GateEntryTurn> {
        if let Some(previous) = &self.previous {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return None,
                () = previous.cancelled() => {}
            }
        }
        let turn = self.order.take_turn();
        drop(self);
        tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            () = turn.wait() => Some(turn),
        }
    }
}

impl Drop for SiblingEntry {
    fn drop(&mut self) {
        self.released.cancel();
    }
}

/// One step's turn to enter the gate. Dropping it marks the place done, whether the step entered
/// the gate or was abandoned, which releases the turn behind it.
#[derive(Debug)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct GateEntryTurn {
    /// The line it belongs to.
    line: Arc<GateEntryLine>,
    /// Its place in the line.
    place: u64,
}

impl GateEntryTurn {
    /// Returns once every turn taken before this one has been dropped.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) async fn wait(&self) {
        loop {
            let moved = self.line.moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            if lock(&self.line.places).lowest_open == self.place {
                return;
            }
            moved.await;
        }
    }
}

impl Drop for GateEntryTurn {
    fn drop(&mut self) {
        let mut places = lock(&self.line.places);
        if self.place != places.lowest_open {
            places.finished.insert(self.place);
            return;
        }
        places.lowest_open += 1;
        loop {
            let lowest_open = places.lowest_open;
            if !places.finished.remove(&lowest_open) {
                break;
            }
            places.lowest_open += 1;
        }
        drop(places);
        self.line.moved.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
    use tokio::sync::{mpsc, watch};
    use tokio::task::JoinHandle;
    use tokio_util::sync::CancellationToken;

    use super::{GateEntryOrder, GateWaitEnd, wait_at_gate};
    use crate::engine::ports::StepAdmissionOutcome;
    use crate::engine::tick::{StepReport, StepReportKind};

    /// The step every test waits for.
    fn step() -> WorkflowStepKey {
        serde_json::from_value(serde_json::json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": "step", "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads")
    }

    /// A wait at the gate for [`step`], run as its own task, with the gate's sender, the step's
    /// cancel and the reports it sends.
    fn start_wait(
        initial: Option<StepAdmissionOutcome>,
    ) -> (
        JoinHandle<GateWaitEnd>,
        watch::Sender<Option<StepAdmissionOutcome>>,
        CancellationToken,
        mpsc::Receiver<StepReport>,
    ) {
        let (gate, admission) = watch::channel(initial);
        let cancel = CancellationToken::new();
        let (reports, received) = mpsc::channel(8);
        let step_cancel = cancel.clone();
        let wait =
            tokio::spawn(
                async move { wait_at_gate(step(), admission, &step_cancel, &reports).await },
            );
        (wait, gate, cancel, received)
    }

    /// The hold instant of a `WaitingOnMemory` report, after checking it names [`step`].
    fn hold_of(report: StepReport) -> (WireInstant, WireInstant) {
        assert_eq!(report.step, step());
        let StepReportKind::WaitingOnMemory { hold_started_at } = report.kind else {
            panic!("the report is not a hold");
        };
        (report.at, hold_started_at)
    }

    /// Lets the waiting task run what the clock just woke.
    async fn settle() {
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
    }

    /// A held step reports its hold at once and again every 30 s, each repeat carrying the first
    /// report's instant, and its admission carries that instant too. Mutations: no repeat; a
    /// repeat carrying its own instant; the hold's start taken from the latest repeat; a repeat
    /// fired before 30 s.
    #[tokio::test(start_paused = true)]
    async fn a_hold_repeats_with_its_first_instant() {
        let (wait, gate, _cancel, mut received) = start_wait(None);
        let (first_at, first_hold) = hold_of(received.recv().await.expect("the hold is reported"));
        assert_eq!(first_hold, first_at);
        // The paused clock moves no wall time, so a real pause makes the repeat's own instant
        // differ from the first's, which the repeat must not carry.
        std::thread::sleep(Duration::from_millis(2));

        tokio::time::advance(Duration::from_secs(29)).await;
        settle().await;
        assert!(received.try_recv().is_err(), "a repeat came before 30 s");
        tokio::time::advance(Duration::from_secs(1)).await;
        settle().await;
        let (repeat_at, repeat_hold) = hold_of(received.try_recv().expect("the hold repeats"));
        assert_ne!(repeat_at, first_at);
        assert_eq!(repeat_hold, first_at);
        std::thread::sleep(Duration::from_millis(2));

        tokio::time::advance(Duration::from_secs(29)).await;
        settle().await;
        assert!(
            received.try_recv().is_err(),
            "a second repeat came before 30 s"
        );

        gate.send_replace(Some(StepAdmissionOutcome::Admitted));
        assert_eq!(wait.await.expect("the wait ends"), GateWaitEnd::Admitted);
        let admitted = received.recv().await.expect("the admission is reported");
        assert!(matches!(
            admitted.kind,
            StepReportKind::Admitted { hold_started_at: Some(ref hold) } if *hold == first_at
        ));
        assert!(received.recv().await.is_none());
    }

    /// What ends a wait at the gate.
    #[derive(Clone, Copy, Debug)]
    enum Ending {
        /// The gate had already admitted the step.
        AlreadyAdmitted,
        /// The step is canceled while held.
        Cancel,
        /// The gate drops its sender while the step is held.
        DropGate,
    }

    /// A step the gate already admitted reports no hold; a cancel or a closed gate ends a held
    /// wait at once with the hold's first instant. Mutations: a hold written for a step the gate
    /// already admitted; a cancel ignored while held, which the timeout catches.
    #[rstest]
    #[case::already_admitted(Ending::AlreadyAdmitted)]
    #[case::canceled_while_held(Ending::Cancel)]
    #[case::gate_dropped_while_held(Ending::DropGate)]
    #[tokio::test(start_paused = true)]
    async fn how_a_wait_ends(#[case] ending: Ending) {
        let initial =
            matches!(ending, Ending::AlreadyAdmitted).then_some(StepAdmissionOutcome::Admitted);
        let (wait, gate, cancel, mut received) = start_wait(initial);
        let first = received.recv().await.expect("the wait reports");
        let expected = match ending {
            Ending::AlreadyAdmitted => {
                assert!(matches!(
                    first.kind,
                    StepReportKind::Admitted {
                        hold_started_at: None
                    }
                ));
                GateWaitEnd::Admitted
            }
            Ending::Cancel => {
                let (first_at, _) = hold_of(first);
                cancel.cancel();
                GateWaitEnd::Canceled {
                    hold_started_at: Some(first_at),
                }
            }
            Ending::DropGate => {
                let (first_at, _) = hold_of(first);
                drop(gate);
                GateWaitEnd::Withdrawn {
                    hold_started_at: Some(first_at),
                }
            }
        };
        let end = tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("the wait ends before a repeat")
            .expect("the wait's task ends");
        assert_eq!(end, expected);
        assert!(received.recv().await.is_none());
    }

    /// A step canceled while its first hold report waits on a full channel ends `Canceled` at
    /// once, with no hold start, since no hold went out. Mutations: send the hold without watching
    /// the cancel; carry the start of a hold never reported.
    #[tokio::test(start_paused = true)]
    async fn a_hold_blocked_on_a_full_channel_still_ends_on_cancel() {
        let (_gate, admission) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (reports, _received) = mpsc::channel(1);
        reports
            .try_send(StepReport {
                step: step(),
                at: WireInstant::now(),
                kind: StepReportKind::Progressed,
            })
            .expect("the channel takes one report");
        let step_cancel = cancel.clone();
        let wait =
            tokio::spawn(
                async move { wait_at_gate(step(), admission, &step_cancel, &reports).await },
            );
        tokio::task::yield_now().await;
        cancel.cancel();
        let end = tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("the wait ends at once")
            .expect("the wait's task ends");
        assert!(matches!(
            end,
            GateWaitEnd::Canceled {
                hold_started_at: None
            }
        ));
    }

    /// A turn waits for every earlier turn, not only the one just before it, and not for the
    /// order `wait` is called in. Mutations: dropping b releases c (a chain of oneshots); turns
    /// served in the order `wait` is called.
    #[tokio::test(start_paused = true)]
    async fn a_turn_waits_for_every_earlier_turn() {
        let order = GateEntryOrder::default();
        let a = order.take_turn();
        let b = order.take_turn();
        let c = order.take_turn();
        drop(b);
        let short = Duration::from_millis(10);
        assert!(
            tokio::time::timeout(short, c.wait()).await.is_err(),
            "c entered while a was open"
        );
        tokio::time::timeout(short, a.wait())
            .await
            .expect("the first turn enters at once");
        drop(a);
        tokio::time::timeout(short, c.wait())
            .await
            .expect("c enters once every earlier turn is dropped");
    }
}
