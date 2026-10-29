//! A run's execution posture from its request to its `agent.run.running` stamp, the posture each
//! level runs at, and the one curated credential deny list every provider process is handed. The
//! posture is checked and its writable roots resolved before the provider starts the run; a posture
//! that fails a check refuses the run and is never rewritten into one that passes. A session whose
//! level moves carries its live runs, and every run of it whose gate passes after the move, to the
//! moved posture, and a run of a session whose level was stored since the daemon started gates at
//! the stored level.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, Weak};

use futures::future::{BoxFuture, try_join_all};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::{CredentialPolicyRef, ExecutionPosture};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_workspace::run_setup_gates::{
    RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext,
};
use tokio::sync::{SetOnce, SetOnceError};

/// The reference every run's posture carries; it names the daemon's one curated credential list.
pub const CURATED_CREDENTIAL_POLICY_REF: &str = "curated-credentials";

/// The credential variables removed from every provider process's environment and from every
/// provider conversation's command environment, compared under the host's environment-name rule.
pub(crate) const CURATED_CREDENTIAL_ENV_VARS: &[&str] = &["GITHUB_TOKEN", "NPM_TOKEN"];

/// The posture a session's process runs at at `level` in the repository whose git folder, the
/// common one for a linked worktree, is `git_folder`: at Sandboxed that folder is writable, its
/// `hooks` and `config` aside, so a commit from a linked worktree lands; no other level names a
/// writable root.
pub fn compose_execution_posture(
    level: PermissionLevel,
    git_folder: FilesystemPath,
) -> ExecutionPosture {
    compose_folderless_posture(level).unwrap_or_else(|| ExecutionPosture::Sandboxed {
        credential_policy_ref: curated_policy_ref(),
        writable_roots: vec![git_folder],
    })
}

/// The posture a session's process runs at at `level` where that posture names no folder; `None`
/// at Sandboxed, whose posture [`compose_execution_posture`] builds on the repository's git folder.
pub fn compose_folderless_posture(level: PermissionLevel) -> Option<ExecutionPosture> {
    let credential_policy_ref = curated_policy_ref();
    match level {
        PermissionLevel::Readonly => Some(ExecutionPosture::Readonly {
            credential_policy_ref,
            writable_roots: no_writable_roots(),
        }),
        PermissionLevel::Ask => Some(ExecutionPosture::Ask {
            credential_policy_ref,
            writable_roots: Vec::new(),
        }),
        PermissionLevel::Reviewed => Some(ExecutionPosture::Reviewed {
            credential_policy_ref,
            writable_roots: Vec::new(),
        }),
        PermissionLevel::Sandboxed => None,
        PermissionLevel::Yolo => Some(ExecutionPosture::Yolo {
            credential_policy_ref,
            writable_roots: no_writable_roots(),
        }),
    }
}

/// Whether a denied path is a folder, covering everything under it, or one file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CredentialDenyPathKind {
    /// A folder and everything under it.
    Folder,
    /// One file.
    File,
}

/// One path the curated list denies, absolute.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CredentialDenyPath {
    /// The path: canonical where it exists, its expanded absolute form where it is missing.
    pub(crate) path: PathBuf,
    /// Whether it is a folder or a file.
    pub(crate) kind: CredentialDenyPathKind,
}

/// The curated list as it resolves on this machine. Each driver hands `deny_paths` to its provider
/// in the provider's own form; the spawn-environment builder strips `deny_env_vars` itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedCredentialPolicy {
    /// The list's reference, the curated one.
    pub(crate) credential_policy_ref: CredentialPolicyRef,
    /// Canonical absolute paths, symlinks resolved where the path exists; a path missing on this
    /// machine keeps its expanded absolute form.
    pub(crate) deny_paths: Vec<CredentialDenyPath>,
    /// The variables removed from every provider process's environment.
    pub(crate) deny_env_vars: &'static [&'static str],
}

