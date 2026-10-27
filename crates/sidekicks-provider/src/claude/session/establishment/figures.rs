//! The figures a session's creation reads beside its spawn, from one process that keeps nothing in
//! the session's folder on its model: the command choices its session holds and the reply reserve
//! of its model, each read once per key of the installed build and shared, and the reply reserve
//! read again for a model the session moved to. A failed read is recorded and held as its reason,
//! and the next session reads it again.

use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;

use crate::claude::session::answered_commands::{
    ClaudeCommandChoices, read_claude_command_choices, unreadable_claude_command_choices,
};
use crate::claude::session::errors::record_unheard_claude_failure;
use crate::claude::session::model_figures::{ClaudeFigureResult, ClaudeModelFigures};
use crate::claude::session::reply_reserve::{ClaudeReplyReserve, derive_claude_reply_reserve};
use crate::claude::session::state::ClaudeHeldCommandChoices;
use crate::claude::session::transport::readings::ClaudeSessionFolderReadRequest;
use crate::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::diagnostics::DriverDiagnosticKind;
use sidekicks_std::mutex_lock::lock;

// What one creation-time process reads for a session, shared by its two figures.
type CreationRead = Shared<BoxFuture<'static, ClaudeFigureResult<CreationFigures>>>;

// The two figures a creation-time process gives.
#[derive(Clone)]
struct CreationFigures {
    command_choices: ClaudeCommandChoices,
    reply_reserve: ClaudeReplyReserve,
}

/// The figures held for the installed Claude Code build, replaced by an empty store once the
/// daemon reads another build.
pub(crate) struct ClaudeHeldFigures {
    starts: Arc<dyn ClaudeProcessStarts>,
    rules: PathRules,
    current: Mutex<Arc<ClaudeModelFigures>>,
}

impl ClaudeHeldFigures {
    /// An empty store, read through `starts` in a place that spells paths by `rules`.
    pub(crate) fn new(starts: Arc<dyn ClaudeProcessStarts>, rules: PathRules) -> Self {
        Self {
            starts,
            rules,
            current: Mutex::new(Arc::new(ClaudeModelFigures::new(None, rules))),
        }
    }

    /// The store of the build read last.
    pub(crate) fn current(&self) -> Arc<ClaudeModelFigures> {
        Arc::clone(&self.lock())
    }

    /// Starts an empty store when `version` names another build than the one held.
    pub(crate) fn note_build(&self, version: &str) {
        let mut current = self.lock();
        if current.build_version.as_deref() != Some(version) {
            *current = Arc::new(ClaudeModelFigures::new(
                Some(version.to_owned()),
                self.rules,
            ));
        }
    }

    /// Reads the figures of a session spawned on `legs` beside its spawn, so creating it waits on
    /// nothing more, and answers the command choices it holds; a figure already held is not read
    /// again. Never fails: a failed read is recorded and held as its reason.
    pub(crate) fn read_creation_figures(
        &self,
        legs: &ClaudeSpawnBoundLegs,
    ) -> ClaudeHeldCommandChoices {
        let figures = self.current();
        let place = folder_read_of(legs, &legs.model);
        let session_id = legs.session_id;
        let creation = self.creation_read(&figures, &place);
        let choices_read = {
            let creation = creation.clone();
            move || async move { creation.await.map(|figures| figures.command_choices) }
        };
        let reserve_read =
            move || async move { creation.await.map(|figures| figures.reply_reserve) };
        let held_choices = {
            let (figures, place) = (Arc::clone(&figures), place.clone());
            async move {
                match figures.command_choices(&place, choices_read).await {
                    Ok(choices) => choices,
                    Err(error) => {
                        record_read_failure(session_id, "the creation-time figures read", &error);
                        unreadable_claude_command_choices(&error.to_string())
                    }
                }
            }
            .boxed()
            .shared()
        };
        let reserve = async move {
            // A failed read is recorded by the choices' waiter, which shares it.
            figures.reply_reserve(&place, reserve_read).await.is_ok()
        };
        // Both run now, beside the spawn, whoever reads their answer.
        drop(tokio::spawn(held_choices.clone()));
        drop(tokio::spawn(reserve));
        held_choices
    }

    /// The command choices `place` offers, as Settings reads them: the held read's, else one
    /// process that keeps nothing, shared with every session and Settings read waiting on the same
    /// folder and config folder. Fails with the read's failure, which is not held.
    pub(crate) async fn read_command_choices(
        &self,
        place: &ClaudeSessionFolderReadRequest,
    ) -> ClaudeFigureResult<ClaudeCommandChoices> {
        let figures = self.current();
        let creation = self.creation_read(&figures, place);
        figures
            .command_choices(place, move || async move {
                creation.await.map(|figures| figures.command_choices)
            })
            .await
    }

    /// Reads the reply reserve of the model `legs`' session runs on now, `running_model`, in its
    /// own process that keeps nothing, where none is held for it at the session's endpoint.
    #[expect(
        dead_code,
        reason = "a session's move to another model reads that model's reply reserve, which the \
                  session's context-usage read takes"
    )]
    pub(crate) fn read_reply_reserve_for(&self, legs: &ClaudeSpawnBoundLegs, running_model: &str) {
        let figures = self.current();
        let place = folder_read_of(legs, running_model);
        let session_id = legs.session_id;
        let read = {
            let (starts, place, model) = (
                Arc::clone(&self.starts),
                place.clone(),
                running_model.to_owned(),
            );
            move || async move {
                starts
                    .read_reply_reserve(place)
                    .await
                    .map(|reads| derive_claude_reply_reserve(&model, &reads))
                    .map_err(Arc::new)
            }
        };
        drop(tokio::spawn(async move {
            if let Err(error) = figures.reply_reserve(&place, read).await {
                record_read_failure(session_id, "the reply reserve read", &error);
            }
        }));
    }

    // The one process that reads both creation figures, started by whichever figure is read
    // first, which records the context windows it read.
    fn creation_read(
        &self,
        figures: &Arc<ClaudeModelFigures>,
        place: &ClaudeSessionFolderReadRequest,
    ) -> CreationRead {
        let starts = Arc::clone(&self.starts);
        let figures = Arc::clone(figures);
        let place = place.clone();
        async move {
            let read_models = figures.context_read_models(&place.spawn_environment);
            let environment = place.spawn_environment.clone();
            let model = place.model.clone();
            let mut reading = starts
                .read_creation_figures(place, read_models)
                .await
                .map_err(Arc::new)?;
            figures.record_context_reads(&environment, std::mem::take(&mut reading.context_reads));
            Ok(CreationFigures {
                command_choices: read_claude_command_choices(&reading),
                reply_reserve: derive_claude_reply_reserve(&model, &reading.reply_reserve_reads),
            })
        }
        .boxed()
        .shared()
    }

    fn lock(&self) -> MutexGuard<'_, Arc<ClaudeModelFigures>> {
        lock(&self.current)
    }
}

// Where a control-only process reads a figure of `legs`' session on `model`.
fn folder_read_of(legs: &ClaudeSpawnBoundLegs, model: &str) -> ClaudeSessionFolderReadRequest {
    ClaudeSessionFolderReadRequest {
        spawn_environment: legs.spawn_environment.clone(),
        working_directory: legs.working_directory.clone(),
        model: model.to_owned(),
    }
}

fn record_read_failure(
    session_id: SessionId,
    step: &str,
    error: &Arc<impl std::error::Error + 'static>,
) {
    record_unheard_claude_failure(
        DriverDiagnosticKind::ControlOnlyReadFailed,
        session_id,
        step,
        &**error,
    );
}
