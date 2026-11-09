//! A command window's close: the after-capture, the reading of what changed, each before-image
//! kept as a copy, the session's shadows brought up to date, and the one write that records the
//! versions and closes the window, then the pack and the reclaim of shadows nothing uses.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::file_facts;
use sidekicks_provider::port::command_capture::CommandWindowEnd;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_workspace::git::turn_snapshot::capture::CheckoutCaptureInput;
use sidekicks_workspace::git::turn_snapshot::command_capture::CommandCaptureAfter;
use sidekicks_workspace::git::turn_snapshot::command_capture::before_images::BeforeImage;
use sidekicks_workspace::git::turn_snapshot::repack::CapturedCommit;

use super::versions::{
    PlannedContent, WindowChanges, WindowReading, checkout_path, read_window_changes,
};
use super::{
    BeforeCapture, OpenWindow, WindowFailure, WindowRecorder, push_taken_shadow,
    uncovered_close_statements,
};
use crate::checkpoints::copies::{CopyStore, FileCopyError};
use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionLeg, CopyMode, NotKeptReason,
};
use crate::checkpoints::shadows::{ShadowComparison, ShadowTaken, compare_shadow};
use crate::checkpoints::store::shadows::{
    Shadow, delete_unused_shadow_statement, retire_current_shadow_statement,
    unlink_window_shadows_statement, unused_shadows, window_shadows,
};
use crate::checkpoints::store::{
    CheckpointVersion, CommandWindowClosing, CommandWindowId, close_command_window_statement,
    insert_version_statement, recorded_paths,
};

/// What a before-image's copy kept.
enum KeptImage {
    /// The copy, by its content's hash.
    Copied(Sha256Hex),
    /// No copy, for this reason.
    NotKept(NotKeptReason),
}

impl WindowRecorder {
    // Closes `window_id` as `end` says: unrun with no after-capture, covered; with no before- or
    // after-capture, uncovered; otherwise with its versions. A close whose write fails stays open
    // in its row, which the next start settles uncovered.
    pub(super) async fn close(self: Arc<Self>, window_id: CommandWindowId, end: CommandWindowEnd) {
        let Some(window) = lock(&self.open_windows).remove(&window_id) else {
            tracing::warn!(
                window_id = window_id.text().as_str(),
                "a command window closed that this daemon run never opened"
            );
            return;
        };
        let session_id = window.session_id;
        let before = match (end, &window.before) {
            // The command never ran, so there is nothing to lose.
            (CommandWindowEnd::Unrun, _) => {
                return self
                    .close_without_capture(window_id, session_id, true)
                    .await;
            }
            (_, None) => {
                return self
                    .close_without_capture(window_id, session_id, false)
                    .await;
            }
            (CommandWindowEnd::Exited { .. } | CommandWindowEnd::Untold, Some(before)) => before,
        };
        let input = CheckoutCaptureInput {
            owner_folder: session_storage_folder(&self.data_folder, &session_id),
            execution_root: window.checkout.execution_root.clone(),
            checkout_root: window.checkout.checkout_root.clone(),
            captured_at: Timestamp::now(),
        };
        let place = window.checkout.place.as_ref();
        // The service logs a failed capture with its step.
        let Ok(after) = self
            .captures
            .capture_after(place, &input, &before.tree)
            .await
        else {
            return self
                .close_without_capture(window_id, session_id, false)
                .await;
        };
        let recorded = self
            .record_close(window_id, &window, before, &after, input.captured_at)
            .await;
        // The capture's objects sit in its folder whether or not its rows were written.
        self.packing.pack(place, &after.capture.objects).await;
        match recorded {
            Ok(()) => {
                self.reclaim_unused_shadows(session_id).await;
            }
            Err(failure) => log_unwritten_close(window_id, &failure),
        }
    }

