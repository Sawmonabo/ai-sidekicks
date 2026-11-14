use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::folders::RepoMountMoveRequest;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{CAN_OPEN_INSIDE_UNREADABLE_FOLDER, is_superuser, make_unreadable};
use sidekicks_store::data_folder::session_storage_folder;
use tokio_util::sync::CancellationToken;

use super::{RUN_ID, ReattachFixture};
use crate::execution_root::test_fixture::{MOUNT_ID, SESSION_ID};
use crate::git::process::test_repository::git_in;
use crate::git::process::{GitCall, GitRunner};
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, CaptureFolder, git_folder_argument, real_path_name,
};
use crate::repo::mount::reattach::moved_captures::UncarriedCaptures;
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

// The mounts of `project_id` still recording a carry of their captures.
fn records(fixture: &ReattachFixture, project_id: &str) -> i64 {
    fixture.roots.count(&format!(
        "SELECT count(*) FROM repo_mounts WHERE project_id = '{project_id}' \
         AND json_extract(metadata, '$.capturesMovedFrom') IS NOT NULL"
    ))
}

// Another project's mount, moved into a folder whose carry cannot be made.
const HELD_MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e95";

// A past run whose context names a common folder the daemon may not enter.
const UNREACHABLE_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e96";

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
// capture folder too from `carried_name` when given, then holds the carry as the start does and
// answers it.
async fn stop_before_the_carry(
    fixture: &ReattachFixture,
    captured: &CapturedBeforeMove,
    carried_name: Option<&str>,
) -> UncarriedCaptures {
    leave_the_carry(fixture, captured, carried_name);
    fixture
        .service
        .expect_moved_captures()
        .await
        .expect("the start holds the carry before anything captures")
}

