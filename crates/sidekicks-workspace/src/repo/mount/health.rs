//! A repository mount's health as every surface reads it, and the re-probe that tells each session
//! on a mount when that health changed.
//!
//! - A probe reads the root's reachability, then, when the root is reachable and the mount carries
//!   an identity anchor, asks git which repository's top level the root is. Only git's own answer
//!   that the root is no repository's top level reads `notARepository`; a git that could not
//!   answer is no verdict, which the re-probe logs, keeping the verdict each session last heard.
//! - Health is never stored. The re-probe keeps, in memory, the verdict each session on a mount
//!   last heard; a session it has not yet told holds what its log last said
//!   (`repoMount.health.changed`), `healthy` when the log says nothing, so a change while the
//!   daemon was down still reaches it. A send that fails leaves that session's verdict where it
//!   was, so the next pass sends it again.
//! - Mounts are probed as many at once as the machine has processors, one pass per mount at a
//!   time; every call that arrives during a mount's pass is served by the one pass after it.
//! - A probe's file reads are held to the bounded read's ceiling: a root that does not open in
//!   time, or whose resolve then gets no answer in time, reads `unreachable`.
//! - Each probe is bounded by the git runner's bound. A probe that runs out of time reads
//!   `unreachable` at the service's start, so a mount that hangs is never left on the assumed
//!   `healthy`, and leaves the verdict unchanged on a re-probe. A probe that ran out of time keeps
//!   running, and the mount's next pass waits on it rather than start another beside it.
//! - The stop ends every pass at once and nothing is sent after it.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::folders::RepoMountRootResolutionReason;
use sidekicks_contracts::repo::mount::{
    RepoMountHealth, RepoMountId, RepoMountState, WorkspaceState,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::GIT_COMMAND_TIMEOUT;
use crate::projector::{
    FilesystemPathProbe, HealthProjectionError, RepoMountHealthRow, RepoMountIdentityObservation,
    compute_repo_mount_health,
};
use crate::repo::errors::RepoRefusal;
use crate::repo::root_resolver::RepoRootResolver;
use crate::row_guards::{
    CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH, probe_filesystem_path,
};
use crate::trust_envelope::{components_equal, is_contained_within};
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::processor_bound::map_with_processor_bound;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, text_column,
};
use sidekicks_store::events::session::appender::{SessionEventEmitError, SessionEventLinkage};

/// The statements the re-probe's reads keep prepared on each read connection.
pub(crate) const REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY: usize = 5;

// What every attached-mount read selects, in the order `attached_mount_of` reads it.
static ATTACHED_MOUNT_COLUMNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, canonical_root, place, json_extract(metadata, '{COMMON_DIR_METADATA_PATH}')
   FROM repo_mounts
  WHERE state = '{}'",
        <&'static str>::from(RepoMountState::Attached)
    )
});

static SELECT_ATTACHED_MOUNTS_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{} ORDER BY id", *ATTACHED_MOUNT_COLUMNS_SQL));

// Read at the pass, so a mount detached while its pass waited is skipped.
static SELECT_ATTACHED_MOUNT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{} AND id = @repo_mount_id", *ATTACHED_MOUNT_COLUMNS_SQL));

// The checkouts the live workspaces on attached mounts work in.
static SELECT_MOUNT_CHECKOUTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT workspace.repo_mount_id,
        json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}')
   FROM workspaces AS workspace
   JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE mount.state = '{}' AND workspace.state <> '{}'
    AND json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}') IS NOT NULL",
        <&'static str>::from(RepoMountState::Attached),
        <&'static str>::from(WorkspaceState::Archived)
    )
});

static SELECT_SESSIONS_ON_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT session_id
   FROM workspaces
  WHERE repo_mount_id = @repo_mount_id AND state <> '{}'
  ORDER BY session_id",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// The health of the newest change a session's log holds for a mount, as JSON text.
static SELECT_LAST_LOGGED_HEALTH_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(payload, '$.health')
   FROM session_events
  WHERE session_id = @session_id AND type = '{}'
    AND json_extract(payload, '$.repoMountId') = @repo_mount_id
  ORDER BY sequence DESC
  LIMIT 1",
        SessionEventType::RepoMountHealthChanged.as_str()
    )
});

