//! The undo's one order: its steps in order, one undo of a session at a time, a retry after a
//! recorded cut answered applied and its files finished, the hold let go after a failure at each step, a failure after
//! the stops reported, a pausing lead waited out within its bound, a grown set of stops answered
//! with nothing moved, and what each scope's cut and put-back report.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFailure, SessionRestoreFailures, SessionRestoreFileOutcome,
    SessionRestoreOutcome, SessionRestoreResend, SessionRestoreScope, SessionRestoreStops,
    SessionRestoreTarget, SessionRestoredScope, SnapshotId,
};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_session::checkpoints::restore_cuts::RecordedCut;
use sidekicks_session::checkpoints::store::Checkpoint;
use sidekicks_session::interventions::service::InterventionError;
use sidekicks_session::queue_store::CurrentLeadRun;
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_session_id;

use super::{
    FilesPutBack, UNDO_PAUSE_WAIT_BOUND, UndoError, UndoFiles, UndoPoint, UndoRequest, UndoScope,
    UndoSteps, restore_outcome, run_undo,
};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::service::undo::reach::UndoReach;
use crate::service::undo::{ConversationCut, ConversationCutError, ProviderCut};
use crate::undo::{UndoStopError, UndoStopSet};

/// The point's run position in the stand-in's reach.
const POINT_POSITION: u64 = 3;

/// The point the stand-in's undo goes back to.
const POINT: i64 = 7;

/// One step an undo took, as the stand-in recorded it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Hold,
    ReadRecordedCut,
    ReadPoint,
    ReadLead,
    WaitOutPause,
    MakeLive,
    ReadProviderCut,
    Stop,
    Settle,
    Interrupt,
    CaptureAfter,
    Stage,
    Cut,
    PutBack,
    RecordFiles,
    Release,
    Unstage,
}

/// Steps that record themselves in order, `failing` failing as its step fails, the lead read in
/// each of `lead_states` in turn, the last one standing, any pause or resume waited out over
/// `pause_wait`, the stops answering `grown` as more than the person agreed to, and the undo's
/// key holding what `recorded` says of a recorded cut.
struct RecordingSteps {
    taken: Mutex<Vec<Step>>,
    failing: Option<Step>,
    run_id: RunId,
    lead_states: Mutex<VecDeque<RunState>>,
    pause_wait: Duration,
    grown: Option<SessionRestoreStops>,
    recorded: Option<RecordedCut>,
    is_live: Mutex<bool>,
    released_resends: Mutex<Vec<Option<SessionRestoreResend>>>,
}

impl RecordingSteps {
    fn new(lead_states: &[RunState]) -> Self {
        Self {
            taken: Mutex::new(Vec::new()),
            failing: None,
            run_id: new_run_id(),
            lead_states: Mutex::new(lead_states.iter().copied().collect()),
            pause_wait: Duration::ZERO,
            grown: None,
            recorded: None,
            is_live: Mutex::new(false),
            released_resends: Mutex::new(Vec::new()),
        }
    }

    fn failing(mut self, step: Step) -> Self {
        self.failing = Some(step);
        self
    }

    fn take(&self, step: Step) -> bool {
        lock(&self.taken).push(step);
        self.failing == Some(step)
    }

    fn taken(&self) -> Vec<Step> {
        lock(&self.taken).clone()
    }
}

impl UndoSteps for RecordingSteps {
    type Hold = ();

