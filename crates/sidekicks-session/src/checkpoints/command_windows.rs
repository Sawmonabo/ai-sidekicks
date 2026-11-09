//! A session's command windows: the captures around each command an agent runs and the versions
//! they record. [`CommandWindows`] serves the provider's command capture: it opens a window before
//! the command is let go, taking the before-capture and bringing the session's large-file shadows
//! up to date, and at the command's end takes the after-capture and records each changed path's
//! content before the command under the session's newest checkpoint. A window it could not capture
//! closes uncovered, and one a stop left open closes uncovered at the next start.

mod close;
pub mod versions;

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use rusqlite::Connection;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_platforms::file_facts;
use sidekicks_provider::port::command_capture::{
    CommandCapture, CommandWindowEnd, CommandWindowId as PortWindowId, CommandWindowOpenError,
    CommandWindowRefusal, CommandWindowStart,
};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::git::turn_snapshot::capture::CheckoutCaptureInput;
use sidekicks_workspace::git::turn_snapshot::command_capture::{
    CommandCapture as CheckoutCapture, CommandCaptureService,
};
use sidekicks_workspace::git::turn_snapshot::repack::{CapturePacking, CapturedCommit};
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};
use tokio::task::JoinError;
use tokio_util::task::TaskTracker;

use crate::checkpoints::command_windows::versions::checkout_path;
use crate::checkpoints::shadows::{
    ShadowComparison, ShadowPlaces, ShadowTaken, compare_shadow, recorded_path,
};
use crate::checkpoints::store::shadows::{
    Shadow, ShadowId, VolumeFolder, current_shadows, insert_current_shadow_statement,
    insert_volume_folder_statement, link_window_shadow_statement, retire_current_shadow_statement,
    unlink_window_shadows_statement, volume_folders,
};
use crate::checkpoints::store::{
    CommandWindowClosing, CommandWindowId, CommandWindowOpening, close_command_window_statement,
    newest_checkpoint, open_command_window_statement, open_windows,
};
use crate::run::checkout::{RunCheckout, read_run_checkout};

/// The statements the command windows prepare on a pooled connection: the run's checkout, the
/// session's working folder, its newest checkpoint, the paths a checkpoint records, the session's
/// current shadows, a window's shadows, the session's unused shadows, its folders on other volumes,
/// and the windows still open.
pub const COMMAND_WINDOWS_STATEMENT_CAPACITY: usize = 9;

/// What [`CommandWindows`] is built from.
pub struct CommandWindowsDeps {
    /// The daemon's read pool, sized with [`COMMAND_WINDOWS_STATEMENT_CAPACITY`].
    pub pool: Arc<DatabaseReadPool>,
    /// The daemon's writer.
    pub writer: Arc<DatabaseWriter>,
    /// Takes a command's two captures.
    pub captures: Arc<CommandCaptureService>,
    /// Packs each capture's borrowed objects into its capture folder.
    pub packing: Arc<CapturePacking>,
    /// The daemon's data folder, which holds each session's storage folder.
    pub data_folder: PathBuf,
}

