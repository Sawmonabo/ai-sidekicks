//! Turn-snapshot ref names: the ref root, the builders, and the replace-ref pin for the git calls
//! that read an object id back.

use sidekicks_contracts::run::id::RunId;

use crate::git::turn_snapshot::retention::RunContextKey;

// Not `refs/heads/`, so snapshots stay out of branch history, pull request preparation and diffs.
const SNAPSHOT_REF_ROOT: &str = "refs/sidekicks/runs";

/// Stops `refs/replace/<oid>` swapping another object for a frozen id, on the git calls that read
/// an object id back. With a replace ref on the base, an unpinned seed silently loses a path that
/// is both tracked in the index and ignored; the calls that resolve refs are unaffected.
pub(crate) const USE_REPLACE_REFS_PIN: [&str; 2] = ["-c", "core.useReplaceRefs=false"];

/// The prefix under which every snapshot ref of one run sits, with its trailing slash, so a listing
/// of `run-A/` never reaches `run-AB`. A run's id is a UUID, so it is a safe ref path component.
pub(crate) fn build_run_snapshot_ref_prefix(run_key: RunContextKey) -> String {
    format!("{SNAPSHOT_REF_ROOT}/{run_key}/")
}

/// The ref one turn's snapshot is written to. The epoch segment keeps a re-execution after a
/// rollback, which reuses turn ordinals, off the superseded epoch's ref.
pub(crate) fn build_turn_snapshot_ref(run_id: &RunId, epoch: u64, turn_ordinal: u64) -> String {
    format!(
        "{}epoch-{epoch}/turn-{turn_ordinal}",
        build_run_snapshot_ref_prefix(RunContextKey::from(*run_id))
    )
}