    // Closes `window_id` with no after-capture and unlinks its shadows, then reclaims the shadows
    // nothing uses any more.
    async fn close_without_capture(
        &self,
        window_id: CommandWindowId,
        session_id: SessionId,
        is_covered: bool,
    ) {
        let statements = uncovered_close_statements(window_id, is_covered).into();
        match self.writer.write(statements).await {
            Ok(_) => {
                self.reclaim_unused_shadows(session_id).await;
            }
            Err(failure) => log_unwritten_close(window_id, &WindowFailure::Write(failure)),
        }
    }

    // Reads what changed between `before` and `after`, keeps each before-image as a copy, takes
    // the fresh shadows under the session's shadow lock and writes the versions and the close in
    // one write there.
    async fn record_close(
        &self,
        window_id: CommandWindowId,
        window: &OpenWindow,
        before: &BeforeCapture,
        after: &CommandCaptureAfter,
        captured_at: Timestamp,
    ) -> Result<(), WindowFailure> {
        let session_id = window.session_id;
        let checkpoint_id = window.checkpoint_id.clone();
        let (linked, recorded) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, WindowFailure>((
                    window_shadows(reader, window_id)?,
                    recorded_paths(reader, &checkpoint_id)?,
                ))
            })
            .await?;
        let linked = tokio::task::spawn_blocking(move || {
            linked
                .into_iter()
                .map(|shadow| {
                    let now = file_facts(Path::new(shadow.path.as_str())).ok();
                    let comparison = compare_shadow(&shadow, now);
                    (shadow, comparison)
                })
                .collect::<Vec<(Shadow, ShadowComparison)>>()
        })
        .await?;
        let after_left_out: Vec<PathBuf> = after
            .capture
            .large_files
            .iter()
            .map(|file| file.path.clone())
            .chain(
                after
                    .capture
                    .unread_paths
                    .iter()
                    .map(|path| path.path.clone()),
            )
            .collect();
        let reading = read_window_changes(&WindowChanges {
            checkout_real_path: &before.checkout_real_path,
            linked_shadows: &linked,
            absent_before: &window.absent_before,
            changes: &after.changes,
            after_left_out: &after_left_out,
            recorded: &recorded,
        });
        if !reading.unnamable.is_empty() {
            tracing::warn!(
                window_id = window_id.text().as_str(),
                count = reading.unnamable.len(),
                "a command window's changed paths no row can name were not recorded"
            );
        }
        let kept = self
            .keep_before_images(window_id, window, &before.objects, &reading)
            .await;
        let mut statements: Vec<WriteStatement> = reading
            .versions
            .iter()
            .map(|planned| {
                let content = match &planned.content {
                    PlannedContent::BeforeImage {
                        blob,
                        is_executable,
                    } => match kept.get(blob) {
                        Some(KeptImage::Copied(hash)) => CheckpointVersionContent::Copy {
                            hash: hash.clone(),
                            mode: CopyMode::Executable(*is_executable),
                        },
                        Some(KeptImage::NotKept(reason)) => {
                            CheckpointVersionContent::NotKept { reason: *reason }
                        }
                        None => CheckpointVersionContent::NotKept {
                            reason: NotKeptReason::Failed,
                        },
                    },
                    PlannedContent::Created => CheckpointVersionContent::Created,
                    PlannedContent::NotKept(reason) => {
                        CheckpointVersionContent::NotKept { reason: *reason }
                    }
                    PlannedContent::Shadow(shadow_id) => CheckpointVersionContent::Shadow {
                        shadow_id: *shadow_id,
                    },
                };
                insert_version_statement(
                    &window.checkpoint_id,
                    &CheckpointVersion {
                        path: planned.path.clone(),
                        leg: CheckpointVersionLeg::Command,
                        content,
                        parent_real_path: planned.parent_real_path.clone(),
                        window_id: Some(window_id),
                        tool_call_id: None,
                    },
                )
            })
            .collect();
        statements.push(close_command_window_statement(&CommandWindowClosing {
            window_id,
            tree_after: Some(after.capture.tree.clone()),
            head_after: after.capture.head.clone(),
            commit_after: Some(after.capture.objects.commit().clone()),
            is_covered: window.began == Some(true),
        }));
        statements.push(unlink_window_shadows_statement(window_id));
        let hold = self.shadow_lock.acquire(session_id).await;
        statements.extend(
            self.close_shadows(
                &hold,
                &before.checkout_real_path,
                &linked,
                reading,
                captured_at,
            )
            .await?,
        );
        self.writer.write(statements).await?;
        drop(hold);
        Ok(())
    }

    // The shadow rows a close writes under `hold`: each fresh shadow, the path's current one
    // retired first where one stands, and each shadow the reading retires that is still its path's
    // current one, since another window may have retired it or shadowed the path afresh since.
    async fn close_shadows(
        &self,
        hold: &KeyHold<'_, SessionId>,
        checkout_real_path: &Path,
        linked: &[(Shadow, ShadowComparison)],
        reading: WindowReading,
        taken_at: Timestamp,
    ) -> Result<Vec<WriteStatement>, WindowFailure> {
        let session_id = *hold.key();
        if reading.fresh_shadows.is_empty() && reading.retired_shadows.is_empty() {
            return Ok(Vec::new());
        }
        let current = self.current_shadows(session_id).await?;
        let mut statements = Vec::new();
        for retired in &reading.retired_shadows {
            let path = linked
                .iter()
                .find(|(shadow, _)| shadow.shadow_id == *retired)
                .map(|(shadow, _)| &shadow.path);
            if let Some(path) = path
                && current
                    .get(path)
                    .is_some_and(|shadow| shadow.shadow_id == *retired)
            {
                statements.push(retire_current_shadow_statement(session_id, path));
            }
        }
        if reading.fresh_shadows.is_empty() {
            return Ok(statements);
        }
        let places = self.shadow_places(hold).await?;
        let checkout_real_path = checkout_real_path.to_path_buf();
        let fresh = reading.fresh_shadows;
        let taken = tokio::task::spawn_blocking(move || {
            let mut places = lock(&places);
            let mut statements = Vec::new();
            for relative in fresh {
                let Some(path) = checkout_path(&checkout_real_path, &relative) else {
                    continue;
                };
                let current_path: Option<FilesystemPath> =
                    current.contains_key(&path).then(|| path.clone());
                if let ShadowTaken::Taken {
                    shadow,
                    volume_folder,
                } = places.take_shadow(&checkout_real_path, &relative, path, taken_at)
                {
                    if let Some(current_path) = current_path {
                        statements.push(retire_current_shadow_statement(session_id, &current_path));
                    }
                    push_taken_shadow(&mut statements, &shadow, volume_folder.as_ref());
                } else if let Some(current_path) = current_path {
                    // The file is gone, so its path keeps no current shadow.
                    statements.push(retire_current_shadow_statement(session_id, &current_path));
                }
            }
            statements
        })
        .await?;
        statements.extend(taken);
        Ok(statements)
    }

    // Keeps a copy of each before-image `reading` plans, read from the before-capture `objects`,
    // and answers what each blob kept; a blob with no answer kept none, for a failed read.
    async fn keep_before_images(
        &self,
        window_id: CommandWindowId,
        window: &OpenWindow,
        objects: &CapturedCommit,
        reading: &WindowReading,
    ) -> HashMap<GitObjectId, KeptImage> {
        let mut kept = HashMap::new();
        let blobs: Vec<GitObjectId> = reading
            .versions
            .iter()
            .filter_map(|planned| match &planned.content {
                PlannedContent::BeforeImage { blob, .. } => Some(blob.clone()),
                PlannedContent::Created
                | PlannedContent::NotKept(_)
                | PlannedContent::Shadow(_) => None,
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if blobs.is_empty() {
            return kept;
        }
        let owner_folder = session_storage_folder(&self.data_folder, &window.session_id);
        let store = match tokio::task::spawn_blocking(move || CopyStore::open(&owner_folder)).await
        {
            Ok(Ok(store)) => store,
            Ok(Err(error)) => {
                log_unkept_images(window_id, &error);
                return kept;
            }
            Err(error) => {
                log_unkept_images(window_id, &error);
                return kept;
            }
        };
        let place: Option<&Place> = window.checkout.place.as_ref();
        let mut images = match self
            .captures
            .read_before_images(place, objects, blobs)
            .await
        {
            Ok(images) => images,
            Err(error) => {
                log_unkept_images(window_id, &error);
                return kept;
            }
        };
        let mut failed_copies = 0_usize;
        let mut first_failure: Option<FileCopyError> = None;
        loop {
            let batch = match images.next_batch().await {
                Ok(Some(batch)) => batch,
                Ok(None) => break,
                Err(error) => {
                    log_unkept_images(window_id, &error);
                    break;
                }
            };
            let store = store.clone();
            let copied = tokio::task::spawn_blocking(move || {
                batch
                    .into_iter()
                    .map(|(blob, image)| (blob, keep_image(&store, image)))
                    .collect::<Vec<_>>()
            })
            .await;
            let copied = match copied {
                Ok(copied) => copied,
                Err(error) => {
                    log_unkept_images(window_id, &error);
                    break;
                }
            };
            for (blob, outcome) in copied {
                let image = outcome.unwrap_or_else(|failure| {
                    failed_copies += 1;
                    first_failure.get_or_insert(failure);
                    KeptImage::NotKept(NotKeptReason::Failed)
                });
                kept.insert(blob, image);
            }
        }
        if let Some(failure) = first_failure {
            tracing::warn!(
                window_id = window_id.text().as_str(),
                count = failed_copies,
                error = &failure as &(dyn Error + 'static),
                "a command window's before-images could not all be copied"
            );
        }
        kept
    }

    // Deletes `session_id`'s shadows that are retired and used by no window or version, under its
    // shadow lock, and removes each one's clone once the delete committed; answers whether the
    // reclaim ran through, a failure logged.
    pub(super) async fn reclaim_unused_shadows(&self, session_id: SessionId) -> bool {
        let hold = self.shadow_lock.acquire(session_id).await;
        let reclaimed = async {
            let unused = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, WindowFailure>(unused_shadows(reader, session_id)?)
                })
                .await?;
            if unused.is_empty() {
                return Ok(());
            }
            let deletes = unused
                .iter()
                .map(|shadow| delete_unused_shadow_statement(shadow.shadow_id))
                .collect();
            self.writer.write(deletes).await?;
            let places = self.shadow_places(&hold).await?;
            tokio::task::spawn_blocking(move || {
                let places = lock(&places);
                for shadow in &unused {
                    if let Err(error) = places.remove_shadow_clone(shadow) {
                        tracing::warn!(
                            shadow_id = shadow.shadow_id.text().as_str(),
                            error = &error as &(dyn Error + 'static),
                            "an unused shadow's clone could not be removed"
                        );
                    }
                }
            })
            .await?;
            Ok::<_, WindowFailure>(())
        }
        .await;
        drop(hold);
        if let Err(error) = &reclaimed {
            tracing::warn!(
                session_id = %session_id,
                error = error as &(dyn Error + 'static),
                "a session's unused shadows could not be reclaimed"
            );
        }
        reclaimed.is_ok()
    }
}

// What `image` keeps: its bytes as a copy, or why none is kept.
fn keep_image(store: &CopyStore, image: BeforeImage) -> Result<KeptImage, FileCopyError> {
    match image {
        BeforeImage::Read(bytes) => store.keep_copy_from(&bytes[..]).map(KeptImage::Copied),
        BeforeImage::Missing => Ok(KeptImage::NotKept(NotKeptReason::Failed)),
        BeforeImage::OverBound { .. } => Ok(KeptImage::NotKept(NotKeptReason::TooLarge)),
    }
}

fn log_unkept_images(window_id: CommandWindowId, error: &(dyn Error + 'static)) {
    tracing::warn!(
        window_id = window_id.text().as_str(),
        error,
        "a command window's remaining before-images were not kept"
    );
}

fn log_unwritten_close(window_id: CommandWindowId, failure: &WindowFailure) {
    tracing::warn!(
        window_id = window_id.text().as_str(),
        error = failure as &(dyn Error + 'static),
        "a command window's close was not written; the next start settles it uncovered"
    );
}
