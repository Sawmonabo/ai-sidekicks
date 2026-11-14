use std::ffi::OsString;
use std::path::{Path, PathBuf};

use rusqlite::params;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::data_folder::session_storage_folder;

use super::{RUN_ID, ReattachFixture};
use crate::execution_root::test_fixture::{MOUNT_ID, SESSION_ID};
use crate::git::process::test_repository::git_in;
use crate::git::process::{GitCall, GitRunner};
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, CaptureFolder, git_folder_argument, real_path_name,
};
use crate::test_rows::PARENT_ROWS_AT;

// Counts the mounts still recording a carry of their captures.
const RECORD: &str = "SELECT count(*) FROM repo_mounts \
                      WHERE json_extract(metadata, '$.capturesMovedFrom') IS NOT NULL";

// A capture of the session's taken in the mount's repository before any move, with the run
// context that names its common folder.
struct CapturedBeforeMove {
    owner: PathBuf,
    old_common: PathBuf,
    capture_folder: CaptureFolder,
    blob: String,
    head: String,
}

// Records the mount's first commit and a past run's context, and writes a file's words into the
// session's capture folder of the mount's repository.
async fn capture_before_a_move(fixture: &ReattachFixture) -> CapturedBeforeMove {
    let git = &fixture.roots.git;
    let workspace_id = fixture.roots.bind().await;
    let repository = fixture.roots.repository.clone();
    let head = git_in(git, &repository, &["rev-parse", "HEAD"]).await;
    let root_commit = git_in(git, &repository, &["rev-list", "--max-parents=0", "HEAD"]).await;
    let old_common = repository.join(".git");
    fixture
        .roots
        .rows
        .execute_batch(&format!(
            "UPDATE repo_mounts SET metadata = json_set(metadata, '$.rootCommit', '{root_commit}') \
             WHERE id = '{MOUNT_ID}';
             INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at, \
             updated_at) VALUES ('branch-context', '{workspace_id}', 'main', 'main', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, branch_context_id, \
             created_at, released_at) VALUES ('{RUN_ID}', '{SESSION_ID}', '{workspace_id}', \
             'boundRoot', '{root}', '{root}', '{common}', 'branch-context', '{PARENT_ROWS_AT}', \
             '{PARENT_ROWS_AT}')",
            root = repository.to_string_lossy(),
            common = old_common.to_string_lossy(),
        ))
        .expect("the mount records its first commit and a past run its context");
    let owner = session_storage_folder(
        &fixture.roots.scratch.path().join("data"),
        &SessionId::new(SESSION_ID).expect("the id is a UUID"),
    );
    let captured_file = fixture.roots.scratch.path().join("captured.txt");
    std::fs::write(&captured_file, "the captured words").expect("the file is written");
    let capture_folder =
        CaptureFolder::open_or_create(git, None, &fixture.packing, &owner, &old_common)
            .await
            .expect("the capture folder is made");
    let blob = capture_git(
        git,
        &capture_folder,
        &["hash-object", "-w", &captured_file.to_string_lossy()],
    )
    .await;
    CapturedBeforeMove {
        owner,
        old_common,
        capture_folder,
        blob,
        head,
    }
}

// Puts the rows back as a stop between the first move's write and its carry leaves them, and the
// capture folder too from `carried_name` when given, then holds the carry as the start does.
async fn stop_before_the_carry(
    fixture: &ReattachFixture,
    captured: &CapturedBeforeMove,
    carried_name: Option<&str>,
) {
    fixture
        .roots
        .rows
        .execute_batch(&format!(
            "UPDATE repo_mounts SET metadata = json_set(metadata, \
             '$.capturesMovedFrom', json_array('{old}')) WHERE state = 'attached';
             UPDATE run_execution_contexts SET git_common_dir = '{old}'",
            old = captured.old_common.to_string_lossy(),
        ))
        .expect("the stop leaves the move's write alone");
    if let Some(carried_name) = carried_name {
        std::fs::rename(
            captured.owner.join(CAPTURES_SEGMENT).join(carried_name),
            captured.capture_folder.folder(),
        )
        .expect("the capture folder is as it was before the carry");
    }
    fixture
        .service
        .expect_moved_captures()
        .await
        .expect("the start holds the carry before anything captures");
}

// The carry is done: the run's context names `common`, no mount records a carry, and the capture
// is found and read at `common`'s capture folder with the repository's history.
async fn assert_found_at(fixture: &ReattachFixture, captured: &CapturedBeforeMove, common: &Path) {
    let git = &fixture.roots.git;
    assert_eq!(
        fixture.text(&format!(
            "SELECT git_common_dir FROM run_execution_contexts WHERE run_id = '{RUN_ID}'"
        )),
        Some(common.to_string_lossy().into_owned())
    );
    assert_eq!(fixture.roots.count(RECORD), 0);
    let found = CaptureFolder::open_existing(&fixture.packing, &captured.owner, common)
        .await
        .expect("the captures folder reads")
        .expect("the capture folder is found at the new folder");
    assert_eq!(
        capture_git(git, &found, &["cat-file", "-p", &captured.blob]).await,
        "the captured words"
    );
    assert_eq!(
        capture_git(git, &found, &["cat-file", "-t", &captured.head]).await,
        "commit"
    );
}

