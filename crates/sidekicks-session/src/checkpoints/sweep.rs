//! The checkpoint sweep: once at the daemon's start and every hour after, one pass removes each
//! folder a purge owes once its volume is back, reclaims each session's shadows nothing uses with
//! their clones, and passes over every capture folder of every session and workflow run, one per
//! owner and repository: packing what no ref of the repository reaches, packing again a capture
//! whose own pack failed, reclaiming a deleted run's objects and folding the packs. A session
//! marked for its purge is left to the purge.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_platforms::WallClock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::ScheduledJobOutcome;
use sidekicks_std::scheduler::budget::{
    BudgetTerm, FailedAfterWork, JobBudget, JobWorkload, MeteredJobOutcome, ProcessorMeter,
    metered_job,
};
use sidekicks_store::data_folder::{session_storage_folder, workflow_run_folder};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, place_column, text_column,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::turn_snapshot::repack::{
    CaptureFolderPass, CaptureFolderSweep, CapturePacking, SnapshotPoint,
};
use tokio_util::sync::CancellationToken;

use crate::checkpoints::command_windows::CommandWindows;
use crate::checkpoints::store::shadows::{
    delete_owed_folder_statement, owed_folders, sessions_with_unused_shadows,
};
use crate::checkpoints::volume_folders::{VolumeFolderRemoval, remove_volume_folder};

/// How often the sweep runs after its first pass at the daemon's start.
pub const CHECKPOINT_SWEEP_INTERVAL: Duration = Duration::from_hours(1);

/// The statements the sweep prepares on a pooled connection: every owner's repositories, one
/// session's window points, the owed folders, and the sessions holding unused shadows.
pub const CHECKPOINT_SWEEP_STATEMENT_CAPACITY: usize = 4;

/// A pair's row from a session run's context; the parts are read in this order, so a pair keeps
/// its first part's spelling and place.
const FROM_RUN_CONTEXT: i64 = 0;
/// A pair's row from a command window of a session.
const FROM_WINDOW: i64 = 1;
/// A pair's row from a workflow run's context.
const FROM_WORKFLOW_RUN: i64 = 2;

// Every owner's repository, three parts, each leaving out an owner whose session is marked for its
// purge: a session run's, from its context; a window's; and a workflow run's, from its context.
// Released contexts stay in, since a capture folder outlives its run. The contexts come first, so
// a pair keeps their spelling and place over a window's.
static PAIRS_SQL: LazyLock<String> = LazyLock::new(|| {
    let purge_requested = <&'static str>::from(SessionState::PurgeRequested);
    let unmarked = |session: &str| {
        format!(
            "NOT EXISTS (SELECT 1 FROM sessions
                     WHERE sessions.id = {session} AND sessions.state = '{purge_requested}')"
        )
    };
    format!(
        "SELECT DISTINCT {FROM_RUN_CONTEXT} AS source, context.session_id, NULL, NULL,
       context.git_common_dir, mount.place
  FROM run_execution_contexts AS context
  JOIN workspaces AS workspace ON workspace.id = context.workspace_id
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE NOT EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_runs.id = context.run_id)
   AND {context_unmarked}
UNION
SELECT DISTINCT {FROM_WINDOW}, checkpoint.session_id, NULL, NULL, command.git_common_dir,
       sessions.place
  FROM checkpoint_commands AS command
  JOIN session_checkpoints AS checkpoint ON checkpoint.checkpoint_id = command.checkpoint_id
  LEFT JOIN sessions ON sessions.id = checkpoint.session_id
 WHERE command.git_common_dir IS NOT NULL
   AND {window_unmarked}
UNION
SELECT DISTINCT {FROM_WORKFLOW_RUN}, run.session_id, version.definition_id, run.id,
       context.git_common_dir, mount.place
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  JOIN run_execution_contexts AS context ON context.run_id = run.id
  JOIN workspaces AS workspace ON workspace.id = context.workspace_id
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE {run_unmarked}
 ORDER BY source",
        context_unmarked = unmarked("context.session_id"),
        window_unmarked = unmarked("checkpoint.session_id"),
        run_unmarked = unmarked("run.session_id"),
    )
});