/// Why a posture was refused; the run or the level move it belongs to is refused, never carried on
/// a rewrite.
#[derive(Debug, thiserror::Error)]
pub enum ExecutionPostureRejection {
    /// The posture names a credential list other than the daemon's curated one.
    #[error(
        "the posture names credential policy '{credential_policy_ref}', which is not the daemon's \
         curated list '{CURATED_CREDENTIAL_POLICY_REF}'"
    )]
    UnknownCredentialPolicy {
        /// The reference it named.
        credential_policy_ref: String,
    },
    /// A writable root is not an absolute path.
    #[error("the writable root '{}' is not an absolute path", .root.as_str())]
    RelativeWritableRoot {
        /// The root.
        root: FilesystemPath,
    },
    /// A writable root did not resolve to a canonical path a posture can carry.
    #[error("the writable root '{}' could not be resolved", .root.as_str())]
    UnresolvableWritableRoot {
        /// The root.
        root: FilesystemPath,
        /// Why it did not resolve.
        #[source]
        cause: io::Error,
    },
    /// The folder the posture of Sandboxed is built on is unavailable: the session names none to
    /// work in yet, or git refuses the one it names.
    #[error("the run's folder is unavailable")]
    UnavailableFolder(#[source] Box<dyn Error + Send + Sync>),
}

/// Why the curated credential list could not be resolved.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CredentialPolicyResolveError {
    /// The reference names a list other than the curated one.
    #[error(transparent)]
    Rejected(#[from] ExecutionPostureRejection),
    /// A denied path that exists, or may, could not be read.
    #[error("the denied path '{}' could not be resolved", .path.display())]
    DenyPath {
        /// The path, expanded.
        path: PathBuf,
        /// Why it did not resolve.
        #[source]
        cause: io::Error,
    },
}

/// Checks and resolves every run's posture as a run setup gate, keeps the resolved posture for the
/// run's `agent.run.running` stamp until the run ends, follows a session's level move onto its
/// runs, and resolves the curated credential list.
pub struct ExecutionPostureService {
    // The curated list's entries, each path expanded against the home folder.
    deny_entries: [CredentialDenyPath; 3],
    // The runs' and the moved sessions' postures, under one lock so a move and a gate's insert
    // never interleave.
    postures: Mutex<ResolvedPostures>,
    // Where a session's stored level is read; held weakly, since its owner holds this service.
    stored_postures: SetOnce<Weak<dyn StoredSessionPosture>>,
}

// Whole entries only, so a panic elsewhere leaves nothing half written.
#[derive(Default)]
struct ResolvedPostures {
    // One entry per run past its gate and not yet ended.
    by_run: HashMap<RunId, LiveRunPosture>,
    // One entry per session whose level moved while its process ran, until that process is gone
    // or the session closes.
    moved_by_session: HashMap<SessionId, ExecutionPosture>,
    // How many times each session's level was stored since the daemon started, until the session
    // closes or is purged: a run of such a session gates at its stored level, which its admission
    // may have read before the store, and a gate that read the stored level before a store reads
    // it again. A session absent here gates at the posture its run was requested at.
    stores_by_session: HashMap<SessionId, u64>,
}

/// How many times a run's gate reads its session's posture before it gives up on a level that
/// moves or is stored during each of its reads.
const GATE_ROUNDS: usize = 3;

/// Why a run's gate could not settle the run's posture, a posture's own rejection aside.
#[derive(Debug, thiserror::Error)]
enum PostureGateError {
    /// The sessions' stored levels cannot be read: no source of them was handed to the service, or
    /// the one handed is gone, as while the daemon stops.
    #[error("the sessions' stored levels cannot be read")]
    StoredLevelsUnreadable,
    /// The session's level moved or was stored during each of the gate's rounds; the text is the
    /// failed run's message, which the person reads.
    #[error("the session's level kept changing while this run started")]
    Unsettled,
}

