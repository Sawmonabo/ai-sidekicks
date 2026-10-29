//! A run's execution posture from its request to its `agent.run.running` stamp, the posture each
//! level runs at, and the one curated credential deny list every provider process is handed. The
//! posture is checked and its writable roots resolved before the provider starts the run; a posture
//! that fails a check refuses the run and is never rewritten into one that passes. A session whose
//! level moves carries its live runs, and every run of it whose gate passes after the move, to the
//! moved posture.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

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
    let credential_policy_ref = curated_policy_ref();
    match level {
        PermissionLevel::Readonly => ExecutionPosture::Readonly {
            credential_policy_ref,
            writable_roots: no_writable_roots(),
        },
        PermissionLevel::Ask => ExecutionPosture::Ask {
            credential_policy_ref,
            writable_roots: Vec::new(),
        },
        PermissionLevel::Reviewed => ExecutionPosture::Reviewed {
            credential_policy_ref,
            writable_roots: Vec::new(),
        },
        PermissionLevel::Sandboxed => ExecutionPosture::Sandboxed {
            credential_policy_ref,
            writable_roots: vec![git_folder],
        },
        PermissionLevel::Yolo => ExecutionPosture::Yolo {
            credential_policy_ref,
            writable_roots: no_writable_roots(),
        },
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
}

// Whole entries only, so a panic elsewhere leaves nothing half written.
#[derive(Default)]
struct ResolvedPostures {
    // One entry per run past its gate and not yet ended.
    by_run: HashMap<RunId, LiveRunPosture>,
    // One entry per session whose level moved while it was open, until the session is forgotten.
    moved_by_session: HashMap<SessionId, ExecutionPosture>,
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
        }
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

    /// Moves `session_id` to `resolved`, a posture [`resolve_posture`] already resolved: every live
    /// run of the session runs at it from now, and every run of the session whose gate passes
    /// before [`Self::forget_session`] runs at it as that gate resolves it again, whatever posture
    /// the run was requested at.
    pub fn move_session(&self, session_id: &SessionId, resolved: ExecutionPosture) {
        let mut postures = self.postures();
        for live in postures.by_run.values_mut() {
            if live.session_id == *session_id {
                live.posture = resolved.clone();
            }
        }
        postures.moved_by_session.insert(*session_id, resolved);
    }

    /// Drops the session's moved posture once the session is no longer open, or its next process
    /// opens at the stored level; its later runs run at the posture they were requested at.
    pub fn forget_session(&self, session_id: &SessionId) {
        self.postures().moved_by_session.remove(session_id);
    }

    fn postures(&self) -> MutexGuard<'_, ResolvedPostures> {
        lock(&self.postures)
    }
}