/// Why the windows a stop left open could not be settled.
#[derive(Debug, thiserror::Error)]
pub enum CommandWindowSettleError {
    /// The read pool did not run the read.
    #[error("the read pool did not run the open windows' read")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the open command windows could not be read")]
    Read(#[from] rusqlite::Error),
    /// The write that closes them was not kept.
    #[error("the open command windows could not be closed")]
    Write(#[from] WriteError),
}

/// The captures around every command an agent runs, from its build until [`CommandWindows::stop`].
pub struct CommandWindows {
    recorder: Arc<WindowRecorder>,
}

/// What every window's work shares.
struct WindowRecorder {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    captures: Arc<CommandCaptureService>,
    packing: Arc<CapturePacking>,
    data_folder: PathBuf,
    /// Held per session from a read of its current shadows through the write that changes them,
    /// and around the reclaim of its unused ones.
    shadow_lock: KeyedLock<SessionId>,
    /// Each session's shadow places, opened at its first use and kept for the daemon run; touched
    /// only under the session's shadow lock.
    shadow_places: Mutex<HashMap<SessionId, Arc<Mutex<ShadowPlaces>>>>,
    /// The windows open in this daemon run.
    open_windows: Mutex<HashMap<CommandWindowId, OpenWindow>>,
    /// The sessions whose last capture could not even record its command uncovered.
    failed_sessions: Mutex<HashSet<SessionId>>,
    /// Every call's work under way, so the stop waits for each.
    tasks: TaskTracker,
}

/// One open window, as its close reads it.
struct OpenWindow {
    session_id: SessionId,
    checkpoint_id: SnapshotId,
    checkout: RunCheckout,
    /// `None` when the before-capture failed.
    before: Option<BeforeCapture>,
    /// The listed large or unread paths whose shadow's take found no file.
    absent_before: HashSet<PathBuf>,
    /// Whether the command began covered, once told.
    began: Option<bool>,
}

/// What a close needs of a before-capture.
struct BeforeCapture {
    tree: GitObjectId,
    objects: CapturedCommit,
    checkout_real_path: PathBuf,
}

/// Where a window's command runs, or why no window opens.
enum WindowPlace {
    Found {
        checkpoint_id: SnapshotId,
        checkout: RunCheckout,
    },
    Refused(CommandWindowRefusal),
}

/// The shadow rows an open writes, the shadows it links and the listed paths it found no file at.
#[derive(Default)]
struct OpenShadows {
    statements: Vec<WriteStatement>,
    links: Vec<ShadowId>,
    absent_before: HashSet<PathBuf>,
    unnamable: usize,
}

/// Why a step of a window failed.
#[derive(Debug, thiserror::Error)]
enum WindowFailure {
    #[error("the read pool did not run a command window's read")]
    Pool(#[from] DatabaseReadError),
    #[error("a command window's read failed")]
    Read(#[from] rusqlite::Error),
    #[error("the session's working folder could not be read")]
    WorkingFolder(#[from] WorkingFolderReadError),
    #[error("a command window's write was not kept")]
    Write(#[from] WriteError),
    #[error("a command window's path could not be recorded")]
    Path(#[source] io::Error),
    #[error("the session's shadow folder could not be made")]
    ShadowPlaces(#[source] io::Error),
    #[error("a blocking step of a command window did not finish")]
    Blocking(#[from] JoinError),
    #[error("the daemon is stopping, so no window opens")]
    Stopping,
}

impl CommandWindows {
    /// The windows over `deps`, with no window open and no session failed.
    pub fn new(deps: CommandWindowsDeps) -> Self {
        let CommandWindowsDeps {
            pool,
            writer,
            captures,
            packing,
            data_folder,
        } = deps;
        Self {
            recorder: Arc::new(WindowRecorder {
                pool,
                writer,
                captures,
                packing,
                data_folder,
                shadow_lock: KeyedLock::new(),
                shadow_places: Mutex::new(HashMap::new()),
                open_windows: Mutex::new(HashMap::new()),
                failed_sessions: Mutex::new(HashSet::new()),
                tasks: TaskTracker::new(),
            }),
        }
    }

    /// Whether `session_id`'s last capture failed so badly that its command could not even be
    /// recorded uncovered, which the undo's preview and its uncovered list name a failed capture;
    /// cleared by its next capture that succeeds.
    pub fn has_failed_capture(&self, session_id: SessionId) -> bool {
        lock(&self.recorder.failed_sessions).contains(&session_id)
    }

    /// Closes every window a stop left open as uncovered, its captures gone with the process that
    /// held them, and unlinks its shadows, in one write; answers how many it closed. Run at the
    /// start before any window can open. Fails when the read or the write fails, closing none.
    pub async fn settle_open_windows(&self) -> Result<usize, CommandWindowSettleError> {
        let open = self
            .recorder
            .pool
            .read(ReadLength::Short, |reader| {
                Ok::<_, CommandWindowSettleError>(open_windows(reader)?)
            })
            .await?;
        if open.is_empty() {
            return Ok(0);
        }
        let statements = open
            .iter()
            .flat_map(|&(window_id, _)| uncovered_close_statements(window_id, false))
            .collect();
        self.recorder.writer.write(statements).await?;
        Ok(open.len())
    }

    /// Deletes `session_id`'s shadows that are retired and used by no window or version, under its
    /// shadow lock, and removes each one's clone once the delete committed, answering whether it
    /// ran through. Never fails: a failure is logged, and the next reclaim finds the shadows again.
    pub async fn reclaim_unused_shadows(&self, session_id: SessionId) -> bool {
        self.recorder.reclaim_unused_shadows(session_id).await
    }

    /// Opens no window from now on and settles once every call's work under way has ended; none is
    /// cut short, so each close under way is written.
    pub async fn stop(&self) {
        self.recorder.tasks.close();
        self.recorder.tasks.wait().await;
    }
}

impl CommandCapture for CommandWindows {
    /// Made by each leg before it lets its command go: opens the window on a task the stop waits
    /// for, and answers once its before-capture and rows are written, or it failed.
    fn open_window(
        &self,
        start: CommandWindowStart,
    ) -> BoxFuture<'_, Result<PortWindowId, CommandWindowOpenError>> {
        let recorder = Arc::clone(&self.recorder);
        async move {
            let session_id = start.session_id;
            let opening = {
                // Holds the stop's wait until the open is spawned or, the tracker closed, refused.
                let _spawning = recorder.tasks.token();
                (!recorder.tasks.is_closed())
                    .then(|| recorder.tasks.spawn(Arc::clone(&recorder).open(start)))
            };
            let Some(opening) = opening else {
                recorder.mark_failed(session_id);
                return Err(capture_failed(WindowFailure::Stopping));
            };
            match opening.await {
                Ok(opened) => {
                    opened.map(|window_id| PortWindowId::new(window_id.text().as_str().to_owned()))
                }
                Err(ended) => {
                    recorder.mark_failed(session_id);
                    Err(capture_failed(WindowFailure::Blocking(ended)))
                }
            }
        }
        .boxed()
    }

    /// Made by each leg once it let the command go after the open: keeps whether it began covered.
    fn command_began(&self, window: &PortWindowId, is_covered: bool) -> BoxFuture<'_, ()> {
        if let Some(window_id) = store_window_id(window)
            && let Some(open) = lock(&self.recorder.open_windows).get_mut(&window_id)
        {
            open.began = Some(is_covered);
        }
        async {}.boxed()
    }

    /// Made by each leg at the command's end: starts the close on a task the stop waits for and
    /// answers at once. A close the stop already passed leaves the window's row open, which the
    /// next start settles uncovered.
    fn close_window(&self, window: PortWindowId, end: CommandWindowEnd) -> BoxFuture<'_, ()> {
        let recorder = &self.recorder;
        if let Some(window_id) = store_window_id(&window) {
            let _spawning = recorder.tasks.token();
            if recorder.tasks.is_closed() {
                tracing::warn!(
                    window_id = window_id.text().as_str(),
                    "a command window closed past the stop; the next start settles it uncovered"
                );
            } else {
                recorder
                    .tasks
                    .spawn(Arc::clone(recorder).close(window_id, end));
            }
        }
        async {}.boxed()
    }

    /// Made by a leg whose command ran with no window: starts the record on a task the stop waits
    /// for and answers at once. A record the stop already passed is not written.
    fn record_uncovered_command(&self, start: CommandWindowStart) -> BoxFuture<'_, ()> {
        let recorder = &self.recorder;
        let _spawning = recorder.tasks.token();
        if recorder.tasks.is_closed() {
            tracing::warn!(
                session_id = %start.session_id,
                "a command that ran with no window was named past the stop, so it is not recorded"
            );
        } else {
            recorder
                .tasks
                .spawn(Arc::clone(recorder).record_uncovered_command(start));
        }
        async {}.boxed()
    }
}

impl WindowRecorder {
    // Opens a window for `start`: refused with no row where the session has no checkpoint or the
    // run no checkout; otherwise written covered or with a failed before-capture, or, where that
    // write fails, opened and closed uncovered before it fails.
    async fn open(
        self: Arc<Self>,
        start: CommandWindowStart,
    ) -> Result<CommandWindowId, CommandWindowOpenError> {
        let session_id = start.session_id;
        let apart_run = start.apart_run;
        let found = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_window_place(reader, session_id, apart_run)
            })
            .await;
        let (checkpoint_id, checkout) = match found {
            Ok(WindowPlace::Found {
                checkpoint_id,
                checkout,
            }) => (checkpoint_id, checkout),
            Ok(WindowPlace::Refused(refusal)) => {
                return Err(CommandWindowOpenError::Refused(refusal));
            }
            // With no checkpoint read, no row can name the command.
            Err(failure) => {
                self.mark_failed(session_id);
                return Err(capture_failed(failure));
            }
        };
        let window_id = CommandWindowId::mint();
        let opening = bare_opening(window_id, checkpoint_id.clone(), start);
        let input = CheckoutCaptureInput {
            owner_folder: session_storage_folder(&self.data_folder, &session_id),
            execution_root: checkout.execution_root.clone(),
            checkout_root: checkout.checkout_root.clone(),
            captured_at: Timestamp::now(),
        };
        // The service logs a failed capture with its step.
        let captured = self
            .captures
            .capture_before(checkout.place.as_ref(), &input)
            .await
            .ok();
        let written = match &captured {
            Some(capture) => {
                self.write_covered_open(session_id, &opening, capture, input.captured_at)
                    .await
            }
            None => self
                .writer
                .write(vec![open_command_window_statement(&opening)])
                .await
                .map(|_| HashSet::new())
                .map_err(WindowFailure::from),
        };
        let absent_before = match written {
            Ok(absent_before) => absent_before,
            Err(failure) => {
                self.write_run_uncovered(session_id, &opening).await;
                return Err(capture_failed(failure));
            }
        };
        let before = captured.map(|capture| {
            lock(&self.failed_sessions).remove(&session_id);
            let place = checkout.place.clone();
            let packing = Arc::clone(&self.packing);
            let objects = capture.objects.clone();
            // Off the path: the wrapper is let go once this answers.
            self.tasks.spawn(async move {
                packing.pack(place.as_ref(), &objects).await;
            });
            BeforeCapture {
                tree: capture.tree,
                objects: capture.objects,
                checkout_real_path: capture.checkout_real_path,
            }
        });
        lock(&self.open_windows).insert(
            window_id,
            OpenWindow {
                session_id,
                checkpoint_id,
                checkout,
                before,
                absent_before,
                began: None,
            },
        );
        Ok(window_id)
    }

    // Records `start`'s command, which ran with no window, as a window opened and closed
    // uncovered under the session's newest checkpoint: nothing where an open would be refused, and
    // the session marked failed where no row can name the command.
    async fn record_uncovered_command(self: Arc<Self>, start: CommandWindowStart) {
        let session_id = start.session_id;
        let apart_run = start.apart_run;
        let found = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_window_place(reader, session_id, apart_run)
            })
            .await;
        let checkpoint_id = match found {
            Ok(WindowPlace::Found { checkpoint_id, .. }) => checkpoint_id,
            Ok(WindowPlace::Refused(refusal)) => {
                tracing::debug!(
                    %session_id,
                    %refusal,
                    "a command that ran with no window has nothing to be recorded against"
                );
                return;
            }
            Err(failure) => {
                tracing::warn!(
                    %session_id,
                    error = &failure as &(dyn std::error::Error + 'static),
                    "a command that ran with no window could not be recorded as run uncovered"
                );
                self.mark_failed(session_id);
                return;
            }
        };
        let opening = bare_opening(CommandWindowId::mint(), checkpoint_id, start);
        self.write_run_uncovered(session_id, &opening).await;
    }

    // Writes `opening`'s window opened and closed uncovered in one write, marking `session_id`'s
    // capture failed where the write fails.
    async fn write_run_uncovered(&self, session_id: SessionId, opening: &CommandWindowOpening) {
        let uncovered = vec![
            open_command_window_statement(opening),
            close_command_window_statement(&uncovered_closing(opening.window_id, false)),
        ];
        if let Err(unwritten) = self.writer.write(uncovered).await {
            tracing::warn!(
                %session_id,
                error = &unwritten as &(dyn std::error::Error + 'static),
                "a command could not be recorded as run uncovered"
            );
            self.mark_failed(session_id);
        }
    }

    // Writes the open of `session_id`'s window whose before-capture `capture` was taken at
    // `captured_at`, with the session's large-file shadows brought up to date and linked, under its
    // shadow lock; answers the listed paths whose take found no file.
    async fn write_covered_open(
        &self,
        session_id: SessionId,
        opening: &CommandWindowOpening,
        capture: &CheckoutCapture,
        captured_at: Timestamp,
    ) -> Result<HashSet<PathBuf>, WindowFailure> {
        let checkout_real_path = &capture.checkout_real_path;
        let mut unnamable = 0;
        let ignored_folders = capture
            .ignored_folders
            .iter()
            .filter_map(|folder| {
                let named = checkout_path(checkout_real_path, folder);
                unnamable += usize::from(named.is_none());
                named
            })
            .collect();
        let opening = CommandWindowOpening {
            tree_before: Some(capture.tree.clone()),
            head_before: capture.head.clone(),
            commit_before: Some(capture.objects.commit().clone()),
            git_common_dir: Some(
                recorded_path(&capture.common_folder).map_err(WindowFailure::Path)?,
            ),
            ignored_folders,
            ..opening.clone()
        };
        let listed = capture
            .large_files
            .iter()
            .map(|file| file.path.clone())
            .chain(capture.unread_paths.iter().map(|path| path.path.clone()))
            .collect();
        let hold = self.shadow_lock.acquire(session_id).await;
        let shadows = self
            .open_shadows(&hold, checkout_real_path, listed, captured_at)
            .await?;
        let mut statements = vec![open_command_window_statement(&opening)];
        statements.extend(shadows.statements);
        statements.extend(
            shadows
                .links
                .into_iter()
                .map(|shadow_id| link_window_shadow_statement(opening.window_id, shadow_id)),
        );
        self.writer.write(statements).await?;
        drop(hold);
        unnamable += shadows.unnamable;
        if unnamable > 0 {
            tracing::warn!(
                window_id = opening.window_id.text().as_str(),
                count = unnamable,
                "a command window's listed paths no row can name were left out of it"
            );
        }
        Ok(shadows.absent_before)
    }

    // Brings each listed path's shadow up to date under `hold`: a current shadow whose file is
    // unchanged is linked, a changed one retired and taken afresh, and a path with none takes its
    // first.
    async fn open_shadows(
        &self,
        hold: &KeyHold<'_, SessionId>,
        checkout_real_path: &Path,
        listed: Vec<PathBuf>,
        taken_at: Timestamp,
    ) -> Result<OpenShadows, WindowFailure> {
        if listed.is_empty() {
            return Ok(OpenShadows::default());
        }
        let session_id = *hold.key();
        let current = self.current_shadows(session_id).await?;
        let places = self.shadow_places(hold).await?;
        let checkout_real_path = checkout_real_path.to_path_buf();
        let shadows = tokio::task::spawn_blocking(move || {
            let mut places = lock(&places);
            let mut shadows = OpenShadows::default();
            for relative in listed {
                let Some(path) = checkout_path(&checkout_real_path, &relative) else {
                    shadows.unnamable += 1;
                    continue;
                };
                if let Some(shadow) = current.get(&path) {
                    let now = file_facts(Path::new(path.as_str())).ok();
                    if compare_shadow(shadow, now) == ShadowComparison::Unchanged {
                        shadows.links.push(shadow.shadow_id);
                        continue;
                    }
                    shadows
                        .statements
                        .push(retire_current_shadow_statement(session_id, &path));
                }
                match places.take_shadow(&checkout_real_path, &relative, path, taken_at) {
                    ShadowTaken::Gone => {
                        shadows.absent_before.insert(relative);
                    }
                    ShadowTaken::Taken {
                        shadow,
                        volume_folder,
                    } => {
                        shadows.links.push(shadow.shadow_id);
                        push_taken_shadow(&mut shadows.statements, &shadow, volume_folder.as_ref());
                    }
                }
            }
            shadows
        })
        .await?;
        Ok(shadows)
    }

    // `session_id`'s current shadows by path, read under its shadow lock.
    async fn current_shadows(
        &self,
        session_id: SessionId,
    ) -> Result<HashMap<FilesystemPath, Shadow>, WindowFailure> {
        let shadows = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, WindowFailure>(current_shadows(reader, session_id)?)
            })
            .await?;
        Ok(shadows
            .into_iter()
            .map(|shadow| (shadow.path.clone(), shadow))
            .collect())
    }

    // The shadow places of the session `hold` holds, opened with its folders on other volumes at
    // its first use.
    async fn shadow_places(
        &self,
        hold: &KeyHold<'_, SessionId>,
    ) -> Result<Arc<Mutex<ShadowPlaces>>, WindowFailure> {
        let session_id = *hold.key();
        if let Some(places) = lock(&self.shadow_places).get(&session_id) {
            return Ok(Arc::clone(places));
        }
        let folders = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, WindowFailure>(volume_folders(reader, session_id)?)
            })
            .await?;
        let owner_folder = session_storage_folder(&self.data_folder, &session_id);
        let places = tokio::task::spawn_blocking(move || {
            ShadowPlaces::open(&owner_folder, session_id, folders)
        })
        .await?
        .map_err(WindowFailure::ShadowPlaces)?;
        let places = Arc::new(Mutex::new(places));
        lock(&self.shadow_places).insert(session_id, Arc::clone(&places));
        Ok(places)
    }

    // Marks `session_id`'s capture failed until its next capture succeeds.
    fn mark_failed(&self, session_id: SessionId) {
        lock(&self.failed_sessions).insert(session_id);
    }
}