/// What a session's stored level runs at, which the run gate reads for a session holding no moved
/// posture, so a level stored while no process of the session ran is the one its runs gate at.
pub trait StoredSessionPosture: Send + Sync {
    /// The posture the session's stored level runs at, `None` where the stored level is
    /// `requested`'s. Fails as the level's read or the read of the folder its posture is built on
    /// fails.
    fn stored_posture<'a>(
        &'a self,
        session_id: SessionId,
        requested: &'a ExecutionPosture,
    ) -> BoxFuture<'a, Result<Option<ExecutionPosture>, Box<dyn Error + Send + Sync>>>;
}

struct LiveRunPosture {
    session_id: SessionId,
    posture: ExecutionPosture,
}

impl ExecutionPostureService {
    /// A service whose curated folders sit under `home`, the person's home folder, and whose
    /// curated file is `session_token_path`, the daemon's absolute session token file: whoever
    /// reads it is admitted on the daemon's socket, so no agent's command may.
    pub fn new(home: &Path, session_token_path: PathBuf) -> Self {
        Self {
            deny_entries: [
                CredentialDenyPath {
                    path: home.join(".ssh"),
                    kind: CredentialDenyPathKind::Folder,
                },
                CredentialDenyPath {
                    path: home.join(".aws"),
                    kind: CredentialDenyPathKind::Folder,
                },
                CredentialDenyPath {
                    path: session_token_path,
                    kind: CredentialDenyPathKind::File,
                },
            ],
            postures: Mutex::default(),
            stored_postures: SetOnce::new(),
        }
    }

    /// Hands the service where a session's stored level is read. Fails once a source is set.
    pub fn set_stored_postures(
        &self,
        source: Weak<dyn StoredSessionPosture>,
    ) -> Result<(), SetOnceError<Weak<dyn StoredSessionPosture>>> {
        self.stored_postures.set(source)
    }

    /// The curated list `credential_policy_ref` names, resolved now so a moved symlink is followed.
    /// Fails with [`CredentialPolicyResolveError::Rejected`] for any other reference, and with
    /// [`CredentialPolicyResolveError::DenyPath`] for a path read that fails for any reason but the
    /// path being absent.
    pub(crate) async fn resolve_credential_policy(
        &self,
        credential_policy_ref: &str,
    ) -> Result<ResolvedCredentialPolicy, CredentialPolicyResolveError> {
        require_curated_policy_ref(credential_policy_ref)?;
        let deny_paths = try_join_all(self.deny_entries.iter().map(canonical_deny_path)).await?;
        Ok(ResolvedCredentialPolicy {
            credential_policy_ref: curated_policy_ref(),
            deny_paths,
            deny_env_vars: CURATED_CREDENTIAL_ENV_VARS,
        })
    }

    /// The complete resolved posture of a run past its gate and not yet ended, `None` for any other
    /// run; the run engine hands it to the driver and stamps it on `agent.run.running`, and a start
    /// that finds `None` ends its run `failed`.
    pub fn resolved_posture_for(&self, run_id: &RunId) -> Option<ExecutionPosture> {
        self.postures()
            .by_run
            .get(run_id)
            .map(|live| live.posture.clone())
    }

    /// Moves `session_id`, whose moved level is stored already, to `resolved`, a posture
    /// [`resolve_posture`] already resolved: every live run of the session runs at it from now, and
    /// every run of the session whose gate passes before its process is gone runs at it as that
    /// gate resolves it again, whatever posture the run was requested at.
    pub fn move_session(&self, session_id: &SessionId, resolved: ExecutionPosture) {
        let mut postures = self.postures();
        for live in postures.by_run.values_mut() {
            if live.session_id == *session_id {
                live.posture = resolved.clone();
            }
        }
        postures.moved_by_session.insert(*session_id, resolved);
        *postures.stores_by_session.entry(*session_id).or_default() += 1;
    }