/// Why a mount's health could not be read now.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MountHealthProbeError {
    /// git could not answer which repository the root holds, which is no verdict; the refusal
    /// keeps why.
    #[error("git could not answer for the repo mount's root")]
    GitUnanswered(#[source] RepoRefusal),
    /// The probe and the row did not belong together.
    #[error(transparent)]
    Projection(#[from] HealthProjectionError),
}

/// Probes the mount `mount_row` describes now, asking `resolver` for the root's repository when
/// the root is reachable and the mount carries an anchor; containment and equality are the trust
/// envelope's component comparisons. Fails with [`MountHealthProbeError::GitUnanswered`] when git
/// cannot answer, and with [`MountHealthProbeError::Projection`] when the probe and the row do not
/// belong together.
pub(crate) async fn probe_repo_mount_health(
    resolver: &RepoRootResolver,
    mount_row: &RepoMountHealthRow<'_>,
) -> Result<RepoMountHealth, MountHealthProbeError> {
    let probe = probe_filesystem_path(mount_row.canonical_root, mount_row.place).await;
    let Some(anchor) = mount_row.common_dir_anchor.filter(|_| probe.is_reachable) else {
        return Ok(compute_repo_mount_health(mount_row, &probe, None)?);
    };
    let identity = match resolver
        .read_repository_identity(mount_row.canonical_root)
        .await
    {
        // The root opened, then its resolve or a git call got no answer in time, or the resolve was
        // refused: out of reach.
        Err(RepoRefusal::RootResolutionFailed {
            reason: RepoMountRootResolutionReason::NotReadable,
            ..
        }) => {
            let unreachable = FilesystemPathProbe {
                is_reachable: false,
                ..probe
            };
            return Ok(compute_repo_mount_health(mount_row, &unreachable, None)?);
        }
        Err(refusal) => return Err(MountHealthProbeError::GitUnanswered(refusal)),
        Ok(None) => RepoMountIdentityObservation::NotARepository,
        Ok(Some(common_folder)) if components_equal(&common_folder, anchor) => {
            RepoMountIdentityObservation::Anchored
        }
        Ok(Some(_)) => RepoMountIdentityObservation::Other,
    };
    Ok(compute_repo_mount_health(
        mount_row,
        &probe,
        Some(identity),
    )?)
}

/// Why the re-probe could not read the rows it works from.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MountHealthReadError {
    /// SQLite refused the read, or a stored row does not read.
    #[error("the attached repo mounts, their sessions or a session's log could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// Why one mount's pass did not tell every session on it what it found.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MountPassFailure {
    /// The mount's rows could not be read.
    #[error("repo mount {repo_mount_id}: its rows could not be read")]
    Read {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// Why.
        #[source]
        source: MountHealthReadError,
    },
    /// The probe and the mount's row did not belong together.
    #[error("repo mount {repo_mount_id}: its health could not be projected")]
    Projection {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// Why.
        #[source]
        source: HealthProjectionError,
    },
    /// The probe's task did not finish.
    #[error("repo mount {repo_mount_id}: its health probe did not finish")]
    ProbeTask {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// Why.
        #[source]
        source: JoinError,
    },
    /// A changed verdict could not be sent to one or more sessions on the mount; each is sent
    /// again on the mount's next pass.
    #[error("repo mount {repo_mount_id}: a health change did not reach every session on it")]
    Send {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// Each failed send.
        #[source]
        source: SettleFailures<SessionEventEmitError>,
    },
}

/// Why a re-probe did not finish telling every session what changed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReprobeError {
    /// The attached mounts could not be read, so none was probed.
    #[error("the attached repo mounts could not be read")]
    Read(#[from] MountHealthReadError),
    /// One or more mounts' passes failed; every other mount's pass finished.
    #[error(transparent)]
    Passes(#[from] SettleFailures<Arc<MountPassFailure>>),
}

/// The facts that make two health readings one verdict; the instant changes on every probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MountVerdict {
    Healthy,
    Unreachable,
    IdentityMismatch { is_repository: bool },
}

impl MountVerdict {
    // What a session holds before anything was said to it.
    const ASSUMED: Self = Self::Healthy;