// Where `session_id`'s window runs: its newest checkpoint, and the checkout of `apart_run`, else
// of that checkpoint's run, else, for a chat, its managed workspace.
fn read_window_place(
    reader: &Connection,
    session_id: SessionId,
    apart_run: Option<RunId>,
) -> Result<WindowPlace, WindowFailure> {
    // Before the first checkpoint there is no coverage to lose.
    let Some(newest) = newest_checkpoint(reader, session_id)? else {
        return Ok(WindowPlace::Refused(CommandWindowRefusal::NoCheckpoint));
    };
    let checkpoint = newest.checkpoint;
    let run_id = apart_run.unwrap_or(checkpoint.run_id);
    if let Some(checkout) = read_run_checkout(reader, run_id)? {
        return Ok(WindowPlace::Found {
            checkpoint_id: checkpoint.checkpoint_id,
            checkout,
        });
    }
    // A chat's run writes no execution context; its managed workspace is its checkout.
    let folder = read_working_folder(reader, &session_id)?;
    Ok(match (folder.shape, folder.working_folder) {
        (SessionShape::Chat, Some(working_folder)) => WindowPlace::Found {
            checkpoint_id: checkpoint.checkpoint_id,
            checkout: RunCheckout {
                execution_root: working_folder.clone(),
                checkout_root: working_folder,
                place: folder.place,
            },
        },
        _ => WindowPlace::Refused(CommandWindowRefusal::NoCheckout),
    })
}

