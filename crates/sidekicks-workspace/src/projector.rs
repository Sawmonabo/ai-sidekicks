//! The health of a repository mount and of a workspace, projected from its row and what the
//! service observed. Nothing here touches the file system, git, a clock or a database: the service
//! probes and hands in the row with the probe. An unavailable execution root reads `rootLost` on
//! every read surface, found on read; persisting it and gating writes belong to the workspace
//! service.

use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{RepoMountHealth, WorkspaceState};
use sidekicks_contracts::wire::instant::WireInstant;

/// One file-system measurement of a path in one place, handed in by the service. Every projection
/// refuses a probe of any path or place but its row's own, so a mispaired probe cannot report a
/// wrong verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FilesystemPathProbe {
    /// The path measured.
    pub(crate) probed_path: PathBuf,
    /// The place it was measured in; `None` on macOS and Linux.
    pub(crate) probed_place: Option<Place>,
    /// Whether the path could be reached; a mount's identity is observed separately, from git.
    pub(crate) is_reachable: bool,
    /// When it was measured.
    pub(crate) checked_at: WireInstant,
}

/// The `repo_mounts` facts a mount's health reads. Its lifecycle state is left out on purpose:
/// health is the root's reachability and identity, so a `detached` mount whose root still holds its
/// repository is `healthy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RepoMountHealthRow<'row> {
    /// The mount's canonical root.
    pub(crate) canonical_root: &'row Path,
    /// The place the root is in; `None` on macOS and Linux.
    pub(crate) place: Option<&'row Place>,
    /// The git common directory recorded at attach; `None` on a mount that carries none.
    pub(crate) common_dir_anchor: Option<&'row Path>,
}

/// The repository git found at a reachable, anchored mount root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RepoMountIdentityObservation {
    /// The repository recorded at attach.
    Anchored,
    /// Another repository.
    Other,
    /// None: git does not answer the root as a repository's working tree.
    NotARepository,
}

/// The `workspaces` facts a workspace's health reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceHealthRow<'row> {
    /// The row's state.
    pub(crate) state: WorkspaceState,
    /// Its execution root, `None` until preparation completes, as the `fs_root` column holds it.
    pub(crate) fs_root: Option<&'row Path>,
    /// The place of its mount, where the root is; `None` on macOS and Linux.
    pub(crate) place: Option<&'row Place>,
}

/// One workspace's health: the state to report, and whether the service must persist it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceHealthProjection {
    /// The row's state, or `rootLost` when the probe found the root unavailable.
    pub(crate) observed_state: WorkspaceState,
    /// The probe's instant, `None` when no probe was owed; the wire carries only the state.
    pub(crate) checked_at: Option<WireInstant>,
    /// Whether the observed state differs from the row's, so the `rootLost` transition is owed.
    pub(crate) is_root_lost_transition_required: bool,
}

/// Why a health projection refused its inputs: a row and an observation that do not belong
/// together, which answering anyway would turn into a confident, wrong verdict. No message names a
/// path, since paths stay out of the errors callers see.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HealthProjectionError {
    /// The probe measured another path than the row's own, compared byte for byte, so a path that
    /// merely normalizes alike is refused too.
    #[error(
        "health projection refused a probe that did not measure the {subject}: the probed path \
         and the row's path differ"
    )]
    ProbeOfAnotherPath {
        /// What the probe should have measured.
        subject: &'static str,
    },
    /// The probe measured the row's path in another place: one path in two WSL distributions is
    /// two folders.
    #[error("health projection refused a probe that did not measure the {subject} in its place")]
    ProbeFromAnotherPlace {
        /// What the probe should have measured.
        subject: &'static str,
    },
    /// An identity observation came with a mount that owes none, or none came with a mount that
    /// owes one: one is owed exactly when the root is reachable and the mount carries an anchor.
    #[error(
        "a repo mount identity observation is owed exactly when the root is reachable and the \
         mount carries an anchor; answering from a mispaired observation would report a verdict \
         nothing measured"
    )]
    IdentityObservationMispaired,
    /// A probe came with a workspace whose state owes none: a root-less or terminal workspace is
    /// not re-derived from the file system, and a `rootLost` one is never healed.
    #[error(
        "a workspace in state {} owes no execution-root probe, but one was supplied",
        <&'static str>::from(*.state)
    )]
    ProbeNotOwed {
        /// The row's state.
        state: WorkspaceState,
    },
    /// A workspace whose state owes a probe carries no execution root: a corrupt row, since the
    /// preparation sets `fs_root` whenever it writes that state.
    #[error(
        "a workspace in state {} must carry a resolved execution root, and this row carries none",
        <&'static str>::from(*.state)
    )]
    ExecutionRootMissing {
        /// The row's state.
        state: WorkspaceState,
    },
    /// A workspace whose state owes a probe came without one; answering would report the row's
    /// own state as a checked verdict.
    #[error(
        "a workspace in state {} requires an execution-root probe",
        <&'static str>::from(*.state)
    )]
    ProbeMissing {
        /// The row's state.
        state: WorkspaceState,
    },
}