// Puts the rows back as a stop between the first move's write and its carry leaves them, and the
// capture folder too from `carried_name` when given.
fn leave_the_carry(
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
    assert_eq!(records(fixture, MOUNT_ID), 0);
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
            let uncarried = stop_before_the_carry(
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
                .carry_moved_captures(uncarried)
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
    let uncarried = fixture
        .service
        .expect_moved_captures()
        .await
        .expect("the start holds the carry");
    fixture
        .service
        .carry_moved_captures(uncarried)
        .await
        .expect_err("the new name is taken");
    assert_eq!(records(&fixture, MOUNT_ID), 1);
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

// A start whose stored carry of one project's captures cannot be made, its record unread or its
// new folder one the daemon may not enter, holds only that project: the start goes on, the other
// project's carry runs, passing over a stored folder it cannot resolve, and each opener of the held
// project's capture folder is refused with the cause. Once the folder may be entered, the next
// opener's ask carries the folder and it opens, and the carry clears the record; an unread record
// has nothing to try. Killed by a start that fails on the one record, by a carry that stops at the
// unresolved stored folder, by an opener that opens a held folder, and by an ask that tries
// nothing.
#[tokio::test]
async fn a_carry_that_cannot_be_made_holds_only_its_own_mount() {
    // A folder the daemon may not enter cannot be made here.
    if is_superuser() || CAN_OPEN_INSIDE_UNREADABLE_FOLDER {
        return;
    }
    for does_record_read in [false, true] {
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
        fixture
            .move_to(MOUNT_ID, &moved)
            .await
            .expect("the mount follows its repository");
        let new_common = moved.join(".git");
        let new_name = real_path_name(&new_common)
            .await
            .expect("the new common folder resolves");
        leave_the_carry(&fixture, &captured, Some(&new_name));

        let locked = scratch.join("locked");
        let held_common = locked.join("held").join(".git");
        std::fs::create_dir_all(&held_common).expect("the held project's folder is made");
        let held_old = scratch.join("held-old").join(".git");
        let captures = captured.owner.join(CAPTURES_SEGMENT);
        let held_old_folder = captures.join(
            real_path_name(&held_old)
                .await
                .expect("the held project's old folder resolves"),
        );
        std::fs::create_dir_all(&held_old_folder).expect("its capture folder is at the old name");
        for row in project_and_mount_rows(HELD_MOUNT_ID, None) {
            fixture
                .roots
                .rows
                .execute_batch(&row)
                .expect("the held project and its mount are stored");
        }
        // A single folder where a list belongs does not read as the record.
        let record = if does_record_read {
            "json_array(?2)"
        } else {
            "?2"
        };
        fixture
            .roots
            .rows
            .execute(
                &format!(
                    "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1, \
                     '$.capturesMovedFrom', {record}) WHERE id = '{HELD_MOUNT_ID}'"
                ),
                params![held_common.to_string_lossy(), held_old.to_string_lossy()],
            )
            .expect("the held mount records its carry");
        let unreachable = locked.join("other").join(".git");
        fixture
            .roots
            .rows
            .execute(
                "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
                 execution_mode, execution_root, checkout_root, git_common_dir, \
                 branch_context_id, created_at, released_at) \
                 SELECT ?1, session_id, workspace_id, execution_mode, execution_root, \
                 checkout_root, ?2, branch_context_id, created_at, released_at \
                 FROM run_execution_contexts WHERE run_id = ?3",
                params![UNREACHABLE_RUN_ID, unreachable.to_string_lossy(), RUN_ID],
            )
            .expect("a past run names a folder the daemon may not enter");
        let unreadable = make_unreadable(&locked).expect("the folder is made unreadable");

        let uncarried = fixture
            .service
            .expect_moved_captures()
            .await
            .expect("one record holds back no start");
        fixture
            .service
            .carry_moved_captures(uncarried)
            .await
            .expect("the other project's carry runs");
        assert_found_at(&fixture, &captured, &new_common).await;
        assert_eq!(
            fixture.text(&format!(
                "SELECT git_common_dir FROM run_execution_contexts \
                 WHERE run_id = '{UNREACHABLE_RUN_ID}'"
            )),
            Some(unreachable.to_string_lossy().into_owned())
        );
        let refused = CaptureFolder::open_existing(&fixture.packing, &captured.owner, &held_common)
            .await
            .expect_err("the held project's capture folder opens for no one");
        assert!(
            is_refused_with_the_cause(&refused, does_record_read),
            "the opener hears why: {refused:?}"
        );

        drop(unreadable);
        let reopened =
            CaptureFolder::open_existing(&fixture.packing, &captured.owner, &held_common).await;
        if does_record_read {
            let opened = reopened
                .expect("the ask carries the folder")
                .expect("the capture folder is found at the new name");
            let held_name = real_path_name(&held_common)
                .await
                .expect("the held folder resolves now");
            assert_eq!(opened.folder(), captures.join(held_name));
            assert!(!held_old_folder.exists(), "the old name is carried");
            let stop = CancellationToken::new();
            stop.cancel();
            fixture.service.carry_lifted_captures(&stop).await;
            assert_eq!(records(&fixture, HELD_MOUNT_ID), 0);
        } else {
            reopened.expect_err("a record that does not read has nothing to try");
            assert_eq!(records(&fixture, HELD_MOUNT_ID), 1);
        }
    }
}

// A move that commits while an older carry of the same mount is between its read and its write,
// and whose own carry reads the rows before that older write, leaves every row at the newest
// folder and no record: the older write is refused once the move took its record forward. Killed
// by an older write that rewrites the rows to the middle folder, which the newer carry then misses.
#[tokio::test]
async fn a_carry_a_newer_move_overtook_leaves_every_row_at_the_newest_folder() {
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
    let uncarried = stop_before_the_carry(&fixture, &captured, Some(&middle_name)).await;

    let older_paused = fixture.service.carry_write_pause.arm();
    let newer_paused = fixture.service.carry_write_pause.arm();
    let older = tokio::spawn({
        let service = Arc::clone(&fixture.service);
        async move { service.carry_moved_captures(uncarried).await }
    });
    older_paused
        .reached
        .await
        .expect("the older carry reaches its write");
    let moved_again = scratch.join("moved-again");
    std::fs::rename(&moved, &moved_again).expect("the repository moves again");
    let newer = tokio::spawn({
        let service = Arc::clone(&fixture.service);
        let request = RepoMountMoveRequest {
            repo_mount_id: first.repo_mount_id,
            local_path: FilesystemPath::new(moved_again.to_string_lossy().into_owned())
                .expect("the path is short"),
            place: None,
        };
        async move { service.move_to_folder(&request).await }
    });
    newer_paused
        .reached
        .await
        .expect("the newer move's carry reaches its write");
    older_paused
        .release
        .send(())
        .expect("the older carry waits");
    older
        .await
        .expect("the older carry ends")
        .expect("an overtaken carry writes nothing and fails nothing");
    newer_paused
        .release
        .send(())
        .expect("the newer carry waits");
    newer
        .await
        .expect("the newer move ends")
        .expect("the mount follows its repository again");

    assert_found_at(&fixture, &captured, &moved_again.join(".git")).await;
}

// Whether `refused` carries the cause of the held carry: the folder the daemon may not enter when
// the record reads, the record itself when it does not.
fn is_refused_with_the_cause(refused: &io::Error, does_record_read: bool) -> bool {
    std::iter::successors(Some(refused as &(dyn Error + 'static)), |&error| {
        error.source()
    })
    .any(|cause| {
        if does_record_read {
            cause
                .downcast_ref::<io::Error>()
                .is_some_and(|cause| cause.kind() == io::ErrorKind::PermissionDenied)
        } else {
            cause.is::<serde_json::Error>()
        }
    })
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