// One session's windows with a before-capture, both captures of each.
const WINDOW_POINTS_SQL: &str = "SELECT command.git_common_dir, command.commit_before,
       command.tree_before, command.head_before, command.commit_after, command.tree_after,
       command.head_after
  FROM checkpoint_commands AS command
  JOIN session_checkpoints AS checkpoint ON checkpoint.checkpoint_id = command.checkpoint_id
 WHERE checkpoint.session_id = @sessionId AND command.git_common_dir IS NOT NULL";

/// What the sweep is built from.
pub struct CheckpointSweepDeps {
    /// The daemon's read pool, sized with [`CHECKPOINT_SWEEP_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's writer, which deletes the owed rows of the folders removed.
    pub writer: Arc<DatabaseWriter>,
    /// The packing every capture folder's pass goes through.
    pub packing: Arc<CapturePacking>,
    /// The daemon's data folder, which holds each owner's folder.
    pub data_folder: PathBuf,
    /// The wall clock each pass reads its time from.
    pub clock: Arc<dyn WallClock>,
    /// The command windows, whose reclaim takes a session's unused shadows and their clones.
    pub windows: Arc<CommandWindows>,
}

/// The checkpoint sweep, keeping, for each owner and repository its last pass kept, what that pass
/// found, so an idle folder is skipped.
pub struct CheckpointSweep {
    deps: CheckpointSweepDeps,
    passes: Mutex<HashMap<PairKey, CaptureFolderPass>>,
}

/// What one pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CheckpointSweepCounts {
    /// The owners' repositories the pass came to.
    pub pairs_examined: u64,
    /// The ones whose capture folder was swept, not skipped.
    pub pairs_swept: u64,
    /// The owed folders read.
    pub owed_folders_examined: u64,
    /// The sessions whose unused shadows were reclaimed.
    pub sessions_reclaimed: u64,
}

/// Why a part of a pass failed; every other part still ran.
#[derive(Debug, thiserror::Error)]
pub enum CheckpointSweepError {
    /// The read pool did not run a read.
    #[error("the read pool did not run a checkpoint sweep's read")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("a checkpoint sweep's read failed")]
    Read(#[from] rusqlite::Error),
    /// The owed rows' delete was not kept.
    #[error("the owed folders' rows could not be deleted")]
    Write(#[from] WriteError),
}

/// One owner's capture folder for one repository: the owner's folder and the repository's common
/// git folder by its canonical path, so every spelling of one repository is one pair.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PairKey {
    owner_folder: PathBuf,
    common_folder: PathBuf,
}

/// One pair as a pass sweeps it.
struct Pair {
    key: PairKey,
    /// The first stored spelling of the common git folder, handed to git.
    common_folder: PathBuf,
    /// Where git runs for the repository.
    place: Option<Place>,
    /// The session whose windows' points the pair keeps; `None` for a workflow run.
    session_id: Option<SessionId>,
    /// Every spelling of the common git folder the session's windows recorded.
    window_spellings: HashSet<String>,
}

/// One row of the pairs' read.
struct PairRow {
    source: i64,
    session_id: SessionId,
    workflow_run: Option<(WorkflowDefinitionId, WorkflowRunId)>,
    common_folder: String,
    place: Option<Place>,
}

/// What a sweep pass counts its work in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckpointSweepWorkUnit {
    /// An owner's repository the pass came to.
    PairExamined,
    /// One whose capture folder was swept.
    PairSwept,
    /// An owed folder read.
    OwedFolderExamined,
    /// A session whose unused shadows were reclaimed.
    SessionReclaimed,
}

/// A pass's processor time on the daemon's own threads: 2 ms per pair examined, 20 ms more per
/// pair swept, 2 ms per owed folder and 5 ms per session reclaimed; git's own time is its own.
const CHECKPOINT_SWEEP_BUDGET: JobBudget<CheckpointSweepWorkUnit> = JobBudget::new(&[
    BudgetTerm {
        figure: Duration::from_millis(2),
        per: 1,
        unit: CheckpointSweepWorkUnit::PairExamined,
    },
    BudgetTerm {
        figure: Duration::from_millis(20),
        per: 1,
        unit: CheckpointSweepWorkUnit::PairSwept,
    },
    BudgetTerm {
        figure: Duration::from_millis(2),
        per: 1,
        unit: CheckpointSweepWorkUnit::OwedFolderExamined,
    },
    BudgetTerm {
        figure: Duration::from_millis(5),
        per: 1,
        unit: CheckpointSweepWorkUnit::SessionReclaimed,
    },
]);

