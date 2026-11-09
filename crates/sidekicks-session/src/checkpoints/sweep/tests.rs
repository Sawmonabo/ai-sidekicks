use std::fs::{self, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use rusqlite::params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_platforms::{file_facts, read_volume, real_path};
use sidekicks_provider::port::command_capture::{
    CommandCapture as _, CommandWindowEnd, CommandWindowId as PortWindowId,
};
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::data_folder::{session_storage_folder, workflow_run_folder};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_workflow::test_rows::{TEST_SESSION_ID, insert_run, insert_workflow_version};
use sidekicks_workspace::git::process::test_repository::{git_in, git_in_with_input};
use sidekicks_workspace::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::capture::CheckoutCaptureInput;
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;
use sidekicks_workspace::git::turn_snapshot::retention::RunContextKey;
use sidekicks_workspace::git::worktree::test_rows::RunContextRow;
use tokio_util::sync::CancellationToken;

use super::{
    CHECKPOINT_SWEEP_STATEMENT_CAPACITY, CheckpointSweep, CheckpointSweepCounts,
    CheckpointSweepDeps,
};
use crate::checkpoints::command_windows::test_fixture::{Fixture, utf8};
use crate::checkpoints::store::CommandWindowId;
use crate::checkpoints::store::shadows::{
    Shadow, ShadowContent, ShadowId, VolumeFolder, insert_current_shadow_statement,
    insert_owed_folder_statement, link_window_shadow_statement, owed_folders,
    retire_current_shadow_statement,
};

// A pass's clock reading well after the test's writes, outside the window in which a later write
// could keep the facts the pass read.
const SETTLED_READ_DELAY: Duration = Duration::from_secs(3);

// Twice the age past which a pack is old enough for a reclaim to replace it.
const PACK_AGE: Duration = Duration::from_hours(2);

// The folder holding a capture folder's reclaim marks.
const RECLAIMS: &str = "reclaims";

// The sweep over the fixture's store, windows and packing, and the clock its passes read.
fn sweep_over(fixture: &Fixture) -> (CheckpointSweep, Arc<TestWallClock>) {
    let clock = Arc::new(TestWallClock::default());
    let sweep = CheckpointSweep::new(CheckpointSweepDeps {
        reads: Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            CHECKPOINT_SWEEP_STATEMENT_CAPACITY,
        )),
        writer: Arc::clone(&fixture.log.writer),
        packing: Arc::clone(&fixture.packing),
        data_folder: fixture.data_folder.clone(),
        clock: Arc::clone(&clock) as Arc<dyn sidekicks_platforms::WallClock>,
        windows: Arc::clone(&fixture.windows),
    });
    (sweep, clock)
}

// One whole pass, its clock set past the test's writes.
async fn pass(sweep: &CheckpointSweep, clock: &TestWallClock) -> CheckpointSweepCounts {
    clock.set_now(SystemTime::now() + SETTLED_READ_DELAY);
    let (counts, failure) = sweep
        .run_pass(&CancellationToken::new(), &ProcessorMeter::default())
        .await;
    if let Some(failure) = failure {
        panic!("the pass runs, got {failure:?}");
    }
    counts
}

// Opens a window, lets its command begin covered, and closes it as exited once `during` ran.
async fn run_window(fixture: &Fixture, during: impl AsyncFnOnce()) -> PortWindowId {
    let window = fixture.open_window().await;
    fixture.windows.command_began(&window, true).await;
    during().await;
    fixture
        .close(
            window.clone(),
            CommandWindowEnd::Exited {
                exit_code: Some(0),
                signal: None,
            },
        )
        .await;
    window
}

// The one capture folder under `owner`, the large files' and the copies' folders aside.
fn capture_folder_of(owner: &Path) -> PathBuf {
    let mut folders: Vec<PathBuf> = fs::read_dir(owner.join(CAPTURES_SEGMENT))
        .expect("the captures folder is listed")
        .map(|entry| entry.expect("the entry reads").path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name != "large" && name != "copies")
        })
        .collect();
    assert_eq!(folders.len(), 1, "one capture folder: {folders:?}");
    folders.remove(0)
}

// Whether git in `folder` answers `arguments` without failing.
async fn git_succeeds(git: &GitRunner, folder: &Path, arguments: &[&str]) -> bool {
    git.run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .is_ok()
}