    /// Notes that the session's level was stored while no process of it ran: its moved posture is
    /// dropped, its runs gate at the stored level from now, and a gate of its that read the stored
    /// level before this store reads it again.
    pub fn note_level_stored(&self, session_id: &SessionId) {
        let mut postures = self.postures();
        postures.moved_by_session.remove(session_id);
        *postures.stores_by_session.entry(*session_id).or_default() += 1;
    }

    /// Drops the moved posture of a session whose process is gone; its runs gate at its stored
    /// level, which its next process opens at.
    pub fn forget_moved_posture(&self, session_id: &SessionId) {
        self.postures().moved_by_session.remove(session_id);
    }

    /// Drops everything kept for a session that closed or was purged, which takes no run after.
    pub fn forget_session(&self, session_id: &SessionId) {
        let mut postures = self.postures();
        postures.moved_by_session.remove(session_id);
        postures.stores_by_session.remove(session_id);
    }

    // The posture the session's stored level runs at for `context`'s run where it is not the one
    // the run was requested at; `None` where it is. Fails where no source was set or it is gone.
    async fn stored_posture(
        &self,
        context: &RunSetupContext,
    ) -> Result<Option<ExecutionPosture>, RunSetupGateError> {
        let source = self
            .stored_postures
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| {
                RunSetupGateError::Failed(Box::new(PostureGateError::StoredLevelsUnreadable))
            })?;
        source
            .stored_posture(context.session_id, &context.execution_posture)
            .await
            .map_err(RunSetupGateError::Failed)
    }

    fn postures(&self) -> MutexGuard<'_, ResolvedPostures> {
        lock(&self.postures)
    }
}

impl RunSetupGate for ExecutionPostureService {
    /// Resolves the session's moved posture where the session's level moved, else, for a session
    /// whose level was stored since the daemon started, the posture its stored level runs at, else
    /// the one the run was requested with, and keeps it for `resolved_posture_for`; a rejection
    /// fails the gate, which ends the run `failed` before its provider starts it, and so do a
    /// failed read of the stored level and a level that moves during each of the gate's
    /// [`GATE_ROUNDS`] reads.
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            for _ in 0..GATE_ROUNDS {
                let (moved, stores) = {
                    let postures = self.postures();
                    (
                        postures.moved_by_session.get(&context.session_id).cloned(),
                        postures.stores_by_session.get(&context.session_id).copied(),
                    )
                };
                // A session whose level was not stored since the daemon started runs at the level
                // its run's admission read, so that level is not read again.
                let stored = match (&moved, stores) {
                    (Some(_), _) | (None, None) => None,
                    (None, Some(_)) => self.stored_posture(context).await?,
                };
                let target = moved
                    .as_ref()
                    .or(stored.as_ref())
                    .unwrap_or(&context.execution_posture);
                let resolved = resolve_posture(target)
                    .await
                    .map_err(|rejection| RunSetupGateError::Failed(Box::new(rejection)))?;
                // Read again under the insert's lock: a move, a forget or a stored level that
                // landed while the roots resolved is resolved in its turn.
                let mut postures = self.postures();
                if postures.moved_by_session.get(&context.session_id) != moved.as_ref()
                    || postures.stores_by_session.get(&context.session_id).copied() != stores
                {
                    continue;
                }
                postures.by_run.insert(
                    context.run_id,
                    LiveRunPosture {
                        session_id: context.session_id,
                        posture: resolved,
                    },
                );
                return Ok(());
            }
            Err(RunSetupGateError::Failed(Box::new(
                PostureGateError::Unsettled,
            )))
        })
    }

    /// Forgets the run's resolved posture once the run has ended.
    fn on_run_terminal<'a>(
        &'a self,
        context: &'a RunTerminalContext,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        self.postures().by_run.remove(&context.run_id);
        Box::pin(std::future::ready(Ok(())))
    }
}