/// A mount's health: `unreachable` first, since nothing more can be asked of a root that cannot be
/// probed, then `identityMismatch` when the repository observed is not the anchored one. Refuses
/// a probe of another path or place, and an identity observation given when none is owed or
/// missing when one is.
pub(crate) fn compute_repo_mount_health(
    mount_row: &RepoMountHealthRow<'_>,
    probe: &FilesystemPathProbe,
    identity: Option<RepoMountIdentityObservation>,
) -> Result<RepoMountHealth, HealthProjectionError> {
    refuse_probe_of_another_root(
        probe,
        mount_row.canonical_root,
        mount_row.place,
        "repo mount's canonical root",
    )?;
    let is_identity_owed = probe.is_reachable && mount_row.common_dir_anchor.is_some();
    if is_identity_owed != identity.is_some() {
        return Err(HealthProjectionError::IdentityObservationMispaired);
    }
    let checked_at = probe.checked_at.clone();
    if !probe.is_reachable {
        return Ok(RepoMountHealth::Unreachable {
            checked_at,
            is_repository: None,
        });
    }
    Ok(match identity {
        None | Some(RepoMountIdentityObservation::Anchored) => RepoMountHealth::Healthy {
            checked_at,
            is_repository: None,
        },
        Some(RepoMountIdentityObservation::Other) => RepoMountHealth::IdentityMismatch {
            is_repository: true,
            checked_at,
        },
        Some(RepoMountIdentityObservation::NotARepository) => RepoMountHealth::IdentityMismatch {
            is_repository: false,
            checked_at,
        },
    })
}

/// Whether a workspace in `state` carries a live execution root and so owes a probe on read, so
/// the service can skip the work for the rest: `preparing` has a root in flux, `rootLost` is
/// already the fault verdict and never healed here, and `archived` is terminal history.
pub(crate) fn is_probe_bearing(state: WorkspaceState) -> bool {
    match state {
        WorkspaceState::Ready => true,
        WorkspaceState::Preparing | WorkspaceState::RootLost | WorkspaceState::Archived => false,
    }
}

/// A workspace's health from its row and the probe of its root, which a state that owes a probe
/// requires and every other state refuses. A reachable probe never heals a `rootLost` workspace:
/// such a row owes no probe.
pub(crate) fn compute_workspace_health(
    workspace_row: &WorkspaceHealthRow<'_>,
    probe: Option<&FilesystemPathProbe>,
) -> Result<WorkspaceHealthProjection, HealthProjectionError> {
    let state = workspace_row.state;
    if !is_probe_bearing(state) {
        if probe.is_some() {
            return Err(HealthProjectionError::ProbeNotOwed { state });
        }
        return Ok(WorkspaceHealthProjection {
            observed_state: state,
            checked_at: None,
            is_root_lost_transition_required: false,
        });
    }
    let fs_root = workspace_row
        .fs_root
        .ok_or(HealthProjectionError::ExecutionRootMissing { state })?;
    let probe = probe.ok_or(HealthProjectionError::ProbeMissing { state })?;
    refuse_probe_of_another_root(
        probe,
        fs_root,
        workspace_row.place,
        "workspace's execution root",
    )?;
    // The one transition derived here; a reachable root leaves the state as it is.
    let observed_state = if probe.is_reachable {
        state
    } else {
        WorkspaceState::RootLost
    };
    Ok(WorkspaceHealthProjection {
        observed_state,
        checked_at: Some(probe.checked_at.clone()),
        is_root_lost_transition_required: observed_state != state,
    })
}