// Writes `text` as a blob packed alone into the capture folder `folder`, its loose copy removed,
// and answers its id.
async fn pack_lone_blob(git: &GitRunner, folder: &Path, text: &str) -> String {
    let blob = git_in_with_input(git, folder, &["hash-object", "-w", "--stdin"], text).await;
    let listed = format!("{blob}\n");
    git_in_with_input(
        git,
        folder,
        &["pack-objects", "-q", "objects/pack/pack"],
        &listed,
    )
    .await;
    git_in(git, folder, &["prune-packed"]).await;
    blob
}

// Commits every change in `repository` as `message`.
async fn commit_all(git: &GitRunner, repository: &Path, message: &str) {
    git_in(
        git,
        repository,
        &[
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "-am",
            message,
        ],
    )
    .await;
}

// The window's capture columns named `columns`, in order.
fn window_columns<const N: usize>(
    fixture: &Fixture,
    window: &PortWindowId,
    columns: [&str; N],
) -> [String; N] {
    let sql = format!(
        "SELECT {} FROM checkpoint_commands WHERE window_id = ?1",
        columns.join(", ")
    );
    fixture
        .database
        .reader()
        .query_row(&sql, [window.as_str()], |row| {
            let mut values = Vec::with_capacity(N);
            for index in 0..N {
                values.push(row.get::<_, String>(index)?);
            }
            Ok(values)
        })
        .expect("the window's row reads")
        .try_into()
        .expect("one value per column")
}

// Sets every pack of the capture folder `folder` two hours back, by path, since git writes them
// read-only.
fn age_packs(folder: &Path) {
    let aged = FileTimes::new().set_modified(SystemTime::now() - PACK_AGE);
    for entry in fs::read_dir(folder.join("objects").join("pack")).expect("the packs are listed") {
        let path = entry.expect("the entry reads").path();
        if path
            .extension()
            .is_some_and(|extension| extension == "pack")
        {
            fs::set_times(&path, aged).expect("the pack is aged");
        }
    }
}

// Kills: the window points not handed over, the session's pairs not listed, the after point handed
// in place of the before (the before-capture's file goes with the repository's gc), and the pairs
// not one per canonical common folder (the context's and the window's spellings make two).
#[tokio::test]
async fn a_command_capture_whose_base_no_ref_reaches_keeps_its_file_through_a_pass() {
    let fixture = Fixture::with_repository(&[("file.txt", "base\n")]).await;
    let git = test_git_runner();
    let repository = fixture.checkout.clone();
    git_in(&git, &repository, &["checkout", "--quiet", "-b", "topic"]).await;
    fs::write(repository.join("file.txt"), "topic\n").expect("the file is changed");
    commit_all(&git, &repository, "topic").await;
    let spelled = format!("{}/./.git", utf8(&repository));
    fixture
        .database
        .reader()
        .execute(
            "UPDATE run_execution_contexts SET git_common_dir = ?1 WHERE session_id = ?2",
            params![spelled, fixture.session_id.to_string()],
        )
        .expect("the context's spelling is set");
    let window = run_window(&fixture, async || {
        git_in(&git, &repository, &["checkout", "--quiet", "-"]).await;
    })
    .await;
    git_in(&git, &repository, &["branch", "--quiet", "-D", "topic"]).await;
    git_in(
        &git,
        &repository,
        &["reflog", "expire", "--expire=now", "--all"],
    )
    .await;
    let (sweep, clock) = sweep_over(&fixture);

    let counts = pass(&sweep, &clock).await;

    git_in(&git, &repository, &["gc", "--quiet", "--prune=now"]).await;
    let [tree_before] = window_columns(&fixture, &window, ["tree_before"]);
    let folder = capture_folder_of(&session_storage_folder(
        &fixture.data_folder,
        &fixture.session_id,
    ));
    let file = git_in(
        &git,
        &folder,
        &["cat-file", "-p", &format!("{tree_before}:file.txt")],
    )
    .await;
    assert_eq!(file, "topic");
    assert_eq!((counts.pairs_examined, counts.pairs_swept), (1, 1));
}

