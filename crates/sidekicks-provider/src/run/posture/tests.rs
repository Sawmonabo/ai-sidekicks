//! The posture service's checks, its level moves and its run gate.

use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::real_path;
use sidekicks_std::file::bounded_read::hold_reads_of;

use super::*;
use crate::driver::test_registry::new_session_id;

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

    let relative_refusal = resolve_posture(&ask_posture(CURATED_CREDENTIAL_POLICY_REF, relative))
        .await
        .expect_err("a relative root is refused");
    let missing_refusal = resolve_posture(&ask_posture(CURATED_CREDENTIAL_POLICY_REF, missing))
        .await
        .expect_err("a missing root is refused");

    assert!(matches!(
        relative_refusal,
        ExecutionPostureRejection::RelativeWritableRoot { .. }
    ));
    let ExecutionPostureRejection::UnresolvableWritableRoot { cause, .. } = missing_refusal else {
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
    let session = new_session_id();
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
    let (moved, other) = (new_session_id(), new_session_id());
    let yolo = compose_execution_posture(PermissionLevel::Yolo, filesystem_path(Path::new("/")));

    let live = run_context(other, readonly());
    pass_gate(&service, &live).await;
    service.move_session(&moved, yolo);
    let after = run_context(other, readonly());
    pass_gate(&service, &after).await;

    for run in [&live, &after] {
        assert_eq!(service.resolved_posture_for(&run.run_id), Some(readonly()));
    }
}

// The stored level a test sets, each read answering it where it differs from the request.
#[derive(Default)]
struct StoredLevel(Mutex<Option<ExecutionPosture>>);

impl StoredSessionPosture for StoredLevel {
    fn stored_posture<'a>(
        &'a self,
        _session_id: SessionId,
        _requested: &'a ExecutionPosture,
    ) -> BoxFuture<'a, Result<Option<ExecutionPosture>, Box<dyn Error + Send + Sync>>> {
        Box::pin(std::future::ready(Ok(lock(&self.0).clone())))
    }
}

// A level stored with no process while a gate resolves the earlier stored level is read again
// by that gate before it keeps a posture. Killed by an insert that does not compare the
// session's stores.
#[tokio::test]
async fn a_gate_reads_a_level_stored_while_it_resolved() {
    let home = tempfile::tempdir().expect("a scratch home");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let service = ExecutionPostureService::new(home.path(), home.path().join("daemon.token"));
    let stored = Arc::new(StoredLevel::default());
    service
        .set_stored_postures(Arc::downgrade(&stored) as Weak<_>)
        .expect("a new service reads no stored level yet");
    let session = new_session_id();
    let sandboxed =
        compose_execution_posture(PermissionLevel::Sandboxed, filesystem_path(&git_folder));
    let yolo = compose_execution_posture(PermissionLevel::Yolo, filesystem_path(&git_folder));

    let run = run_context(session, sandboxed.clone());
    let held = hold_reads_of(&git_folder);
    let mut gate = pin!(service.assert_run_ready(&run));
    assert!(
        futures::poll!(gate.as_mut()).is_pending(),
        "the gate waits on the requested root's held read"
    );
    *lock(&stored.0) = Some(yolo.clone());
    service.note_level_stored(&session);
    drop(held);
    gate.await.expect("the run's posture resolves");

    assert_eq!(service.resolved_posture_for(&run.run_id), Some(yolo));
}

// A session's level stored again during each of a gate's reads of it, counting the reads.
struct MovingLevel {
    service: Arc<ExecutionPostureService>,
    reads: AtomicUsize,
}

impl StoredSessionPosture for MovingLevel {
    fn stored_posture<'a>(
        &'a self,
        session_id: SessionId,
        _requested: &'a ExecutionPosture,
    ) -> BoxFuture<'a, Result<Option<ExecutionPosture>, Box<dyn Error + Send + Sync>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.service.note_level_stored(&session_id);
        Box::pin(std::future::ready(Ok(None)))
    }
}

// A session whose level was never stored has its gate read no stored level; one whose level is
// stored during each read fails its gate after `GATE_ROUNDS` reads, keeping no posture. Killed by
// a gate that reads the stored level of every session, and by one that loops without a bound.
#[tokio::test]
async fn a_gate_reads_the_stored_level_only_once_stored_and_at_most_its_rounds() {
    let service = Arc::new(ExecutionPostureService::new(
        Path::new("/home"),
        PathBuf::from("/home/daemon.token"),
    ));
    let source = Arc::new(MovingLevel {
        service: Arc::clone(&service),
        reads: AtomicUsize::new(0),
    });
    service
        .set_stored_postures(Arc::downgrade(&source) as Weak<_>)
        .expect("a new service reads no stored level yet");
    let session = new_session_id();

    let never_stored = run_context(session, readonly());
    pass_gate(&service, &never_stored).await;
    assert_eq!(source.reads.load(Ordering::SeqCst), 0);

    service.note_level_stored(&session);
    let moving = run_context(session, readonly());
    let refused = service
        .assert_run_ready(&moving)
        .await
        .expect_err("a level moving at every read fails the gate");

    assert_eq!(source.reads.load(Ordering::SeqCst), GATE_ROUNDS);
    assert!(
        matches!(&refused, RunSetupGateError::Failed(cause)
            if matches!(cause.downcast_ref(), Some(PostureGateError::Unsettled))),
        "{refused:?}"
    );
    assert_eq!(service.resolved_posture_for(&moving.run_id), None);
}

// A gate of a session whose level was stored fails where the stored levels' source was never
// handed, and once the one handed is gone. Killed by a missing or gone source read as no stored
// level.
#[tokio::test]
async fn a_gate_fails_once_the_stored_levels_are_gone() {
    let service =
        ExecutionPostureService::new(Path::new("/home"), PathBuf::from("/home/daemon.token"));
    let session = new_session_id();
    service.note_level_stored(&session);
    let unset = run_context(session, readonly());
    let unset_refusal = service
        .assert_run_ready(&unset)
        .await
        .expect_err("a source never handed fails the gate");
    let stored = Arc::new(StoredLevel::default());
    service
        .set_stored_postures(Arc::downgrade(&stored) as Weak<_>)
        .expect("a new service reads no stored level yet");
    drop(stored);

    let gone = run_context(session, readonly());
    let gone_refusal = service
        .assert_run_ready(&gone)
        .await
        .expect_err("a gone source fails the gate");

    for refused in [&unset_refusal, &gone_refusal] {
        assert!(
            matches!(refused, RunSetupGateError::Failed(cause)
                if matches!(cause.downcast_ref(), Some(PostureGateError::StoredLevelsUnreadable))),
            "{refused:?}"
        );
    }
    assert_eq!(service.resolved_posture_for(&unset.run_id), None);
}