    fn of(health: &RepoMountHealth) -> Self {
        match health {
            RepoMountHealth::Healthy { .. } => Self::Healthy,
            RepoMountHealth::Unreachable { .. } => Self::Unreachable,
            RepoMountHealth::IdentityMismatch { is_repository, .. } => Self::IdentityMismatch {
                is_repository: *is_repository,
            },
        }
    }
}

// What a probe that runs out of time reads as.
#[derive(Clone, Copy, Debug)]
enum ProbeTimeoutReading {
    // At the service's start, before any verdict was sent.
    Unreachable,
    // After it.
    NoVerdict,
}

// An attached mount's row, owned so a probe's task can carry it.
#[derive(Clone, Debug)]
struct AttachedMount {
    id: RepoMountId,
    canonical_root: PathBuf,
    place: Option<Place>,
    common_dir_anchor: Option<PathBuf>,
}

impl AttachedMount {
    fn health_row(&self) -> RepoMountHealthRow<'_> {
        RepoMountHealthRow {
            canonical_root: &self.canonical_root,
            place: self.place.as_ref(),
            common_dir_anchor: self.common_dir_anchor.as_deref(),
        }
    }
}

type ProbeTask = JoinHandle<Result<RepoMountHealth, MountHealthProbeError>>;

// What the re-probe remembers of one mount.
#[derive(Default)]
struct MountMemory {
    // The verdict each session on the mount last heard, from a send or from its log.
    heard: HashMap<SessionId, MountVerdict>,
    // Every pass request numbered below this was served by a pass that started after it.
    served_below: u64,
    // The failure of the mount's last pass, which the requests it served answer with.
    last_failure: Option<Arc<MountPassFailure>>,
    // A probe a pass stopped waiting for, still running.
    probe_in_flight: Option<ProbeTask>,
}

/// Recomputes the health of attached mounts and sends `repoMount.health.changed` to every session
/// on a mount whose verdict changed: every mount at the service's start
/// ([`start_probe`](Self::start_probe)) and on wake ([`reprobe`](Self::reprobe)), and only the
/// mounts holding a folder that changed
/// ([`reprobe_mounts_containing`](Self::reprobe_mounts_containing)). See the module doc.
pub(crate) struct RepoMountHealthReprobe {
    reads: Arc<DatabaseReadPool>,
    events: Arc<WorkspaceEventEmitter>,
    resolver: RepoRootResolver,
    stop: CancellationToken,
    passes: KeyedLock<RepoMountId>,
    pass_requests: AtomicU64,
    mounts: Mutex<HashMap<RepoMountId, MountMemory>>,
}