// Kills: the passes not kept (the second pass sweeps), a purging session listed (three examined),
// only sessions listed (the first pass examines one), and the workflow run's owner spelled
// otherwise than its capture's (its pass answers `Absent`, one swept).
#[tokio::test]
async fn a_second_pass_skips_idle_folders_and_a_purging_session_is_left_alone() {
    let fixture = Fixture::with_repository(&[("file.txt", "base\n")]).await;
    let repository = fixture.checkout.clone();
    run_window(&fixture, async || {
        fs::write(repository.join("file.txt"), "changed\n").expect("the file is changed");
    })
    .await;
    let reader = fixture.database.reader();
    let git_common_dir = repository.join(".git");
    let capture_into = async |owner_folder: PathBuf| {
        let capture = fixture
            .captures
            .capture_before(
                None,
                &CheckoutCaptureInput {
                    owner_folder,
                    execution_root: repository.clone(),
                    checkout_root: repository.clone(),
                    captured_at: jiff::Timestamp::now(),
                },
            )
            .await
            .expect("the capture is taken");
        fixture.packing.pack(None, &capture.objects).await;
    };
    let marked = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    insert_session_row(&reader, marked.text().as_str(), None, None);
    reader
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![
                <&'static str>::from(SessionState::PurgeRequested),
                marked.text().as_str()
            ],
        )
        .expect("the session is marked");
    let definition_id = mint_uuid_v7().to_string();
    let version_id = mint_uuid_v7().to_string();
    let workflow_run_id = mint_uuid_v7().to_string();
    insert_workflow_version(&reader, &definition_id, &version_id, "Sweep");
    insert_run(
        &reader,
        &workflow_run_id,
        &version_id,
        WorkflowRunStatus::Running,
        "2026-01-01T00:00:00Z",
        None,
    );
    let marked_run = mint_uuid_v7().to_string();
    let marked_session = marked.to_string();
    for (run_id, session_id) in [
        (marked_run.as_str(), marked_session.as_str()),
        (workflow_run_id.as_str(), TEST_SESSION_ID),
    ] {
        RunContextRow {
            run_id,
            session_id,
            execution_root: utf8(&repository),
            checkout_root: Some(utf8(&repository)),
            git_common_dir: Some(utf8(&git_common_dir)),
            ..RunContextRow::BOUND_ROOT
        }
        .insert(&reader)
        .expect("the run's context is stored");
    }
    capture_into(session_storage_folder(&fixture.data_folder, &marked)).await;
    capture_into(workflow_run_folder(
        &fixture.data_folder,
        &WorkflowDefinitionId::new(&definition_id).expect("a definition id"),
        &WorkflowRunId::new(&workflow_run_id).expect("a workflow run id"),
    ))
    .await;
    let (sweep, clock) = sweep_over(&fixture);

    let first = pass(&sweep, &clock).await;
    let second = pass(&sweep, &clock).await;

    assert_eq!((first.pairs_examined, first.pairs_swept), (2, 2));
    assert_eq!((second.pairs_examined, second.pairs_swept), (2, 0));
}

// Kills: the owed rows not read, a row deleted while its folder stays (the absent volume's row
// goes), and a folder on an absent volume removed.
#[tokio::test]
async fn an_owed_folder_goes_once_its_volume_is_back_and_one_on_an_absent_volume_stays() {
    let fixture = Fixture::with_repository(&[]).await;
    let home = tempfile::tempdir().expect("the test makes its folder");
    let home = real_path(home.path()).expect("the folder resolves");
    let [mounted, absent] = ["mounted-user", "absent-user"].map(|user_folder| {
        let folder = home.join(user_folder).join("session");
        fs::create_dir_all(&folder).expect("the owed folder is made");
        fs::write(folder.join("clone"), "clone").expect("a clone is written");
        folder
    });
    let row = |folder: &Path, volume_id: String| VolumeFolder {
        volume_id: volume_id.parse().expect("a volume id"),
        folder: FilesystemPath::new(utf8(folder).to_owned()).expect("a test path"),
    };
    let mounted_volume = read_volume(&mounted).expect("the folder's volume reads").id;
    let absent_row = row(&absent, "absent-volume".to_owned());
    fixture
        .log
        .writer
        .write(vec![
            insert_owed_folder_statement(&row(&mounted, mounted_volume.to_string())),
            insert_owed_folder_statement(&absent_row),
        ])
        .await
        .expect("the owed folders are recorded");
    let (sweep, clock) = sweep_over(&fixture);

    let counts = pass(&sweep, &clock).await;

    assert!(!mounted.exists(), "the mounted volume's folder goes");
    assert!(
        absent.join("clone").exists(),
        "the absent volume's folder stays"
    );
    assert_eq!(
        owed_folders(&fixture.database.reader()).expect("the owed folders read"),
        [absent_row]
    );
    assert_eq!(counts.owed_folders_examined, 2);
}