/// The posture with every writable root resolved to its canonical path, as a run's gate and a
/// session's level move resolve it; a reference to any list but the curated one, or a root that is
/// relative or does not resolve, is refused. A read-only or YOLO posture carries no roots by its
/// type.
pub async fn resolve_posture(
    posture: &ExecutionPosture,
) -> Result<ExecutionPosture, ExecutionPostureRejection> {
    require_curated_policy_ref(posture.credential_policy_ref().as_str())?;
    Ok(match posture {
        ExecutionPosture::Readonly { .. } | ExecutionPosture::Yolo { .. } => posture.clone(),
        ExecutionPosture::Ask {
            credential_policy_ref,
            writable_roots,
        } => ExecutionPosture::Ask {
            credential_policy_ref: credential_policy_ref.clone(),
            writable_roots: canonical_writable_roots(writable_roots).await?,
        },
        ExecutionPosture::Reviewed {
            credential_policy_ref,
            writable_roots,
        } => ExecutionPosture::Reviewed {
            credential_policy_ref: credential_policy_ref.clone(),
            writable_roots: canonical_writable_roots(writable_roots).await?,
        },
        ExecutionPosture::Sandboxed {
            credential_policy_ref,
            writable_roots,
        } => ExecutionPosture::Sandboxed {
            credential_policy_ref: credential_policy_ref.clone(),
            writable_roots: canonical_writable_roots(writable_roots).await?,
        },
    })
}

fn require_curated_policy_ref(
    credential_policy_ref: &str,
) -> Result<(), ExecutionPostureRejection> {
    if credential_policy_ref == CURATED_CREDENTIAL_POLICY_REF {
        Ok(())
    } else {
        Err(ExecutionPostureRejection::UnknownCredentialPolicy {
            credential_policy_ref: credential_policy_ref.to_owned(),
        })
    }
}

fn curated_policy_ref() -> CredentialPolicyRef {
    CredentialPolicyRef::new(CURATED_CREDENTIAL_POLICY_REF.to_owned())
        .expect("the curated list's short name is within a reference's cap")
}

fn no_writable_roots() -> BoundedVec<FilesystemPath, 0, 0> {
    BoundedVec::new(Vec::new()).expect("an empty list holds no roots")
}

async fn canonical_writable_roots(
    roots: &[FilesystemPath],
) -> Result<Vec<FilesystemPath>, ExecutionPostureRejection> {
    try_join_all(roots.iter().map(canonical_writable_root)).await
}

// A root is absolute by its own syntax: on Windows that takes a drive or a share, so `\repos`
// reads relative. The canonical path goes on the wire as its lossy text, which must fit a path's
// cap there.
async fn canonical_writable_root(
    root: &FilesystemPath,
) -> Result<FilesystemPath, ExecutionPostureRejection> {
    let path = Path::new(root.as_str());
    if !path.is_absolute() {
        return Err(ExecutionPostureRejection::RelativeWritableRoot { root: root.clone() });
    }
    let unresolvable = |cause: io::Error| ExecutionPostureRejection::UnresolvableWritableRoot {
        root: root.clone(),
        cause,
    };
    let resolved = resolve_real_path(path).await.map_err(unresolvable)?;
    FilesystemPath::new(resolved.to_string_lossy().into_owned())
        .map_err(|refusal| unresolvable(io::Error::other(refusal)))
}

async fn canonical_deny_path(
    entry: &CredentialDenyPath,
) -> Result<CredentialDenyPath, CredentialPolicyResolveError> {
    let path = match resolve_real_path(&entry.path).await {
        Ok(path) => path,
        // An absent path has no link to follow; it is still denied should it appear later.
        Err(cause) if cause.kind() == io::ErrorKind::NotFound => entry.path.clone(),
        Err(cause) => {
            return Err(CredentialPolicyResolveError::DenyPath {
                path: entry.path.clone(),
                cause,
            });
        }
    };
    Ok(CredentialDenyPath {
        path,
        kind: entry.kind,
    })
}

#[cfg(test)]
mod tests;