    fn hold(&self, _session_id: SessionId, _undo_key: ClientUuid) -> BoxFuture<'_, ()> {
        self.take(Step::Hold);
        async {}.boxed()
    }

    fn read_recorded_cut(
        &self,
        _session_id: SessionId,
        _undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<Option<RecordedCut>, QueueError>> {
        self.take(Step::ReadRecordedCut);
        let answer = self.recorded.clone();
        async move { Ok(answer) }.boxed()
    }

    fn read_point(
        &self,
        _session_id: SessionId,
        _target: SessionRestoreTarget,
        _scope: SessionRestoreScope,
        edited: Option<SessionRestoreResend>,
    ) -> BoxFuture<'_, Result<UndoPoint, ConversationCutError>> {
        let answer = if self.take(Step::ReadPoint) {
            Err(ConversationCutError::NoCheckpoint { source: None })
        } else {
            Ok(UndoPoint {
                checkpoint: reach_at_point(self.run_id).checkpoint,
                resend: edited,
            })
        };
        async move { answer }.boxed()
    }

    fn read_lead(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<CurrentLeadRun>, QueueError>> {
        let answer = if self.take(Step::ReadLead) {
            Err(QueueError::DrainEnded)
        } else {
            let mut states = lock(&self.lead_states);
            let state = if states.len() > 1 {
                states.pop_front()
            } else {
                states.front().copied()
            };
            Ok(state.map(|state| CurrentLeadRun {
                run_id: self.run_id,
                state,
            }))
        };
        async move { answer }.boxed()
    }

    fn wait_out_pause(&self, _run_id: RunId) -> BoxFuture<'_, ()> {
        let wait = self.pause_wait;
        async move {
            tokio::time::sleep(wait).await;
            self.take(Step::WaitOutPause);
        }
        .boxed()
    }

    fn is_live(&self, _session_id: SessionId) -> bool {
        *lock(&self.is_live)
    }

    fn read_stops(
        &self,
        _session_id: SessionId,
        _after_sequence: i64,
    ) -> BoxFuture<'_, Result<UndoStopSet, UndoStopError>> {
        async { Ok(UndoStopSet::default()) }.boxed()
    }

    fn make_live(
        &self,
        session_id: SessionId,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        let answer = if self.take(Step::MakeLive) {
            Err(ProviderSessionError::NotOpen { session_id })
        } else {
            *lock(&self.is_live) = true;
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn read_provider_cut(
        &self,
        _session_id: SessionId,
        _target: SessionRestoreTarget,
    ) -> BoxFuture<'_, Result<ProviderCut, ConversationCutError>> {
        let answer = if self.take(Step::ReadProviderCut) {
            Err(ConversationCutError::NoLiveBinding)
        } else {
            Ok(ProviderCut::ToMake)
        };
        async move { answer }.boxed()
    }

    fn stop(
        &self,
        _session_id: SessionId,
        after_sequence: i64,
        _consented: Option<SessionRestoreStops>,
    ) -> BoxFuture<'_, Result<(), UndoStopError>> {
        assert_eq!(after_sequence, POINT, "the stops start at the point");
        let answer = if self.take(Step::Stop) {
            Err(UndoStopError::PointNotFound { sequence: POINT })
        } else if let Some(grown) = &self.grown {
            Err(UndoStopError::Grew {
                stops: grown.clone(),
            })
        } else {
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn settle_held_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        assert_eq!(after_sequence, POINT, "the settle starts at the point");
        let answer = if self.take(Step::Settle) {
            Err(ProviderSessionError::NotOpen { session_id })
        } else {
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn interrupt(
        &self,
        run_id: RunId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), InterventionError>> {
        let answer = if self.take(Step::Interrupt) {
            Err(InterventionError::Unsaved {
                run_id,
                key: undo_key.as_str().to_owned(),
            })
        } else {
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn stage_resend(
        &self,
        _session_id: SessionId,
        _undo_key: ClientUuid,
        _resend: SessionRestoreResend,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        let answer = if self.take(Step::Stage) {
            Err(QueueError::DrainEnded)
        } else {
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn cut<'a>(
        &'a self,
        _hold: &'a (),
        _target: SessionRestoreTarget,
        _companions: RollbackCompanions,
        _provider_cut: ProviderCut,
    ) -> BoxFuture<'a, Result<ConversationCut, ConversationCutError>> {
        let answer = if self.take(Step::Cut) {
            Err(ConversationCutError::Superseded)
        } else {
            Ok(ConversationCut::Applied {
                rollbacks: Vec::new(),
                reach: reach_at_point(self.run_id),
            })
        };
        async move { answer }.boxed()
    }

    fn record_files(
        &self,
        _session_id: SessionId,
        _undo_key: ClientUuid,
        files: SessionRestoreFileOutcome,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        self.take(Step::RecordFiles);
        assert_eq!(files, file_outcome());
        async { Ok(()) }.boxed()
    }

    fn release(
        &self,
        _hold: (),
        resend: Option<SessionRestoreResend>,
        _device_id: DeviceId,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        self.take(Step::Release);
        lock(&self.released_resends).push(resend);
        async { Ok(()) }.boxed()
    }

    fn unstage_resend(
        &self,
        _session_id: SessionId,
        _undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        self.take(Step::Unstage);
        async { Ok(()) }.boxed()
    }
}

/// A files leg that records its steps on `steps`, its capture failing when `steps` fails it.
struct RecordingFiles<'steps> {
    steps: &'steps RecordingSteps,
}

impl UndoFiles for RecordingFiles<'_> {
    fn capture_after<'a>(
        &'a self,
        checkpoint: &'a Checkpoint,
    ) -> BoxFuture<'a, Result<(), SessionRestoreFailure>> {
        assert_eq!(checkpoint.message_sequence.get(), POINT.unsigned_abs());
        let answer = if self.steps.take(Step::CaptureAfter) {
            Err(failure("the capture failed"))
        } else {
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn put_back<'a>(&'a self, checkpoint: &'a Checkpoint) -> BoxFuture<'a, FilesPutBack> {
        assert_eq!(checkpoint.message_sequence.get(), POINT.unsigned_abs());
        self.steps.take(Step::PutBack);
        async { FilesPutBack::Restored(file_outcome()) }.boxed()
    }
}

/// The reach the stand-in's point reads: the checkpoint before a message of `run_id` at [`POINT`].
fn reach_at_point(run_id: RunId) -> UndoReach {
    let message_id = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
    UndoReach {
        checkpoint: Checkpoint {
            checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
            session_id: test_session_id(),
            message_sequence: SafeInt::new(POINT.unsigned_abs()).expect("a small sequence"),
            run_id,
            turn_number: SafeInt::new(1).expect("a turn number"),
            turn: EpochPosition {
                epoch: SourceEpoch(SafeInt::ZERO),
                position: SourcePosition(SafeInt::new(POINT_POSITION).expect("a position")),
            },
        },
        message_id,
        pressed_message_id: message_id,
        opening: None,
        cut_messages: Vec::new(),
    }
}

fn failure(reason: &str) -> SessionRestoreFailure {
    SessionRestoreFailure {
        reason: NonEmptyText::new(reason.to_owned()).expect("a reason has words"),
    }
}

fn file_outcome() -> SessionRestoreFileOutcome {
    SessionRestoreFileOutcome {
        restored_file_count: SafeInt::new(2).expect("a small count"),
        restored_line_count: SafeInt::new(9).expect("a small count"),
        skipped: Vec::new(),
    }
}

fn edited() -> SessionRestoreResend {
    SessionRestoreResend {
        content: FreeFormText::new("Try the other client".to_owned()).expect("words"),
        attachments: None,
        skills: None,
        output_speed_for_turn: None,
    }
}

/// An undo of the conversation and the files with an edited resend, its files leg recorded on
/// `steps`.
fn request<'files>(files: &'files RecordingFiles<'files>) -> UndoRequest<'files> {
    UndoRequest {
        session_id: test_session_id(),
        target: SessionRestoreTarget::Snapshot {
            snapshot_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
        },
        scope: UndoScope::ConversationAndFiles(files),
        undo_key: ClientUuid::new(mint_uuid_v7().to_string()).expect("a client key"),
        device_id: DeviceId::new("device-1".to_owned()).expect("a test device id"),
        consented_stops: None,
        companions: RollbackCompanions::default(),
        resend: Some(edited()),
    }
}

/// The steps a whole undo of a running lead takes, in the one order.
const WHOLE_UNDO: [Step; 18] = [
    Step::Hold,
    Step::ReadRecordedCut,
    Step::ReadPoint,
    Step::ReadLead,
    Step::WaitOutPause,
    Step::ReadLead,
    Step::MakeLive,
    Step::ReadProviderCut,
    Step::Stop,
    Step::Settle,
    Step::Interrupt,
    Step::CaptureAfter,
    Step::Stage,
    Step::Cut,
    Step::PutBack,
    Step::RecordFiles,
    Step::Release,
    Step::Unstage,
];

// An undo of a running lead in a session with no live process takes every step once, in the one
// order: the hold, the recorded cut looked for, the point, the lead's pause or resume waited out
// and the lead read again, the process opened, the provider asked whether it already cut, the
// stops, the held calls' settle, the lead's interrupt, the after-captures, the resend kept, the
// cut, the put-back and its record, the release and the kept resend dropped. Killed by any two steps swapped and by any step skipped.
#[tokio::test]
async fn an_undo_takes_its_steps_in_the_one_order() {
    let steps = RecordingSteps::new(&[RunState::Running]);
    let files = RecordingFiles { steps: &steps };

    run_undo(&steps, &KeyedLock::new(), request(&files))
        .await
        .expect("every step succeeds");

    assert_eq!(steps.taken(), WHOLE_UNDO);
}

// Two undos of one session run one after the other: the second takes its hold, its point and its
// key only once the first has let its hold go, though the first waits out a pause on the way; the
// second finds the process the first opened. Killed by the session's undos left to run at once,
// where the second's steps fall among the first's.
#[tokio::test(start_paused = true)]
async fn two_undos_of_one_session_run_one_after_the_other() {
    let mut steps = RecordingSteps::new(&[RunState::Running]);
    steps.pause_wait = Duration::from_secs(5);
    let files = RecordingFiles { steps: &steps };
    let undos = KeyedLock::new();

    let first_request = request(&files);
    let second_request = UndoRequest {
        session_id: first_request.session_id,
        ..request(&files)
    };

    let (first, second) = tokio::join!(
        run_undo(&steps, &undos, first_request),
        run_undo(&steps, &undos, second_request),
    );

    first.expect("the first undo applies");
    second.expect("the second undo applies");
    let second_undo = WHOLE_UNDO.iter().filter(|step| **step != Step::MakeLive);
    let expected: Vec<Step> = WHOLE_UNDO.iter().chain(second_undo).copied().collect();
    assert_eq!(steps.taken(), expected);
}

// A retry under the key of an undo whose cut applied, the outcome lost with the process, cuts
// nothing again: with its files recorded put back it answers both applied and moves nothing; with
// them not recorded it finishes them to the checkpoint the key kept, its stops and captures first,
// and records them. Killed by the recorded cut not looked for, where the retry reads its own cut's
// point as superseded or cuts a second time, by the files answered failed or left unfinished, and
// by files recorded put back run again.
#[rstest]
#[case::files_recorded(true)]
#[case::files_not_recorded(false)]
#[tokio::test]
async fn a_retry_after_its_recorded_cut_answers_applied_and_cuts_nothing(
    #[case] is_files_recorded: bool,
) {
    let mut steps = RecordingSteps::new(&[RunState::Running]);
    steps.recorded = Some(RecordedCut {
        checkpoint: reach_at_point(steps.run_id).checkpoint,
        files: is_files_recorded.then(file_outcome),
    });
    let files = RecordingFiles { steps: &steps };

    let undone = run_undo(&steps, &KeyedLock::new(), request(&files)).await;

    assert_eq!(
        undone.expect("a recorded cut answers"),
        SessionRestoreOutcome::RestoreFinished {
            requested: SessionRestoreScope::ConversationAndFiles,
            restored: SessionRestoredScope::ConversationAndFiles,
            files: Some(file_outcome()),
            failures: None,
        }
    );
    let finished: &[Step] = if is_files_recorded {
        &[]
    } else {
        &[
            Step::ReadLead,
            Step::WaitOutPause,
            Step::ReadLead,
            Step::MakeLive,
            Step::Stop,
            Step::Settle,
            Step::Interrupt,
            Step::CaptureAfter,
            Step::PutBack,
            Step::RecordFiles,
        ]
    };
    assert_eq!(
        steps.taken(),
        [
            &[Step::Hold, Step::ReadRecordedCut][..],
            finished,
            &[Step::Release, Step::Unstage][..]
        ]
        .concat()
    );
    assert_eq!(*lock(&steps.released_resends), [None]);
}

// A step that fails ends the undo with nothing after it but the release, which lets the hold go
// and sends no resend; before anything is stopped the undo is refused, and once the stops ran it
// reports nothing restored with the step's cause for each part. Killed by a release made only on
// success, by a resend sent after a failure, by any step taken after the one that failed, and by
// a failure after the stops refused with no outcome.
#[rstest]
#[case::point(Step::ReadPoint, true)]
#[case::lead(Step::ReadLead, true)]
#[case::process(Step::MakeLive, true)]
#[case::provider_read(Step::ReadProviderCut, true)]
#[case::stops(Step::Stop, true)]
#[case::held_calls(Step::Settle, false)]
#[case::interrupt(Step::Interrupt, false)]
#[case::kept_resend(Step::Stage, false)]
#[case::superseded_cut(Step::Cut, false)]
#[tokio::test]
async fn a_failed_step_lets_the_hold_go_and_ends_the_undo(
    #[case] failing: Step,
    #[case] is_refused: bool,
) {
    let steps = RecordingSteps::new(&[RunState::Running]).failing(failing);
    let files = RecordingFiles { steps: &steps };

    let undone = run_undo(&steps, &KeyedLock::new(), request(&files)).await;

    if is_refused {
        assert!(undone.is_err(), "{undone:?}");
    } else {
        let Ok(SessionRestoreOutcome::RestoreFinished {
            restored, failures, ..
        }) = &undone
        else {
            panic!("a failure after the stops reports: {undone:?}");
        };
        assert_eq!(*restored, SessionRestoredScope::Nothing);
        assert!(
            failures
                .as_ref()
                .is_some_and(|failures| failures.conversation.is_some()
                    && failures.files.is_some())
        );
    }
    let taken = steps.taken();
    let failed_at = taken
        .iter()
        .position(|step| *step == failing)
        .expect("the failing step was taken");
    assert_eq!(taken[failed_at + 1..], [Step::Release, Step::Unstage]);
    assert_eq!(*lock(&steps.released_resends), [None]);
}

// A pausing lead is waited out before anything is stopped, and the paused lead it settles into
// rests uninterrupted; a wait past the bound fails the undo, the hold let go. Killed by the wait
// skipped, by the bound dropped, and by a paused lead interrupted.
#[rstest]
#[case::within_the_bound(Duration::from_secs(30), true)]
#[case::past_the_bound(UNDO_PAUSE_WAIT_BOUND + Duration::from_secs(1), false)]
#[tokio::test(start_paused = true)]
async fn a_pausing_lead_is_waited_out_within_the_bound(
    #[case] pause_wait: Duration,
    #[case] is_settled: bool,
) {
    let mut steps = RecordingSteps::new(&[RunState::Pausing, RunState::Paused]);
    steps.pause_wait = pause_wait;
    let files = RecordingFiles { steps: &steps };

    let undone = run_undo(&steps, &KeyedLock::new(), request(&files)).await;

    let taken = steps.taken();
    if is_settled {
        assert!(undone.is_ok(), "{undone:?}");
        assert_eq!(taken[..7], WHOLE_UNDO[..7]);
        assert!(!taken.contains(&Step::Interrupt), "{taken:?}");
    } else {
        assert!(
            matches!(undone, Err(UndoError::PauseNotSettled { run_id }) if run_id == steps.run_id),
            "{undone:?}"
        );
        assert_eq!(
            taken,
            [
                Step::Hold,
                Step::ReadRecordedCut,
                Step::ReadPoint,
                Step::ReadLead,
                Step::Release,
                Step::Unstage,
            ]
        );
    }
}

// More running after the point than the person agreed to stop answers what would stop now, with
// nothing stopped, interrupted or cut and the hold let go. Killed by the grown set read as a
// failure and by the undo carrying on past it.
#[tokio::test]
async fn a_grown_set_of_stops_answers_it_and_moves_nothing() {
    let grown = SessionRestoreStops {
        command_ids: vec![CommandId::new("command-2".to_owned()).expect("a command id")],
        ..SessionRestoreStops::default()
    };
    let mut steps = RecordingSteps::new(&[RunState::Running]);
    steps.grown = Some(grown.clone());
    let files = RecordingFiles { steps: &steps };

    let undone = run_undo(&steps, &KeyedLock::new(), request(&files)).await;

    assert_eq!(
        undone.expect("a grown set is an answer"),
        SessionRestoreOutcome::StopsChanged { stops: grown }
    );
    assert_eq!(
        steps.taken(),
        [&WHOLE_UNDO[..9], &[Step::Release, Step::Unstage][..]].concat()
    );
}

// A set of stops grows past the person's consent by any id the consent does not name, the same
// count of other ids included, an unnamed command's wrapper among them; a set within it, smaller
// or equal, does not. Killed by comparing the counts rather than the ids, and by the wrappers
// left out of the comparison.
#[test]
fn a_set_of_stops_grows_by_an_id_the_consent_does_not_name() {
    let command = |name: &str| CommandId::new(name.to_owned()).expect("a command id");
    let consented = SessionRestoreStops {
        command_ids: vec![command("command-1"), command("command-2")],
        unnamed_command_wrappers: vec![41],
        ..SessionRestoreStops::default()
    };
    let set_of = |names: &[&str]| UndoStopSet {
        commands: names.iter().map(|name| command(name)).collect(),
        unpaired_wrappers: Vec::new(),
        agents: Vec::new(),
    };

    assert!(set_of(&["command-1", "command-3"]).has_grown_past(&consented));
    assert!(!set_of(&["command-2"]).has_grown_past(&consented));
    assert!(!set_of(&["command-1", "command-2"]).has_grown_past(&consented));
    let with_wrapper = |party| UndoStopSet {
        unpaired_wrappers: vec![party],
        ..set_of(&["command-1"])
    };
    assert!(with_wrapper(42).has_grown_past(&consented));
    assert!(!with_wrapper(41).has_grown_past(&consented));
}

/// How an undo's conversation cut went, for the outcome table.
#[derive(Clone, Copy, Debug)]
enum CutWent {
    Applied,
    Refused,
    OutOfScope,
}

/// How an undo's files put-back went, for the outcome table.
#[derive(Clone, Copy, Debug)]
enum PutBackWent {
    Restored,
    Partial,
    Failed,
    OutOfScope,
}

// Each scope reports what went back, the files' figures exactly when they went back, and the
// daemon's reason for each part that failed. Killed by any arm of the report swapped.
#[rstest]
#[case::conversation_cut(
    SessionRestoreScope::Conversation,
    CutWent::Applied,
    PutBackWent::OutOfScope,
    SessionRestoredScope::Conversation,
    false,
    false
)]
#[case::conversation_refused(
    SessionRestoreScope::Conversation,
    CutWent::Refused,
    PutBackWent::OutOfScope,
    SessionRestoredScope::Nothing,
    true,
    false
)]
#[case::files_restored(
    SessionRestoreScope::Files,
    CutWent::OutOfScope,
    PutBackWent::Restored,
    SessionRestoredScope::Files,
    false,
    false
)]
#[case::files_partial(
    SessionRestoreScope::Files,
    CutWent::OutOfScope,
    PutBackWent::Partial,
    SessionRestoredScope::Files,
    false,
    true
)]
#[case::files_failed(
    SessionRestoreScope::Files,
    CutWent::OutOfScope,
    PutBackWent::Failed,
    SessionRestoredScope::Nothing,
    false,
    true
)]
#[case::both_restored(
    SessionRestoreScope::ConversationAndFiles,
    CutWent::Applied,
    PutBackWent::Restored,
    SessionRestoredScope::ConversationAndFiles,
    false,
    false
)]
#[case::both_files_partial(
    SessionRestoreScope::ConversationAndFiles,
    CutWent::Applied,
    PutBackWent::Partial,
    SessionRestoredScope::ConversationAndFiles,
    false,
    true
)]
#[case::both_no_file_back(
    SessionRestoreScope::ConversationAndFiles,
    CutWent::Applied,
    PutBackWent::Failed,
    SessionRestoredScope::Conversation,
    false,
    true
)]
#[case::both_cut_refused(
    SessionRestoreScope::ConversationAndFiles,
    CutWent::Refused,
    PutBackWent::Restored,
    SessionRestoredScope::Files,
    true,
    false
)]
#[case::both_failed(
    SessionRestoreScope::ConversationAndFiles,
    CutWent::Refused,
    PutBackWent::Failed,
    SessionRestoredScope::Nothing,
    true,
    true
)]
fn an_undo_reports_each_part_as_it_went(
    #[case] requested: SessionRestoreScope,
    #[case] cut: CutWent,
    #[case] put_back: PutBackWent,
    #[case] restored: SessionRestoredScope,
    #[case] is_conversation_failed: bool,
    #[case] is_files_failed: bool,
) {
    let conversation = match cut {
        CutWent::Applied => Some(Ok(())),
        CutWent::Refused => Some(Err(failure("the cut was refused"))),
        CutWent::OutOfScope => None,
    };
    let files = match put_back {
        PutBackWent::Restored => Some(FilesPutBack::Restored(file_outcome())),
        PutBackWent::Partial => Some(FilesPutBack::Partial {
            outcome: file_outcome(),
            failure: failure("one file failed"),
        }),
        PutBackWent::Failed => Some(FilesPutBack::Failed(failure("no file went back"))),
        PutBackWent::OutOfScope => None,
    };

    let reported = restore_outcome(requested, conversation, files);

    let failures = (is_conversation_failed || is_files_failed).then(|| SessionRestoreFailures {
        conversation: is_conversation_failed.then(|| failure("the cut was refused")),
        files: is_files_failed.then(|| match put_back {
            PutBackWent::Partial => failure("one file failed"),
            PutBackWent::Restored | PutBackWent::Failed | PutBackWent::OutOfScope => {
                failure("no file went back")
            }
        }),
    });
    assert_eq!(
        reported,
        SessionRestoreOutcome::RestoreFinished {
            requested,
            restored,
            files: restored.has_files().then(file_outcome),
            failures,
        }
    );
}
