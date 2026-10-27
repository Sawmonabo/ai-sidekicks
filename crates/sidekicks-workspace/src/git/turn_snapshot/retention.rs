//! What deleting one run's snapshot refs needs besides the service: the run context key and row it
//! reads, the snapshot ref listing parser, and the absence probe.

use std::fmt;
use std::path::{Path, PathBuf};

use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use uuid::Uuid;

use sidekicks_std::missing_entry::is_gone;

/// The key of one run's execution context row: an agent run's id or a workflow run's id. It
/// writes as the UUID's lowercase hyphenated text, so it is a safe ref path component.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunContextKey(Uuid);

impl fmt::Display for RunContextKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0.hyphenated(), formatter)
    }
}

impl From<RunId> for RunContextKey {
    fn from(run_id: RunId) -> Self {
        Self(run_id.into())
    }
}

impl From<WorkflowRunId> for RunContextKey {
    fn from(workflow_run_id: WorkflowRunId) -> Self {
        Self(workflow_run_id.into())
    }
}

/// One run's context row as the prune reads it by its `RunContextKey`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunContextRow {
    /// The repository's common git folder, recorded when the run's context was made, which outlives
    /// the run's execution root.
    pub(crate) git_common_dir: PathBuf,
    /// When the run ended; `None` while it has not, which keeps its refs.
    pub(crate) released_at: Option<WireInstant>,
}

/// One `<object id> <ref name>` line of a snapshot ref listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SnapshotRefListingEntry {
    /// The object the ref named when listed.
    pub(crate) object_id: GitObjectId,
    /// The ref's full name.
    pub(crate) snapshot_ref: String,
}

/// Keeps the well-formed `<object id> <ref name>` lines of `listing` whose name starts with
/// `expected_prefix`. This judges the name git reported; `--no-deref` at deletion governs what it
/// resolves to. A bad line is dropped, not refused, so it cannot strand the refs beside it.
pub(crate) fn parse_snapshot_ref_listing(
    listing: &[u8],
    expected_prefix: &str,
) -> Vec<SnapshotRefListingEntry> {
    String::from_utf8_lossy(listing)
        .split('\n')
        .filter_map(|line| {
            let (object_id, snapshot_ref) = line.split_once(' ')?;
            if !snapshot_ref.starts_with(expected_prefix) {
                return None;
            }
            Some(SnapshotRefListingEntry {
                object_id: GitObjectId::new(object_id.to_owned())?,
                snapshot_ref: snapshot_ref.to_owned(),
            })
        })
        .collect()
}

/// Whether `path` is provably absent: only a missing entry or a file where a folder was expected
/// counts, so any other failure answers `false`, and the prune reads the folder as unusable.
pub(crate) async fn is_path_provably_absent(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_err_and(|failure| is_gone(&failure))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::parse_snapshot_ref_listing;

    const PREFIX: &str = "refs/sidekicks/runs/0192f0c4-7a3b-7c2d-8e4f-5a6b7c8d9e0f/";
    const GOOD_OBJECT_ID: &str = "0123456789abcdef0123456789abcdef01234567";

    // The prune deletes what this parser keeps, so a bad line must neither be kept nor take the
    // good lines beside it down with it.
    #[rstest]
    #[case::good_line_kept(String::new())]
    #[case::bad_object_id(format!("not-an-object-id {PREFIX}epoch-0/turn-1\n"))]
    #[case::missing_space(format!("{GOOD_OBJECT_ID}\n"))]
    #[case::other_prefix(format!("{GOOD_OBJECT_ID} refs/heads/main\n"))]
    fn a_bad_line_is_dropped_without_stranding_its_neighbors(#[case] bad_line: String) {
        let good_ref = format!("{PREFIX}epoch-0/turn-0");
        let again_ref = format!("{PREFIX}epoch-0/turn-1");
        let listing =
            format!("{GOOD_OBJECT_ID} {good_ref}\n{bad_line}{GOOD_OBJECT_ID} {again_ref}\n");

        let entries = parse_snapshot_ref_listing(listing.as_bytes(), PREFIX);

        let kept = entries
            .iter()
            .map(|entry| (entry.object_id.as_str(), entry.snapshot_ref.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            kept,
            [
                (GOOD_OBJECT_ID, good_ref.as_str()),
                (GOOD_OBJECT_ID, again_ref.as_str()),
            ]
        );
    }
}
