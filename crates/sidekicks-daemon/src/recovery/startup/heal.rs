//! The heal of a session whose log the rebuild could not fold: the store's files go aside before
//! anything is repaired, unless they already went for this damage; then the rebuild runs again, and
//! a session it still cannot rebuild opens at its last good point, or reads damaged when none of it
//! can be read.

use std::error::Error;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::{PassFailure, PassTally, StartupRecovery, events_count};
use crate::recovery::database_file::aside_copy::{
    DatabaseFilesAside, copy_database_files_aside, find_aside_copy_of_session,
    record_session_in_aside_copy,
};
use crate::recovery::projection_rebuild::{
    ProjectionFailure, ProjectionRebuildError, ProjectionRebuildRequest,
};

/// The copy aside one pass took, so it copies the store's files once however many sessions it
/// heals.
#[derive(Default)]
pub(super) struct HealState {
    aside_folder: Option<PathBuf>,
}

impl StartupRecovery {
    // Heals the session `failure` names; answers whether its history is left damaged.
    pub(super) async fn heal(
        &self,
        failure: &ProjectionFailure,
        heal: &mut HealState,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<bool, PassFailure> {
        let session_id = failure.session_id;
        // A damaged session takes no write, so its head names the damage until it is continued.
        let head_sequence = self
            .deps
            .projection_rebuild
            .read_head_sequence(session_id)
            .await?;
        let earlier_copy =
            find_aside_copy_of_session(&self.deps.data_folder, &session_id, head_sequence)
                .await
                .map_err(PassFailure::AsideRead)?;
        // The copy this heal records the damage in; none when an earlier start already copied it.
        let this_pass_copy = if let Some(earlier_copy) = earlier_copy {
            tracing::info!(
                session_id = %session_id,
                folder = %earlier_copy.display(),
                "the store's files were already copied aside for this damage"
            );
            None
        } else {
            Some(self.copy_aside_once(heal, stop).await?)
        };
        let rebuilt = self
            .deps
            .projection_rebuild
            .rebuild(
                ProjectionRebuildRequest {
                    session_id,
                    is_forced: true,
                    before_sequence: None,
                    stop: Some(stop.clone()),
                },
                None,
            )
            .await;
        let failures = match rebuilt {
            Ok(rebuilt) => {
                tally.events_applied += events_count(rebuilt.events_applied);
                return Ok(false);
            }
            Err(ProjectionRebuildError::ProjectionFailure(failures)) => failures,
            Err(error) => return Err(error.into()),
        };
        let point = self
            .deps
            .damaged_history
            .rebuild_through_last_good_point(failures.original(), stop)
            .await?;
        if let Some(folder) = &this_pass_copy {
            record_session_in_aside_copy(folder, &session_id, head_sequence).await?;
        }
        if let Some(point) = point {
            tracing::warn!(
                session_id = %session_id,
                last_sequence = point.last_sequence.get(),
                damaged_from_sequence = point.damaged_from_sequence.get(),
                error = &failures as &(dyn Error + 'static),
                "a session opens at its last good point; its damaged events are kept in place"
            );
            self.deps
                .status
                .mark_session_at_last_good_point(&session_id, point);
        } else {
            tracing::warn!(
                session_id = %session_id,
                error = &failures as &(dyn Error + 'static),
                "no event of a session can be read"
            );
            self.deps.status.mark_session_unreadable(&session_id);
        }
        Ok(true)
    }

    // The folder of this pass's copy of the store's files, taken the first time a heal needs it.
    async fn copy_aside_once(
        &self,
        heal: &mut HealState,
        stop: &CancellationToken,
    ) -> Result<PathBuf, PassFailure> {
        if let Some(folder) = &heal.aside_folder {
            return Ok(folder.clone());
        }
        // A copy of a large store takes a while, so a stop that came first never starts one.
        if stop.is_cancelled() {
            return Err(PassFailure::Stopped);
        }
        let aside = DatabaseFilesAside {
            database_path: &self.deps.database_path,
            data_folder: &self.deps.data_folder,
            copier: &self.deps.copier,
            now: jiff::Timestamp::now(),
        };
        // No write reaches the files while they are copied, so the copy is of one state of them.
        let folder = self
            .deps
            .writer
            .hold_while(|| copy_database_files_aside(&aside, stop))
            .await?;
        tracing::info!(folder = %folder.display(), "the store's files were copied aside");
        heal.aside_folder = Some(folder.clone());
        Ok(folder)
    }
}
