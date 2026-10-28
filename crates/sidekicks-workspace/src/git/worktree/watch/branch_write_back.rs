//! The branch write-back: a branch changed in a working folder outside the app is written to the
//! record of every session standing there whose recorded branch differs.

use std::error::Error;
use std::path::Path;

use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::worktree::events::SessionBranchChangedPayload;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::{WatchTarget, WatcherShared};
use crate::git::worktree::reads::read_current_branch;

/// The branch a folder was last seen on, and the check that writes a new one back.
#[derive(Default)]
pub(super) struct BranchWriteBack {
    // Whether a check has written every standing session back.
    has_seen: bool,
    // The branch that check read, `None` while HEAD was detached.
    last_seen: Option<String>,
}

impl BranchWriteBack {
    /// Reads the folder `key`'s branch and, when it differs from the one last seen, appends
    /// `session.branch.changed` for each session standing there whose recorded branch differs.
    /// The branch counts as seen only once every append succeeded, so the next HEAD change tries a
    /// failed one again; every failure is logged, and the other sessions still get theirs.
    pub(super) async fn check(&mut self, shared: &WatcherShared, key: &Path, target: &WatchTarget) {
        let branch = match read_current_branch(&shared.deps.git, target.place.as_ref(), key).await {
            Ok(branch) => branch,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's branch could not be read, so a branch changed there is \
                         not written back yet"
                );
                return;
            }
        };
        if self.has_seen && self.last_seen == branch {
            return;
        }
        let branch_name = match branch.clone().map(GitRefName::new).transpose() {
            Ok(branch_name) => branch_name,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's branch has a name no record holds, so it is not written \
                     back"
                );
                return;
            }
        };
        let occupancy = match shared.deps.occupancy.read(&target.repo_mount_id).await {
            Ok(occupancy) => occupancy,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the sessions standing in a working folder could not be read, so a branch \
                     changed there is not written back yet"
                );
                return;
            }
        };
        let mut has_failed = false;
        for session in occupancy.standing_by_folder.get(key).into_iter().flatten() {
            if session.recorded_branch.as_ref().map(GitRefName::as_str) == branch.as_deref() {
                continue;
            }
            let payload = SessionBranchChangedPayload {
                session_id: session.session_id,
                repo_mount_id: target.repo_mount_id,
                worktree_id: session.worktree_id,
                branch: branch_name.clone(),
                previous_branch: session.recorded_branch.clone(),
            };
            if let Err(error) = shared
                .deps
                .events
                .emit_branch_changed(payload, SessionEventLinkage::default())
                .await
            {
                has_failed = true;
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a branch changed in a working folder could not be written to a session's \
                     record; the next change of its HEAD tries again"
                );
            }
        }
        if !has_failed {
            self.has_seen = true;
            self.last_seen = branch;
        }
    }
}