impl RepoMountHealthReprobe {
    /// The re-probe reading rows through `reads`, asking `resolver` for each root's repository and
    /// sending each change through `events`; canceling `stop` ends every pass and every send.
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        events: Arc<WorkspaceEventEmitter>,
        resolver: RepoRootResolver,
        stop: CancellationToken,
    ) -> Self {
        Self {
            reads,
            events,
            resolver,
            stop,
            passes: KeyedLock::new(),
            pass_requests: AtomicU64::new(0),
            mounts: Mutex::new(HashMap::new()),
        }
    }

    /// Probes every attached mount at the service's start; a mount whose probe runs out of time
    /// reads `unreachable`. Fails as [`reprobe`](Self::reprobe) does.
    pub(crate) async fn start_probe(&self) -> Result<(), ReprobeError> {
        let mounts = self.read_attached_mounts().await?;
        self.probe_each(
            mounts.into_iter().map(|mount| mount.id).collect(),
            ProbeTimeoutReading::Unreachable,
        )
        .await
    }

    /// Re-probes every attached mount, forgetting what it kept of mounts no longer attached.
    /// Fails with [`ReprobeError::Read`] when the attached mounts cannot be read, and with
    /// [`ReprobeError::Passes`] once every pass has ended when any mount's pass failed, a send
    /// that did not reach a session among them.
    pub(crate) async fn reprobe(&self) -> Result<(), ReprobeError> {
        let mounts = self.read_attached_mounts().await?;
        let attached: HashSet<RepoMountId> = mounts.iter().map(|mount| mount.id).collect();
        self.lock_mounts()
            .retain(|repo_mount_id, _| attached.contains(repo_mount_id));
        self.probe_each(
            attached.into_iter().collect(),
            ProbeTimeoutReading::NoVerdict,
        )
        .await
    }

    /// Re-probes only the attached mounts whose root, or a checkout a live workspace on it works
    /// in, holds `folder`, an absolute path with each link resolved, as the stored roots are.
    /// Fails as [`reprobe`](Self::reprobe) does.
    pub(crate) async fn reprobe_mounts_containing(
        &self,
        folder: &Path,
    ) -> Result<(), ReprobeError> {
        let (mounts, checkouts) = self
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, MountHealthReadError>((
                    read_attached_mounts(connection)?,
                    read_mount_checkouts(connection)?,
                ))
            })
            .await?;
        let mut repo_mount_ids: Vec<RepoMountId> = mounts
            .into_iter()
            .filter(|mount| is_contained_within(folder, &mount.canonical_root))
            .map(|mount| mount.id)
            .chain(
                checkouts
                    .into_iter()
                    .filter(|(_, checkout_root)| is_contained_within(folder, checkout_root))
                    .map(|(repo_mount_id, _)| repo_mount_id),
            )
            .collect();
        repo_mount_ids.sort_unstable();
        repo_mount_ids.dedup();
        self.probe_each(repo_mount_ids, ProbeTimeoutReading::NoVerdict)
            .await
    }

    async fn probe_each(
        &self,
        repo_mount_ids: Vec<RepoMountId>,
        on_timeout: ProbeTimeoutReading,
    ) -> Result<(), ReprobeError> {
        map_with_processor_bound(
            repo_mount_ids,
            "re-probing the health of repo mounts",
            |repo_mount_id| self.request_pass(repo_mount_id, on_timeout),
        )
        .await?;
        Ok(())
    }

    // Runs one pass of the mount once the passes before it end, or answers with the pass that
    // started after this request while it waited.
    async fn request_pass(
        &self,
        repo_mount_id: RepoMountId,
        on_timeout: ProbeTimeoutReading,
    ) -> Result<(), Arc<MountPassFailure>> {
        let request = self.pass_requests.fetch_add(1, Ordering::SeqCst);
        let hold = tokio::select! {
            biased;
            () = self.stop.cancelled() => return Ok(()),
            hold = self.passes.acquire(repo_mount_id) => hold,
        };
        {
            let mut mounts = self.lock_mounts();
            let memory = mounts.entry(repo_mount_id).or_default();
            if memory.served_below > request {
                return memory.last_failure.clone().map_or(Ok(()), Err);
            }
            // Every request numbered so far is served by this pass, which starts after each.
            memory.served_below = self.pass_requests.load(Ordering::SeqCst);
        }
        let outcome = self.run_pass(&hold, on_timeout).await.map_err(Arc::new);
        if let Some(memory) = self.lock_mounts().get_mut(&repo_mount_id) {
            memory.last_failure = outcome.as_ref().err().cloned();
        }
        outcome
    }

    // One pass of the held mount: probe, then tell each session on it whose verdict differs.
    async fn run_pass(
        &self,
        hold: &KeyHold<'_, RepoMountId>,
        on_timeout: ProbeTimeoutReading,
    ) -> Result<(), MountPassFailure> {
        let repo_mount_id = *hold.key();
        if self.stop.is_cancelled() {
            return Ok(());
        }
        let read_failure = |source: MountHealthReadError| MountPassFailure::Read {
            repo_mount_id,
            source,
        };
        let Some(mount) = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_attached_mount(connection, repo_mount_id)
            })
            .await
            .map_err(read_failure)?
        else {
            self.lock_mounts().remove(&repo_mount_id);
            return Ok(());
        };
        let Some(health) = self.probe_within_bound(&mount, on_timeout).await? else {
            return Ok(());
        };
        let verdict = MountVerdict::of(&health);

        let sessions = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_sessions_on_mount(connection, repo_mount_id)
            })
            .await
            .map_err(read_failure)?;
        let unheard: Vec<SessionId> = {
            let mut mounts = self.lock_mounts();
            let memory = mounts.entry(repo_mount_id).or_default();
            memory
                .heard
                .retain(|session_id, _| sessions.contains(session_id));
            sessions
                .iter()
                .filter(|session_id| !memory.heard.contains_key(*session_id))
                .copied()
                .collect()
        };
        if !unheard.is_empty() {
            let logged = self
                .reads
                .read(ReadLength::Short, move |connection| {
                    read_logged_verdicts(connection, repo_mount_id, &unheard)
                })
                .await
                .map_err(read_failure)?;
            if let Some(memory) = self.lock_mounts().get_mut(&repo_mount_id) {
                memory.heard.extend(logged);
            }
        }

        let mut sends = Vec::new();
        for session_id in sessions {
            // Cut short by the stop, the sessions not yet told keep the verdict they heard.
            if self.stop.is_cancelled() {
                break;
            }
            let heard = self
                .lock_mounts()
                .get(&repo_mount_id)
                .and_then(|memory| memory.heard.get(&session_id).copied())
                .unwrap_or(MountVerdict::ASSUMED);
            if heard == verdict {
                continue;
            }
            let sent = self
                .events
                .emit_mount_health_changed(
                    session_id,
                    repo_mount_id,
                    health.clone(),
                    SessionEventLinkage::default(),
                )
                .await;
            match sent {
                Ok(_receipt) => {
                    if let Some(memory) = self.lock_mounts().get_mut(&repo_mount_id) {
                        memory.heard.insert(session_id, verdict);
                    }
                    sends.push(Ok(()));
                }
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        %repo_mount_id,
                        %session_id,
                        "a repo mount's health change did not reach a session; the next pass \
                         sends it again"
                    );
                    sends.push(Err(error));
                }
            }
        }
        settle_all(sends, "sending a repo mount's health change")
            .map(|_sent| ())
            .map_err(|source| MountPassFailure::Send {
                repo_mount_id,
                source,
            })
    }

    // The mount's health, waiting on its probe for the git runner's bound; `None` when there is no
    // verdict: git could not answer, the stop came, or a re-probe's probe ran out of time.
    async fn probe_within_bound(
        &self,
        mount: &AttachedMount,
        on_timeout: ProbeTimeoutReading,
    ) -> Result<Option<RepoMountHealth>, MountPassFailure> {
        let repo_mount_id = mount.id;
        let mut probe = self.take_or_start_probe(mount);
        let probed = wait_within(Pin::new(&mut probe), GIT_COMMAND_TIMEOUT, Some(&self.stop)).await;
        let Some(probed) = probed else {
            // Still running; the next pass waits on it instead of starting another.
            if let Some(memory) = self.lock_mounts().get_mut(&repo_mount_id) {
                memory.probe_in_flight = Some(probe);
            }
            return self.read_timed_out_probe(mount, on_timeout);
        };
        match probed {
            Ok(Ok(health)) => Ok(Some(health)),
            Ok(Err(MountHealthProbeError::GitUnanswered(refusal))) => {
                tracing::warn!(
                    error = &refusal as &(dyn Error + 'static),
                    %repo_mount_id,
                    "a repo mount's health probe got no answer from git; its verdict is unchanged"
                );
                Ok(None)
            }
            Ok(Err(MountHealthProbeError::Projection(source))) => {
                Err(MountPassFailure::Projection {
                    repo_mount_id,
                    source,
                })
            }
            Err(source) => Err(MountPassFailure::ProbeTask {
                repo_mount_id,
                source,
            }),
        }
    }

    // What a probe that did not answer within the bound reads as, `None` once the stop came.
    fn read_timed_out_probe(
        &self,
        mount: &AttachedMount,
        on_timeout: ProbeTimeoutReading,
    ) -> Result<Option<RepoMountHealth>, MountPassFailure> {
        let repo_mount_id = mount.id;
        if self.stop.is_cancelled() {
            return Ok(None);
        }
        match on_timeout {
            ProbeTimeoutReading::NoVerdict => {
                tracing::warn!(
                    %repo_mount_id,
                    bound = ?GIT_COMMAND_TIMEOUT,
                    "a repo mount's health probe got no answer within its bound; its verdict is \
                     unchanged"
                );
                Ok(None)
            }
            ProbeTimeoutReading::Unreachable => {
                tracing::warn!(
                    %repo_mount_id,
                    bound = ?GIT_COMMAND_TIMEOUT,
                    "a repo mount's health probe at start got no answer within its bound; it reads \
                     unreachable"
                );
                let unanswered = FilesystemPathProbe {
                    probed_path: mount.canonical_root.clone(),
                    probed_place: mount.place.clone(),
                    is_reachable: false,
                    checked_at: WireInstant::now(),
                };
                compute_repo_mount_health(&mount.health_row(), &unanswered, None)
                    .map(Some)
                    .map_err(|source| MountPassFailure::Projection {
                        repo_mount_id,
                        source,
                    })
            }
        }
    }

    // The mount's probe still running from an earlier pass, or a new one; a probe that finished
    // unwatched is no answer for this pass.
    fn take_or_start_probe(&self, mount: &AttachedMount) -> ProbeTask {
        let in_flight = self
            .lock_mounts()
            .get_mut(&mount.id)
            .and_then(|memory| memory.probe_in_flight.take())
            .filter(|probe| !probe.is_finished());
        in_flight.unwrap_or_else(|| {
            let resolver = self.resolver.clone();
            let mount = mount.clone();
            tokio::spawn(
                async move { probe_repo_mount_health(&resolver, &mount.health_row()).await },
            )
        })
    }

    async fn read_attached_mounts(&self) -> Result<Vec<AttachedMount>, MountHealthReadError> {
        self.reads
            .read(ReadLength::Short, read_attached_mounts)
            .await
    }

    fn lock_mounts(&self) -> MutexGuard<'_, HashMap<RepoMountId, MountMemory>> {
        // Each critical section leaves the map whole, so a panicking holder breaks nothing.
        lock(&self.mounts)
    }
}