// The opening of `window_id` under `checkpoint_id` for `start`'s command, with no before-capture.
fn bare_opening(
    window_id: CommandWindowId,
    checkpoint_id: SnapshotId,
    start: CommandWindowStart,
) -> CommandWindowOpening {
    CommandWindowOpening {
        window_id,
        checkpoint_id,
        tree_before: None,
        head_before: None,
        commit_before: None,
        git_common_dir: None,
        ignored_folders: Vec::new(),
        command: start.command,
        tool_call_id: start.tool_call_id,
    }
}

// The store's id of the port's `window`, `None`, logged, for one no open of this service named.
fn store_window_id(window: &PortWindowId) -> Option<CommandWindowId> {
    match CommandWindowId::parse(window.as_str()) {
        Ok(window_id) => Some(window_id),
        Err(error) => {
            tracing::warn!(
                window = window.as_str(),
                error = &error as &(dyn std::error::Error + 'static),
                "a command window's call named a window no open named"
            );
            None
        }
    }
}

// The close of `window_id` with no after-capture, covered as `is_covered` says.
fn uncovered_closing(window_id: CommandWindowId, is_covered: bool) -> CommandWindowClosing {
    CommandWindowClosing {
        window_id,
        tree_after: None,
        head_after: None,
        commit_after: None,
        is_covered,
    }
}

// The close of `window_id` with no after-capture and the removal of its links to shadows.
fn uncovered_close_statements(window_id: CommandWindowId, is_covered: bool) -> [WriteStatement; 2] {
    [
        close_command_window_statement(&uncovered_closing(window_id, is_covered)),
        unlink_window_shadows_statement(window_id),
    ]
}

// The rows of a shadow just taken: its session's folder on another volume where the take named
// one, and the shadow as its path's current one.
fn push_taken_shadow(
    statements: &mut Vec<WriteStatement>,
    shadow: &Shadow,
    volume_folder: Option<&VolumeFolder>,
) {
    if let Some(folder) = volume_folder {
        statements.push(insert_volume_folder_statement(shadow.session_id, folder));
    }
    statements.push(insert_current_shadow_statement(shadow));
}

fn capture_failed(failure: WindowFailure) -> CommandWindowOpenError {
    CommandWindowOpenError::CaptureFailed(Box::new(failure))
}

#[cfg(test)]
pub(crate) mod test_fixture;
#[cfg(test)]
mod tests;