/// The job the daemon's start schedules: one sweep pass per run, metered against its processor
/// budget. Fails when a part's read or write failed, after every part ran.
pub fn checkpoint_sweep_job(
    sweep: Arc<CheckpointSweep>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    metered_job(
        CHECKPOINT_SWEEP_BUDGET,
        Box::new(move |stop, meter| {
            let sweep = Arc::clone(&sweep);
            async move { run_metered_pass(&sweep, &stop, &meter).await }.boxed()
        }),
    )
}

// One metered pass: its workload is what it examined, none when it examined nothing.
async fn run_metered_pass(
    sweep: &CheckpointSweep,
    stop: &CancellationToken,
    meter: &ProcessorMeter,
) -> MeteredJobOutcome<CheckpointSweepWorkUnit> {
    let (counts, failure) = sweep.run_pass(stop, meter).await;
    if counts.pairs_examined == 0
        && counts.owed_folders_examined == 0
        && counts.sessions_reclaimed == 0
    {
        return failure.map_or(Ok(None), |failure| Err(failure.into()));
    }
    if counts.pairs_swept > 0 || counts.owed_folders_examined > 0 || counts.sessions_reclaimed > 0 {
        tracing::info!(
            pairs_examined = counts.pairs_examined,
            pairs_swept = counts.pairs_swept,
            owed_folders_examined = counts.owed_folders_examined,
            sessions_reclaimed = counts.sessions_reclaimed,
            "the checkpoint sweep passed over the capture folders"
        );
    }
    let mut workload =
        JobWorkload::of(CheckpointSweepWorkUnit::PairExamined, counts.pairs_examined);
    workload.add(CheckpointSweepWorkUnit::PairSwept, counts.pairs_swept);
    workload.add(
        CheckpointSweepWorkUnit::OwedFolderExamined,
        counts.owed_folders_examined,
    );
    workload.add(
        CheckpointSweepWorkUnit::SessionReclaimed,
        counts.sessions_reclaimed,
    );
    match failure {
        None => Ok(Some(workload)),
        Some(failure) => Err(FailedAfterWork {
            workload,
            failure: failure.into(),
        }
        .into()),
    }
}

impl CheckpointSweep {
    /// The sweep over `deps`, with no pass kept.
    pub fn new(deps: CheckpointSweepDeps) -> Self {
        Self {
            deps,
            passes: Mutex::new(HashMap::new()),
        }
    }

    /// One pass: the owed folders, the unused shadows, then every owner's capture folders, each
    /// part run whatever the one before it answered, its blocking work and reads charged to
    /// `meter`. A pass `stop` cuts answers its counts so far; a pair under way when it fires is
    /// cut, and the next pass clears what the cut left. Answers its counts beside the first
    /// part's read or write failure, once every part ran; a pair whose pass failed is logged and
    /// the pass goes on.
    pub async fn run_pass(
        &self,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
    ) -> (CheckpointSweepCounts, Option<CheckpointSweepError>) {
        let mut counts = CheckpointSweepCounts::default();
        let owed = self.remove_owed_folders(stop, meter, &mut counts).await;
        let shadows = self.reclaim_unused_shadows(stop, meter, &mut counts).await;
        let pairs = self.sweep_pairs(stop, meter, &mut counts).await;
        (counts, owed.and(shadows).and(pairs).err())
    }

    // Removes each owed folder whose volume is back and deletes its rows in one write; a folder on
    // an absent volume, or one whose removal failed, keeps its row.
    async fn remove_owed_folders(
        &self,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<(), CheckpointSweepError> {
        let read_meter = meter.clone();
        let folders = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_meter
                    .measure(|| owed_folders(reader))
                    .map_err(CheckpointSweepError::from)
            })
            .await?;
        counts.owed_folders_examined = u64::try_from(folders.len()).unwrap_or(u64::MAX);
        let mut deletes = Vec::new();
        for folder in folders {
            if stop.is_cancelled() {
                break;
            }
            let removed_folder = folder.clone();
            match meter
                .run_blocking(move || remove_volume_folder(&removed_folder))
                .await
            {
                Ok(Ok(VolumeFolderRemoval::Removed)) => {
                    deletes.push(delete_owed_folder_statement(&folder.folder));
                }
                Ok(Ok(VolumeFolderRemoval::VolumeAbsent)) => {}
                Ok(Err(error)) => tracing::warn!(
                    folder = folder.folder.as_str(),
                    error = &error as &(dyn Error + 'static),
                    "an owed folder could not be removed"
                ),
                Err(error) => tracing::warn!(
                    folder = folder.folder.as_str(),
                    error = &error as &(dyn Error + 'static),
                    "an owed folder's removal ended before it finished"
                ),
            }
        }
        // A folder removed before a failed write reads as removed at the next pass.
        if !deletes.is_empty() {
            self.deps.writer.write(deletes).await?;
        }
        Ok(())
    }

    // Reclaims the unused shadows of each session holding one, through the windows' reclaim.
    async fn reclaim_unused_shadows(
        &self,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<(), CheckpointSweepError> {
        let read_meter = meter.clone();
        let sessions = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_meter
                    .measure(|| sessions_with_unused_shadows(reader))
                    .map_err(CheckpointSweepError::from)
            })
            .await?;
        for session_id in sessions {
            if stop.is_cancelled() {
                break;
            }
            if self.deps.windows.reclaim_unused_shadows(session_id).await {
                counts.sessions_reclaimed += 1;
            }
        }
        Ok(())
    }