fn attached_mount_of(row: &Row<'_>) -> rusqlite::Result<AttachedMount> {
    Ok(AttachedMount {
        id: text_column(row, 0, |text| RepoMountId::new(&text))?,
        canonical_root: PathBuf::from(row.get::<_, String>(1)?),
        place: optional_text_column(row, 2, |text| {
            serde_json::from_str::<Place>(&text).map_err(StoredJsonFault::from)
        })?,
        common_dir_anchor: row.get::<_, Option<String>>(3)?.map(PathBuf::from),
    })
}

fn read_attached_mounts(
    connection: &Connection,
) -> Result<Vec<AttachedMount>, MountHealthReadError> {
    Ok(connection
        .prepare_cached(&SELECT_ATTACHED_MOUNTS_SQL)?
        .query_map([], attached_mount_of)?
        .collect::<rusqlite::Result<_>>()?)
}

fn read_attached_mount(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Option<AttachedMount>, MountHealthReadError> {
    Ok(connection
        .prepare_cached(&SELECT_ATTACHED_MOUNT_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            attached_mount_of,
        )
        .optional()?)
}

fn read_mount_checkouts(
    connection: &Connection,
) -> Result<Vec<(RepoMountId, PathBuf)>, MountHealthReadError> {
    Ok(connection
        .prepare_cached(&SELECT_MOUNT_CHECKOUTS_SQL)?
        .query_map([], |row| {
            Ok((
                text_column(row, 0, |text| RepoMountId::new(&text))?,
                PathBuf::from(row.get::<_, String>(1)?),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn read_sessions_on_mount(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Vec<SessionId>, MountHealthReadError> {
    Ok(connection
        .prepare_cached(&SELECT_SESSIONS_ON_MOUNT_SQL)?
        .query_map(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| text_column(row, 0, |text| SessionId::new(&text)),
        )?
        .collect::<rusqlite::Result<_>>()?)
}

// The verdict each of `sessions` last read in its log for the mount, `healthy` where it read none.
fn read_logged_verdicts(
    connection: &Connection,
    repo_mount_id: RepoMountId,
    sessions: &[SessionId],
) -> Result<Vec<(SessionId, MountVerdict)>, MountHealthReadError> {
    let mut statement = connection.prepare_cached(&SELECT_LAST_LOGGED_HEALTH_SQL)?;
    let repo_mount_id = repo_mount_id.text();
    sessions
        .iter()
        .map(|session_id| {
            let logged = statement
                .query_row(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@repo_mount_id": repo_mount_id.as_str(),
                    },
                    |row| {
                        text_column(row, 0, |text| {
                            serde_json::from_str::<RepoMountHealth>(&text)
                                .map_err(StoredJsonFault::from)
                        })
                    },
                )
                .optional()?;
            Ok((
                *session_id,
                logged
                    .as_ref()
                    .map_or(MountVerdict::ASSUMED, MountVerdict::of),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests;
