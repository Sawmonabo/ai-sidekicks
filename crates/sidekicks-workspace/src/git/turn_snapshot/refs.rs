//! Snapshot ref names: the ref root, the points a run's snapshots are taken at (an agent run's
//! `turn-<N>`, a workflow run's `start`, `pause-<N>` and `end`), the one builder that spells each
//! point's ref, and the replace-ref pin for the git calls that read an object id back.

use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use crate::git::turn_snapshot::retention::RunContextKey;

/// Every snapshot ref sits under this prefix, trailing slash included. Not `refs/heads/`, so
/// snapshots stay out of branch history, pull request preparation and diffs.
pub(crate) const SNAPSHOT_REFS_PREFIX: &str = "refs/sidekicks/runs/";

/// Stops `refs/replace/<oid>` swapping another object for a frozen id, on the git calls that read
/// an object id back. With a replace ref on the base, an unpinned seed silently loses a path that
/// is both tracked in the index and ignored; the calls that resolve refs are unaffected.
pub(crate) const USE_REPLACE_REFS_PIN: [&str; 2] = ["-c", "core.useReplaceRefs=false"];

/// The point one of a run's snapshots is taken at, with the run it belongs to, so an agent run's
/// id never names a workflow run's point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunSnapshotPoint {
    /// The end of one of an agent run's turns.
    Turn {
        /// The run whose turn ended.
        run_id: RunId,
        /// 0 before any rollback, advanced by each accepted rollback.
        epoch: u64,
        /// The run position the turn's opening message took within the epoch, which counts the
        /// person's messages the run took (a turn's opening or a steer), so no two turns share it.
        ordinal: u64,
    },
    /// A workflow run's start, one of its approval pauses, or its end.
    WorkflowRun {
        /// The workflow run.
        workflow_run_id: WorkflowRunId,
        /// The point, with the execution it belongs to.
        point: WorkflowRunSnapshotPoint,
    },
}

impl RunSnapshotPoint {
    /// The key of the run whose snapshot is taken at this point.
    pub fn run_key(&self) -> RunContextKey {
        match *self {
            Self::Turn { run_id, .. } => RunContextKey::from(run_id),
            Self::WorkflowRun {
                workflow_run_id, ..
            } => RunContextKey::from(workflow_run_id),
        }
    }
}

/// The prefix under which every snapshot ref of one run sits, with its trailing slash, so a listing
/// of `run-A/` never reaches `run-AB`. A run's id is a UUID, so it is a safe ref path component.
pub(crate) fn build_run_snapshot_ref_prefix(run_key: RunContextKey) -> String {
    format!("{SNAPSHOT_REFS_PREFIX}{run_key}/")
}

/// The ref the snapshot at `point` is written to: `epoch-<E>/` under its run's prefix, then
/// `turn-<N>`, `start`, `pause-<N>` or `end`. The epoch segment keeps a re-execution after a
/// rollback, which reuses the point names, off the superseded epoch's refs; a UUID and integers
/// spell no name git refuses.
pub(crate) fn build_snapshot_ref(point: &RunSnapshotPoint) -> String {
    let (epoch, point_name) = match *point {
        RunSnapshotPoint::Turn { epoch, ordinal, .. } => (epoch, format!("turn-{ordinal}")),
        RunSnapshotPoint::WorkflowRun { point, .. } => match point {
            WorkflowRunSnapshotPoint::Start { epoch } => (epoch.0.get(), "start".to_owned()),
            WorkflowRunSnapshotPoint::Pause {
                epoch,
                pause_number,
            } => (epoch.0.get(), format!("pause-{}", pause_number.0.get())),
            WorkflowRunSnapshotPoint::End { epoch } => (epoch.0.get(), "end".to_owned()),
        },
    };
    format!(
        "{}epoch-{epoch}/{point_name}",
        build_run_snapshot_ref_prefix(point.run_key())
    )
}