// Kills: the sessions holding unused shadows not read (the unused clone stays), and a used shadow
// deleted (the linked shadow or its clone goes).
#[tokio::test]
async fn a_retired_shadow_nothing_uses_goes_with_its_clone() {
    let fixture = Fixture::with_repository(&[]).await;
    let large = session_storage_folder(&fixture.data_folder, &fixture.session_id)
        .join(CAPTURES_SEGMENT)
        .join("large");
    fs::create_dir_all(&large).expect("the clones' folder is made");
    let [unused, used] = ["unused.bin", "used.bin"].map(|name| {
        let clone = large.join(name);
        fs::write(&clone, "clone").expect("a clone is written");
        let shadow = Shadow {
            shadow_id: ShadowId::mint(),
            session_id: fixture.session_id,
            path: fixture.recorded(name),
            content: ShadowContent::Cloned {
                clone_path: FilesystemPath::new(utf8(&clone).to_owned()).expect("a clone path"),
                volume_id: None,
            },
            facts: Some(file_facts(&clone).expect("the clone's facts are read")),
            taken_at: jiff::Timestamp::now(),
            time_precision: Duration::from_secs(1),
        };
        (shadow, clone)
    });
    let window_id = CommandWindowId::mint();
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO checkpoint_commands (window_id, checkpoint_id, command, started_at)
             VALUES (?1, ?2, 'npm test', '2026-01-01T00:00:00Z')",
            params![window_id.text().as_str(), fixture.checkpoint_id.as_str()],
        )
        .expect("the window is stored");
    let mut statements = Vec::new();
    for (shadow, _) in [&unused, &used] {
        statements.push(insert_current_shadow_statement(shadow));
        statements.push(retire_current_shadow_statement(
            fixture.session_id,
            &shadow.path,
        ));
    }
    statements.push(link_window_shadow_statement(window_id, used.0.shadow_id));
    fixture
        .log
        .writer
        .write(statements)
        .await
        .expect("the shadows are written");
    let (sweep, clock) = sweep_over(&fixture);

    let counts = pass(&sweep, &clock).await;

    let shadow_count = |shadow: &Shadow| -> i64 {
        fixture
            .database
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM checkpoint_shadows WHERE shadow_id = ?1",
                [shadow.shadow_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the shadow counts")
    };
    assert_eq!(shadow_count(&unused.0), 0, "the unused shadow's row goes");
    assert!(!unused.1.exists(), "the unused shadow's clone goes");
    assert_eq!(shadow_count(&used.0), 1, "the linked shadow's row stays");
    assert!(used.1.exists(), "the linked shadow's clone stays");
    assert_eq!(counts.sessions_reclaimed, 1);
}