// Compares the paths' bytes, since `Path`'s own equality folds components and would accept a
// probe of a path that merely normalizes alike.
fn refuse_probe_of_another_root(
    probe: &FilesystemPathProbe,
    expected_path: &Path,
    expected_place: Option<&Place>,
    subject: &'static str,
) -> Result<(), HealthProjectionError> {
    if probe.probed_path.as_os_str() != expected_path.as_os_str() {
        return Err(HealthProjectionError::ProbeOfAnotherPath { subject });
    }
    if probe.probed_place.as_ref() != expected_place {
        return Err(HealthProjectionError::ProbeFromAnotherPlace { subject });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_contracts::place::{Place, WslPlace};
    use sidekicks_contracts::repo::mount::{RepoMountHealth, WorkspaceState};
    use sidekicks_contracts::wire::instant::WireInstant;

    use super::{
        FilesystemPathProbe, HealthProjectionError, RepoMountHealthRow,
        RepoMountIdentityObservation, WorkspaceHealthRow, compute_repo_mount_health,
        compute_workspace_health,
    };

    const ROOT: &str = "/repos/app";

    fn checked_at() -> WireInstant {
        WireInstant::try_from("2026-10-14T09:30:00.000Z".to_owned())
            .expect("the instant is RFC 3339")
    }

    // `None` expects the projection refused.
    #[rstest]
    #[case::unreachable_root_owes_no_identity(
        false,
        true,
        None,
        Some(RepoMountHealth::Unreachable { checked_at: checked_at(), is_repository: None })
    )]
    #[case::unanchored_reachable_root_reads_healthy(
        true,
        false,
        None,
        Some(RepoMountHealth::Healthy { checked_at: checked_at(), is_repository: None })
    )]
    #[case::anchored_root_holding_its_repository_reads_healthy(
        true,
        true,
        Some(RepoMountIdentityObservation::Anchored),
        Some(RepoMountHealth::Healthy { checked_at: checked_at(), is_repository: None })
    )]
    #[case::owed_identity_missing_is_refused(true, true, None, None)]
    fn a_mount_reads_unreachable_first_then_its_identity(
        #[case] is_reachable: bool,
        #[case] is_anchored: bool,
        #[case] identity: Option<RepoMountIdentityObservation>,
        #[case] expected: Option<RepoMountHealth>,
    ) {
        let probe = FilesystemPathProbe {
            probed_path: PathBuf::from(ROOT),
            probed_place: None,
            is_reachable,
            checked_at: checked_at(),
        };
        let row = RepoMountHealthRow {
            canonical_root: Path::new(ROOT),
            place: None,
            common_dir_anchor: is_anchored.then_some(Path::new("/repos/app/.git")),
        };
        assert_eq!(
            compute_repo_mount_health(&row, &probe, identity).ok(),
            expected
        );
    }

    #[rstest]
    #[case::missing_root_reads_root_lost_and_asks_for_the_write(
        WorkspaceState::Ready,
        Some(false),
        Some((WorkspaceState::RootLost, true))
    )]
    #[case::reachable_root_keeps_ready(
        WorkspaceState::Ready,
        Some(true),
        Some((WorkspaceState::Ready, false))
    )]
    #[case::root_lost_stays_root_lost_unprobed(
        WorkspaceState::RootLost,
        None,
        Some((WorkspaceState::RootLost, false))
    )]
    #[case::reachable_probe_never_heals_root_lost(WorkspaceState::RootLost, Some(true), None)]
    fn a_workspace_reads_root_lost_when_its_root_is_gone_and_never_heals(
        #[case] state: WorkspaceState,
        #[case] probe_reachability: Option<bool>,
        #[case] expected: Option<(WorkspaceState, bool)>,
    ) {
        let probe = probe_reachability.map(|is_reachable| FilesystemPathProbe {
            probed_path: PathBuf::from(ROOT),
            probed_place: None,
            is_reachable,
            checked_at: checked_at(),
        });
        let row = WorkspaceHealthRow {
            state,
            fs_root: Some(Path::new(ROOT)),
            place: None,
        };
        let projection = compute_workspace_health(&row, probe.as_ref());
        assert_eq!(
            projection.ok().map(|projection| (
                projection.observed_state,
                projection.is_root_lost_transition_required
            )),
            expected
        );
    }

    #[test]
    fn a_probe_of_the_root_in_another_distribution_is_refused() {
        let distribution = |name: &str| {
            Place::Wsl(WslPlace {
                distro: serde_json::from_value(serde_json::json!(name)).expect("a name reads"),
            })
        };
        let ubuntu = distribution("Ubuntu");
        let probe = FilesystemPathProbe {
            probed_path: PathBuf::from(ROOT),
            probed_place: Some(distribution("Debian")),
            is_reachable: true,
            checked_at: checked_at(),
        };
        let row = RepoMountHealthRow {
            canonical_root: Path::new(ROOT),
            place: Some(&ubuntu),
            common_dir_anchor: None,
        };
        assert!(matches!(
            compute_repo_mount_health(&row, &probe, None),
            Err(HealthProjectionError::ProbeFromAnotherPlace { .. })
        ));
    }
}