// A capture taken before its repository moved is found and read at the new folder after the move,
// its run's context naming the new common folder; and so it is after a stop cut the move between
// its write and the carry, once the start's carry runs, whether the folder was renamed or not, and
// when a turn captured at the new name before that carry. Killed by the move's carry dropped (no
// folder at the new name), by the rows left unrewritten (the context names the old folder), by the
// record of the carry left unwritten or uncleared, by an opener that makes a folder at the new
// name while the carry is pending, and by a rename that replaces a folder already at the new name.
#[tokio::test]
async fn a_capture_taken_before_a_move_is_found_and_read_after_it() {
    let fixture = ReattachFixture::new().await;
    let git = &fixture.roots.git;
    let captured = capture_before_a_move(&fixture).await;
    let moved = fixture
        .roots
        .repository
        .parent()
        .expect("the repository sits in the scratch folder")
        .join("moved");
    std::fs::rename(&fixture.roots.repository, &moved).expect("the repository moves");
    fixture
        .move_to(MOUNT_ID, &moved)
        .await
        .expect("the mount follows its repository");
    let new_common = moved.join(".git");
    let new_name = real_path_name(&new_common)
        .await
        .expect("the new common folder resolves");

    // As the move left it, then as a stop after its write leaves it, the folder renamed or not.
    for is_folder_renamed_back in [None, Some(false), Some(true)] {
        if let Some(is_folder_renamed_back) = is_folder_renamed_back {
            stop_before_the_carry(
                &fixture,
                &captured,
                is_folder_renamed_back.then_some(new_name.as_str()),
            )
            .await;
            // A turn captures at the new name before the start's carry runs.
            let turn_folder = CaptureFolder::open_or_create(
                git,
                None,
                &fixture.packing,
                &captured.owner,
                &new_common,
            )
            .await
            .expect("the turn's capture folder opens");
            assert_eq!(
                capture_git(git, &turn_folder, &["cat-file", "-p", &captured.blob]).await,
                "the captured words"
            );
            fixture
                .service
                .carry_moved_captures()
                .await
                .expect("the start's carry finishes the move");
        }
        assert_found_at(&fixture, &captured, &new_common).await;
    }

    // A folder already at the new name is never replaced.
    std::fs::create_dir_all(captured.capture_folder.folder()).expect("a folder takes the old name");
    fixture
        .roots
        .rows
        .execute(
            "UPDATE repo_mounts SET metadata = json_set(metadata, '$.capturesMovedFrom', \
             json_array(?1)) WHERE state = 'attached'",
            params![captured.old_common.to_string_lossy()],
        )
        .expect("a carry is owed again");
    fixture
        .service
        .carry_moved_captures()
        .await
        .expect_err("the new name is taken");
    assert_eq!(fixture.roots.count(RECORD), 1);
}

// A capture taken before a first move is found and read after a second move made before the first
// move's carry ran: the second move's write takes the first record forward and its carry renames
// the folder from the oldest name. Killed by the record left on the ended mount (the folder stays
// at the oldest name and the context names the oldest folder) and by a carry from the middle name
// only.
#[tokio::test]
async fn a_capture_taken_before_two_moves_is_found_and_read_after_both() {
    let fixture = ReattachFixture::new().await;
    let captured = capture_before_a_move(&fixture).await;
    let scratch = fixture
        .roots
        .repository
        .parent()
        .expect("the repository sits in the scratch folder")
        .to_path_buf();
    let moved = scratch.join("moved");
    std::fs::rename(&fixture.roots.repository, &moved).expect("the repository moves");
    let first = fixture
        .move_to(MOUNT_ID, &moved)
        .await
        .expect("the mount follows its repository");
    let middle_name = real_path_name(&moved.join(".git"))
        .await
        .expect("the middle common folder resolves");
    stop_before_the_carry(&fixture, &captured, Some(&middle_name)).await;

    let moved_again = scratch.join("moved-again");
    std::fs::rename(&moved, &moved_again).expect("the repository moves again");
    fixture
        .move_to(first.repo_mount_id.text().as_str(), &moved_again)
        .await
        .expect("the mount follows its repository again");

    assert_found_at(&fixture, &captured, &moved_again.join(".git")).await;
}

// What git printed, trimmed, for `arguments` against the capture folder with the repository's
// objects attached. Panics when git fails.
async fn capture_git(
    git: &GitRunner,
    capture_folder: &CaptureFolder,
    arguments: &[&str],
) -> String {
    let mut call = GitCall::read(
        [git_folder_argument(capture_folder.folder())]
            .into_iter()
            .chain(arguments.iter().map(OsString::from)),
    );
    for (name, value) in capture_folder.write_environment() {
        call = call.with_environment(name, value);
    }
    let output = git.run(None, call).await.expect("git answers");
    String::from_utf8(output.stdout)
        .expect("git prints UTF-8")
        .trim()
        .to_owned()
}