// Kills: the kept list read from refs only (the window's `window.txt` blobs go), the after point's
// commit left out (its blob goes), a window's points kept only under the spelling its row records
// (the row's spelling names a link since removed, so its blobs go), a kept index's entries left out
// (the blob a capture under way staged goes), a pack written within the hour dropped (its blob
// goes), the reclaim not run on a marked folder (the `deleted.txt` blob stays), a mark taken as
// due while its run's ref remains (the first pass reclaims and removes it, so the second leaves the
// `deleted.txt` blob), a mark removed while a fresh pack holds an object outside the kept set, and
// a mark kept once the folder holds nothing else.
#[tokio::test]
async fn a_deleted_runs_objects_go_and_every_capture_the_store_holds_stays_whole() {
    let fixture = Fixture::with_repository(&[("file.txt", "base\n")]).await;
    let git = test_git_runner();
    let repository = fixture.checkout.clone();
    let owner = session_storage_folder(&fixture.data_folder, &fixture.session_id);
    let snapshot_ref =
        |run_key: RunContextKey| format!("refs/sidekicks/runs/{run_key}/epoch-0/turn-1");
    let mint_run_key = || RunContextKey::from(RunId::try_from(mint_uuid_v7()).expect("a run id"));
    let capture_as = async |run_key: RunContextKey| {
        let capture = fixture
            .captures
            .capture_before(
                None,
                &CheckoutCaptureInput {
                    owner_folder: owner.clone(),
                    execution_root: repository.clone(),
                    checkout_root: repository.clone(),
                    captured_at: jiff::Timestamp::now(),
                },
            )
            .await
            .expect("the capture is taken");
        let folder = capture_folder_of(&owner);
        git_in(
            &git,
            &folder,
            &[
                "update-ref",
                &snapshot_ref(run_key),
                capture.objects.commit().as_str(),
            ],
        )
        .await;
        fixture.packing.pack(None, &capture.objects).await;
        capture.objects.commit().clone()
    };
    fs::write(repository.join("deleted.txt"), "deleted\n").expect("the file is written");
    let deleted_run = mint_run_key();
    let deleted_commit = capture_as(deleted_run).await;
    let folder = capture_folder_of(&owner);
    let deleted_blob = git_in(
        &git,
        &folder,
        &[
            "rev-parse",
            &format!("{}:deleted.txt", deleted_commit.as_str()),
        ],
    )
    .await;
    fs::remove_file(repository.join("deleted.txt")).expect("the file is removed");
    fs::write(repository.join("window.txt"), "one\n").expect("the file is written");
    let window = run_window(&fixture, async || {
        fs::write(repository.join("window.txt"), "two\n").expect("the file is rewritten");
    })
    .await;
    // The window's row spells the repository through a link since removed, so no pair reads it.
    fixture
        .database
        .reader()
        .execute(
            "UPDATE checkpoint_commands SET git_common_dir = ?1 WHERE window_id = ?2",
            params![
                format!("{}/removed-link/.git", utf8(&fixture.data_folder)),
                window.as_str()
            ],
        )
        .expect("the window's spelling is set");
    fs::write(repository.join("window.txt"), "three\n").expect("the file is rewritten");
    let kept_commit = capture_as(mint_run_key()).await;
    // The prune's mark, written before its ref delete.
    fixture
        .packing
        .mark_reclaim_due(&owner, &repository.join(".git"), deleted_run)
        .await
        .expect("the folder is marked");
    let mark = folder.join(RECLAIMS).join(deleted_run.to_string());
    age_packs(&folder);
    let (sweep, clock) = sweep_over(&fixture);

    pass(&sweep, &clock).await;

    assert!(
        git_succeeds(&git, &folder, &["cat-file", "-e", &deleted_blob]).await,
        "a mark whose run still has refs waits"
    );
    assert!(mark.exists(), "the waiting mark stays");
    git_in(
        &git,
        &folder,
        &["update-ref", "-d", &snapshot_ref(deleted_run)],
    )
    .await;
    // A blob only a kept index names, as a command capture under way staged it.
    let indexed_blob = pack_lone_blob(&git, &folder, "indexed\n").await;
    let indexes = folder.join("indexes");
    fs::create_dir_all(&indexes).expect("the indexes folder is made");
    let staged = std::process::Command::new("git")
        .arg("-C")
        .arg(&folder)
        .args([
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{indexed_blob},indexed.txt"),
        ])
        .env("GIT_INDEX_FILE", indexes.join("ab".repeat(32)))
        .status()
        .expect("git runs");
    assert!(staged.success(), "the blob is staged in the kept index");
    age_packs(&folder);
    // A blob only a pack written within the hour holds.
    let fresh_blob = pack_lone_blob(&git, &folder, "fresh\n").await;

    pass(&sweep, &clock).await;

    assert!(
        !git_succeeds(&git, &folder, &["cat-file", "-e", &deleted_blob]).await,
        "the deleted run's file goes"
    );
    for blob in [&indexed_blob, &fresh_blob] {
        assert!(
            git_succeeds(&git, &folder, &["cat-file", "-e", blob]).await,
            "{blob} stays"
        );
    }
    assert!(
        mark.exists(),
        "an object only a fresh pack holds keeps the mark"
    );
    age_packs(&folder);

    pass(&sweep, &clock).await;

    assert!(!mark.exists(), "the reclaimed mark goes");
    assert!(
        git_succeeds(&git, &folder, &["cat-file", "-e", &indexed_blob]).await,
        "the kept index's blob stays"
    );
    // Attached only now, so the pass ran on the folder alone.
    let alternates = folder.join("objects").join("info");
    fs::create_dir_all(&alternates).expect("the info folder is made");
    fs::write(
        alternates.join("alternates"),
        format!("{}\n", utf8(&repository.join(".git").join("objects"))),
    )
    .expect("the repository is attached");
    let [commit_before, commit_after] =
        window_columns(&fixture, &window, ["commit_before", "commit_after"]);
    let listing = git_in(
        &git,
        &folder,
        &[
            "rev-list",
            "--objects",
            "--no-walk",
            "--missing=print",
            kept_commit.as_str(),
            &commit_before,
            &commit_after,
        ],
    )
    .await;
    assert!(
        listing.lines().all(|line| !line.starts_with('?')),
        "every kept capture is whole: {listing}"
    );
}