impl RunSetupGate for ExecutionPostureService {
    /// Resolves the session's moved posture where the session's level moved, else the posture the
    /// run was requested with, and keeps it for `resolved_posture_for`; a rejection fails the gate,
    /// which ends the run `failed` before its provider starts it.
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            let mut moved = self
                .postures()
                .moved_by_session
                .get(&context.session_id)
                .cloned();
            loop {
                let resolved =
                    resolve_posture(moved.as_ref().unwrap_or(&context.execution_posture))
                        .await
                        .map_err(|rejection| RunSetupGateError::Failed(Box::new(rejection)))?;
                // Read again under the insert's lock: a move or a forget that landed while the
                // roots resolved is resolved in its turn.
                let mut postures = self.postures();
                let moved_now = postures.moved_by_session.get(&context.session_id);
                if moved_now != moved.as_ref() {
                    moved = moved_now.cloned();
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
mod tests {
    use std::pin::pin;

    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_platforms::real_path;
    use sidekicks_std::file::bounded_read::hold_reads_of;

    use super::*;

    fn filesystem_path(path: &Path) -> FilesystemPath {
        FilesystemPath::new(path.to_string_lossy().into_owned()).expect("a test path is valid")
    }

    fn ask_posture(credential_policy_ref: &str, root: FilesystemPath) -> ExecutionPosture {
        ExecutionPosture::Ask {
            credential_policy_ref: CredentialPolicyRef::new(credential_policy_ref.to_owned())
                .expect("a short name is a valid reference"),
            writable_roots: vec![root],
        }
    }

    #[tokio::test]
    async fn a_relative_or_missing_root_is_refused() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let relative = FilesystemPath::new("repos/app".to_owned()).expect("a valid path");
        let missing = filesystem_path(&folder.path().join("missing"));

        let relative_refusal =
            resolve_posture(&ask_posture(CURATED_CREDENTIAL_POLICY_REF, relative))
                .await
                .expect_err("a relative root is refused");
        let missing_refusal = resolve_posture(&ask_posture(CURATED_CREDENTIAL_POLICY_REF, missing))
            .await
            .expect_err("a missing root is refused");

        assert!(matches!(
            relative_refusal,
            ExecutionPostureRejection::RelativeWritableRoot { .. }
        ));
        let ExecutionPostureRejection::UnresolvableWritableRoot { cause, .. } = missing_refusal
        else {
            panic!("a missing root reads unresolvable");
        };
        assert_eq!(cause.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn a_root_resolves_to_its_canonical_path() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        std::fs::create_dir(folder.path().join("sub")).expect("the subfolder is made");
        let root = filesystem_path(&folder.path().join("sub").join(".."));

        let resolved = resolve_posture(&ask_posture(CURATED_CREDENTIAL_POLICY_REF, root))
            .await
            .expect("an existing root resolves");

        let canonical = real_path(folder.path()).expect("the scratch folder resolves");
        assert_eq!(resolved.writable_roots(), [filesystem_path(&canonical)]);
    }

    #[tokio::test]
    async fn an_absent_deny_path_keeps_its_expanded_form() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        std::fs::create_dir(scratch.path().join("sub")).expect("the subfolder is made");
        std::fs::create_dir(scratch.path().join(".ssh")).expect("the folder is made");
        // Through `sub/..`, a deny path left unresolved differs from its resolved form everywhere.
        let home = scratch.path().join("sub").join("..");
        let token_path = home.join("run").join("daemon.token");
        let service = ExecutionPostureService::new(&home, token_path.clone());

        let policy = service
            .resolve_credential_policy(CURATED_CREDENTIAL_POLICY_REF)
            .await
            .expect("the curated list resolves");

        let canonical = real_path(scratch.path()).expect("the scratch folder resolves");
        assert_eq!(
            policy.deny_paths,
            [
                CredentialDenyPath {
                    path: canonical.join(".ssh"),
                    kind: CredentialDenyPathKind::Folder,
                },
                CredentialDenyPath {
                    path: home.join(".aws"),
                    kind: CredentialDenyPathKind::Folder,
                },
                CredentialDenyPath {
                    path: token_path,
                    kind: CredentialDenyPathKind::File,
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_reference_to_another_list_is_refused() {
        let home = tempfile::tempdir().expect("a scratch home");
        let service = ExecutionPostureService::new(home.path(), home.path().join("daemon.token"));
        let root = filesystem_path(home.path());

        let posture_refusal = resolve_posture(&ask_posture("other-credentials", root))
            .await
            .expect_err("another list is refused");
        let policy_refusal = service
            .resolve_credential_policy("other-credentials")
            .await
            .expect_err("another list is refused");

        assert!(matches!(
            posture_refusal,
            ExecutionPostureRejection::UnknownCredentialPolicy { .. }
        ));
        assert!(matches!(
            policy_refusal,
            CredentialPolicyResolveError::Rejected(
                ExecutionPostureRejection::UnknownCredentialPolicy { .. }
            )
        ));
    }

    fn session_id() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
    }

    fn run_context(session_id: SessionId, execution_posture: ExecutionPosture) -> RunSetupContext {
        RunSetupContext {
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            session_id,
            queue_item: None,
            workspace_id: None,
            execution_posture,
        }
    }

    fn ended(context: &RunSetupContext) -> RunTerminalContext {
        RunTerminalContext {
            run_id: context.run_id,
            session_id: context.session_id,
            terminal_state: RunState::Completed,
            run_version: 1,
        }
    }

    async fn pass_gate(service: &ExecutionPostureService, context: &RunSetupContext) {
        service
            .assert_run_ready(context)
            .await
            .expect("the run's posture resolves");
    }

    fn readonly() -> ExecutionPosture {
        compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/unused".to_owned()).expect("a valid path"),
        )
    }

    // A session's level move, resolved as the move resolves it, onto a real Sandboxed root.
    async fn moved_sandboxed(git_folder: &Path) -> ExecutionPosture {
        resolve_posture(&compose_execution_posture(
            PermissionLevel::Sandboxed,
            filesystem_path(git_folder),
        ))
        .await
        .expect("the Sandboxed root resolves")
    }

    #[tokio::test]
    async fn a_run_read_before_its_session_moved_runs_at_the_moved_posture() {
        let home = tempfile::tempdir().expect("a scratch home");
        let git_folder = home.path().join("repo.git");
        std::fs::create_dir(&git_folder).expect("the git folder is made");
        let service = ExecutionPostureService::new(home.path(), home.path().join("daemon.token"));
        let session = session_id();
        let sandboxed = moved_sandboxed(&git_folder).await;
        let yolo = compose_execution_posture(PermissionLevel::Yolo, filesystem_path(&git_folder));

        let live = run_context(session, readonly());
        pass_gate(&service, &live).await;
        service.move_session(&session, sandboxed.clone());
        assert_eq!(
            service.resolved_posture_for(&live.run_id),
            Some(sandboxed.clone())
        );

        // Admitted at the old level, its gate after the move.
        let after = run_context(session, readonly());
        pass_gate(&service, &after).await;

        // Its gate resolving the moved root, the read held on its thread, while the session moves
        // again.
        let across = run_context(session, readonly());
        let held = hold_reads_of(Path::new(sandboxed.writable_roots()[0].as_str()));
        let mut gate = pin!(service.assert_run_ready(&across));
        assert!(
            futures::poll!(gate.as_mut()).is_pending(),
            "the gate waits on the moved root's held read"
        );
        service.move_session(&session, yolo.clone());
        drop(held);
        gate.await.expect("the run's posture resolves");

        for run in [&live, &after, &across] {
            assert_eq!(
                service.resolved_posture_for(&run.run_id),
                Some(yolo.clone())
            );
        }

        // The session's runs all end; the session is still open at the moved level.
        for run in [&live, &after, &across] {
            service
                .on_run_terminal(&ended(run), None)
                .await
                .expect("the run's posture is released");
        }
        let next = run_context(session, readonly());
        pass_gate(&service, &next).await;
        assert_eq!(service.resolved_posture_for(&next.run_id), Some(yolo));

        service.forget_session(&session);
        let reopened = run_context(session, readonly());
        pass_gate(&service, &reopened).await;
        assert_eq!(
            service.resolved_posture_for(&reopened.run_id),
            Some(readonly())
        );

        // Moved to a Sandboxed root deleted since: a run requested at Read-only is refused.
        service.move_session(&session, sandboxed);
        std::fs::remove_dir(&git_folder).expect("the git folder is removed");
        let gone = run_context(session, readonly());
        service
            .assert_run_ready(&gone)
            .await
            .expect_err("the moved root is gone, so the gate refuses");
        assert_eq!(service.resolved_posture_for(&gone.run_id), None);
    }

    #[tokio::test]
    async fn a_run_of_another_session_keeps_its_own_posture() {
        let service =
            ExecutionPostureService::new(Path::new("/home"), PathBuf::from("/home/daemon.token"));
        let (moved, other) = (session_id(), session_id());
        let yolo =
            compose_execution_posture(PermissionLevel::Yolo, filesystem_path(Path::new("/")));

        let live = run_context(other, readonly());
        pass_gate(&service, &live).await;
        service.move_session(&moved, yolo);
        let after = run_context(other, readonly());
        pass_gate(&service, &after).await;

        for run in [&live, &after] {
            assert_eq!(service.resolved_posture_for(&run.run_id), Some(readonly()));
        }
    }
}