    // Passes over every pair the store names, keeping each pass that ran or skipped and only the
    // pairs this listing named.
    async fn sweep_pairs(
        &self,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<(), CheckpointSweepError> {
        let pairs = self.read_pairs(meter).await?;
        let listed: HashSet<PairKey> = pairs.iter().map(|pair| pair.key.clone()).collect();
        let mut session_windows = HashMap::new();
        let mut failure = None;
        for pair in pairs {
            if stop.is_cancelled() {
                break;
            }
            counts.pairs_examined += 1;
            let (points, kept_commits) = match self
                .read_window_points(&pair, &mut session_windows, meter)
                .await
            {
                Ok(read) => read,
                // Without its windows' points a pass could drop their captures, so none runs.
                Err(error) => {
                    lock(&self.passes).remove(&pair.key);
                    failure.get_or_insert(error);
                    continue;
                }
            };
            let last = lock(&self.passes).get(&pair.key).cloned();
            let swept = tokio::select! {
                biased;
                () = stop.cancelled() => break,
                swept = self.deps.packing.sweep_capture_folder(
                    pair.place.as_ref(),
                    &pair.key.owner_folder,
                    &pair.common_folder,
                    last.as_ref(),
                    &points,
                    &kept_commits,
                    self.deps.clock.now(),
                    meter,
                ) => swept,
            };
            let mut passes = lock(&self.passes);
            match swept {
                Ok(CaptureFolderSweep::Swept(pass)) => {
                    counts.pairs_swept += 1;
                    passes.insert(pair.key, pass);
                }
                Ok(CaptureFolderSweep::Skipped(pass)) => {
                    passes.insert(pair.key, pass);
                }
                Ok(CaptureFolderSweep::Absent | CaptureFolderSweep::RepositoryGone) => {
                    passes.remove(&pair.key);
                }
                Err(error) => {
                    tracing::warn!(
                        owner_folder = %pair.key.owner_folder.display(),
                        common_folder = %pair.common_folder.display(),
                        error = &error as &(dyn Error + 'static),
                        "a capture folder's sweep failed"
                    );
                    passes.remove(&pair.key);
                }
            }
        }
        lock(&self.passes).retain(|key, _| listed.contains(key));
        failure.map_or(Ok(()), Err)
    }

    // Every owner's repository, one pair per owner and repository by its canonical common git
    // folder; a row whose folder does not resolve is logged and left out.
    async fn read_pairs(&self, meter: &ProcessorMeter) -> Result<Vec<Pair>, CheckpointSweepError> {
        let read_meter = meter.clone();
        let rows = self
            .deps
            .reads
            .read(ReadLength::Long, move |reader| {
                read_meter
                    .measure(|| read_pair_rows(reader))
                    .map_err(CheckpointSweepError::from)
            })
            .await?;
        let mut canonical: HashMap<String, Option<PathBuf>> = HashMap::new();
        let mut pairs: Vec<Pair> = Vec::new();
        let mut positions: HashMap<PairKey, usize> = HashMap::new();
        for row in rows {
            if !canonical.contains_key(&row.common_folder) {
                let resolved = match canonical_folder_path(Path::new(&row.common_folder)).await {
                    Ok(resolved) => Some(resolved),
                    Err(error) => {
                        tracing::warn!(
                            common_folder = row.common_folder.as_str(),
                            error = &error as &(dyn Error + 'static),
                            "a recorded repository's git folder does not resolve"
                        );
                        None
                    }
                };
                canonical.insert(row.common_folder.clone(), resolved);
            }
            let common_folder = canonical.get(&row.common_folder).cloned().flatten();
            let Some(common_folder) = common_folder else {
                continue;
            };
            let (owner_folder, session_id) = match &row.workflow_run {
                Some((definition_id, workflow_run_id)) => (
                    workflow_run_folder(&self.deps.data_folder, definition_id, workflow_run_id),
                    None,
                ),
                None => (
                    session_storage_folder(&self.deps.data_folder, &row.session_id),
                    Some(row.session_id),
                ),
            };
            let key = PairKey {
                owner_folder,
                common_folder,
            };
            let position = *positions.entry(key.clone()).or_insert_with(|| {
                pairs.push(Pair {
                    key,
                    common_folder: PathBuf::from(&row.common_folder),
                    place: row.place.clone(),
                    session_id,
                    window_spellings: HashSet::new(),
                });
                pairs.len() - 1
            });
            if row.source == FROM_WINDOW {
                pairs[position].window_spellings.insert(row.common_folder);
            }
        }
        Ok(pairs)
    }

    // The points of `pair`'s session's windows on its repository, each window's before-capture
    // and, once taken, its after-capture, and the commit of every point of the session's windows
    // whatever repository their rows spell, which the reclaim keeps; each session's windows are
    // read once a pass, into `session_windows`. A workflow run's pair has none.
    async fn read_window_points(
        &self,
        pair: &Pair,
        session_windows: &mut HashMap<SessionId, Vec<WindowPointRow>>,
        meter: &ProcessorMeter,
    ) -> Result<(Vec<SnapshotPoint>, Vec<GitObjectId>), CheckpointSweepError> {
        let Some(session_id) = pair.session_id else {
            return Ok((Vec::new(), Vec::new()));
        };
        let rows = match session_windows.entry(session_id) {
            Entry::Occupied(read) => read.into_mut(),
            Entry::Vacant(unread) => {
                let read_meter = meter.clone();
                let rows = self
                    .deps
                    .reads
                    .read(ReadLength::Long, move |reader| {
                        read_meter
                            .measure(|| read_window_point_rows(reader, session_id))
                            .map_err(CheckpointSweepError::from)
                    })
                    .await?;
                unread.insert(rows)
            }
        };
        let points = rows
            .iter()
            .filter(|(spelling, _)| pair.window_spellings.contains(spelling))
            .flat_map(|(_, points)| points.iter().cloned())
            .collect();
        let commits = rows
            .iter()
            .flat_map(|(_, points)| points.iter().map(|point| point.commit.clone()))
            .collect();
        Ok((points, commits))
    }
}

// A window's recorded common git folder and its points.
type WindowPointRow = (String, Vec<SnapshotPoint>);

// The rows of the pairs' read, in its order.
fn read_pair_rows(reader: &Connection) -> rusqlite::Result<Vec<PairRow>> {
    reader
        .prepare_cached(&PAIRS_SQL)?
        .query_map([], |row| {
            let definition_id =
                optional_text_column(row, 2, |text| WorkflowDefinitionId::new(&text))?;
            let workflow_run_id = optional_text_column(row, 3, |text| WorkflowRunId::new(&text))?;
            Ok(PairRow {
                source: row.get(0)?,
                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                workflow_run: definition_id.zip(workflow_run_id),
                common_folder: row.get(4)?,
                place: place_column(row, 5)?,
            })
        })?
        .collect()
}

// Each of `session_id`'s windows with a before-capture: its recorded common git folder and its
// points.
fn read_window_point_rows(
    reader: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<WindowPointRow>> {
    reader
        .prepare_cached(WINDOW_POINTS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| {
                let object = |index| optional_text_column(row, index, closed_word::<GitObjectId>);
                let mut points = Vec::with_capacity(2);
                for [commit, tree, base] in [[1, 2, 3], [4, 5, 6]] {
                    if let (Some(commit), Some(tree)) = (object(commit)?, object(tree)?) {
                        points.push(SnapshotPoint {
                            commit,
                            tree,
                            base: object(base)?,
                        });
                    }
                }
                Ok((row.get(0)?, points))
            },
        )?
        .collect()
}

#[cfg(test)]
mod tests;
