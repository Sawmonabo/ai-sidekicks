use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, SystemTime};

use rstest::rstest;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{create_new_file, file_mode};
use sidekicks_provider::port::command_capture::{
    CommandCapture as _, CommandWindowEnd, CommandWindowId as PortWindowId, CommandWindowStart,
};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::process::test_repository::git_in;
use sidekicks_workspace::test_rows::insert_held_managed_mount;

use super::bare_opening;
use super::test_fixture::{Fixture, utf8};
use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionLeg, CopyMode, NotKeptReason,
};
use crate::checkpoints::store::shadows::{
    Shadow, ShadowContent, ShadowId, insert_current_shadow_statement, link_window_shadow_statement,
};
use crate::checkpoints::store::{
    CheckpointVersion, CommandWindowId, insert_version_statement, open_command_window_statement,
    uncovered_commands,
};

/// The size a large file takes in these tests, past the 10 MiB bound.
const LARGE_FILE_BYTES: usize = 11 * 1024 * 1024;

// Writes `bytes` copies of `byte` to `path`, a large file's content.
fn write_large(path: &Path, byte: u8) {
    std::fs::write(path, vec![byte; LARGE_FILE_BYTES]).expect("the test writes a large file");
}

// Sets `path`'s modified time two seconds back, so a shadow taken now does not read the file the
// test just wrote as racy.
fn backdate(path: &Path) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("the file opens")
        .set_modified(SystemTime::now() - Duration::from_secs(2))
        .expect("the file's modified time is set");
}

// Killed by copying the after bytes, by recording under another checkpoint, by leaving `covered`
// unset, by recording a path the checkpoint already holds, and by leaving either capture commit
// unbound.
#[tokio::test]
async fn a_commands_changes_are_recorded_under_the_turns_checkpoint() {
    let fixture = Fixture::with_repository(&[
        ("notes.txt", "notes before\n"),
        ("gone.txt", "gone before\n"),
        ("run.sh", "echo run\n"),
        ("held.txt", "held before\n"),
        (".gitignore", "build/\n"),
    ])
    .await;
    std::fs::create_dir(fixture.checkout.join("build")).expect("the ignored folder is made");
    std::fs::write(fixture.checkout.join("build").join("out.o"), "out").expect("a build output");
    // An edit already recorded this path in the checkpoint.
    fixture
        .log
        .writer
        .write(vec![insert_version_statement(
            &fixture.checkpoint_id,
            &CheckpointVersion {
                path: fixture.recorded("held.txt"),
                leg: CheckpointVersionLeg::Edit,
                content: CheckpointVersionContent::Created,
                parent_real_path: fixture.recorded(""),
                window_id: None,
                tool_call_id: None,
            },
        )])
        .await
        .expect("the edit's version is written");

    let window = fixture.open_window().await;
    let checkout = &fixture.checkout;
    std::fs::write(checkout.join("notes.txt"), "notes after\n").expect("the file is changed");
    std::fs::write(checkout.join("made.txt"), "made\n").expect("a file is made");
    std::fs::remove_file(checkout.join("gone.txt")).expect("a file is removed");
    std::fs::write(checkout.join("held.txt"), "held after\n").expect("the held file is changed");
    // The same bytes again, now executable.
    std::fs::remove_file(checkout.join("run.sh")).expect("the script is removed");
    create_new_file(&checkout.join("run.sh"), 0o755)
        .expect("the script is made again")
        .write_all(b"echo run\n")
        .expect("the script is written");
    fixture.windows.command_began(&window, true).await;
    fixture
        .close(
            window.clone(),
            CommandWindowEnd::Exited {
                exit_code: Some(0),
                signal: None,
            },
        )
        .await;

    let changed = fixture
        .version_of("notes.txt")
        .expect("the change is recorded");
    assert_eq!(changed.leg, CheckpointVersionLeg::Command);
    assert_eq!(
        changed.window_id.map(|id| id.text().as_str().to_owned()),
        Some(window.as_str().to_owned())
    );
    assert_eq!(fixture.copy_bytes(&changed.content), b"notes before\n");
    let removed = fixture
        .version_of("gone.txt")
        .expect("the removal is recorded");
    assert_eq!(fixture.copy_bytes(&removed.content), b"gone before\n");
    assert_eq!(
        fixture
            .version_of("made.txt")
            .map(|version| version.content),
        Some(CheckpointVersionContent::Created)
    );
    if file_mode(&checkout.join("run.sh")).expect("the mode reads") & 0o100 != 0 {
        let script = fixture
            .version_of("run.sh")
            .expect("the mode change is recorded");
        assert!(matches!(
            script.content,
            CheckpointVersionContent::Copy {
                mode: CopyMode::Executable(false),
                ..
            }
        ));
        assert_eq!(fixture.copy_bytes(&script.content), b"echo run\n");
    }
    let held_versions: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM checkpoint_versions WHERE path = ?1",
            [fixture.recorded("held.txt").as_str()],
            |row| row.get(0),
        )
        .expect("the held path's versions count");
    assert_eq!(
        held_versions, 1,
        "a path the checkpoint held is not recorded again"
    );
    let every_under_checkpoint: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM checkpoint_versions WHERE checkpoint_id <> ?1",
            [fixture.checkpoint_id.as_str()],
            |row| row.get(0),
        )
        .expect("the versions count");
    assert_eq!(every_under_checkpoint, 0);
    let (covered, has_capture_columns, ignored): (Option<i64>, bool, Option<String>) = fixture
        .database
        .reader()
        .query_row(
            "SELECT covered,
                    commit_before IS NOT NULL AND commit_after IS NOT NULL
                      AND git_common_dir IS NOT NULL,
                    ignored_folders
               FROM checkpoint_commands WHERE window_id = ?1",
            [window.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the window's row reads");
    assert_eq!(covered, Some(1));
    assert!(
        has_capture_columns,
        "both capture commits and the common folder are bound"
    );
    assert!(
        ignored.is_some_and(|folders| folders.contains("build")),
        "the ignored folder is named"
    );
}

/// How a window's capture is cut short.
#[derive(Clone, Copy, Debug)]
enum Uncapturable {
    /// The command ended with no `Began` told.
    NoBegan,
    /// The checkout's repository was gone at the open.
    BeforeFailed,
    /// The checkout's repository was gone at the close.
    AfterFailed,
    /// The command never ran.
    Unrun,
}

// Killed by reading a command with no `Began` as covered, by recording a failed capture as covered,
// and by naming an unrun command uncovered.
#[rstest]
#[case::no_began(Uncapturable::NoBegan)]
#[case::before_failed(Uncapturable::BeforeFailed)]
#[case::after_failed(Uncapturable::AfterFailed)]
#[case::unrun(Uncapturable::Unrun)]
#[tokio::test]
async fn a_window_closes_uncovered_when_it_could_not_capture(#[case] case: Uncapturable) {
    let fixture = Fixture::with_repository(&[("notes.txt", "notes before\n")]).await;
    let repository_folder = fixture.checkout.join(".git");
    if matches!(case, Uncapturable::BeforeFailed) {
        std::fs::remove_dir_all(&repository_folder).expect("the repository is removed");
    }
    let window = fixture.open_window().await;
    std::fs::write(fixture.checkout.join("notes.txt"), "notes after\n").expect("a change");
    let end = match case {
        Uncapturable::Unrun => CommandWindowEnd::Unrun,
        Uncapturable::AfterFailed => {
            fixture.windows.command_began(&window, true).await;
            std::fs::remove_dir_all(&repository_folder).expect("the repository is removed");
            CommandWindowEnd::Exited {
                exit_code: Some(0),
                signal: None,
            }
        }
        Uncapturable::NoBegan | Uncapturable::BeforeFailed => CommandWindowEnd::Exited {
            exit_code: Some(0),
            signal: None,
        },
    };
    fixture.close(window.clone(), end).await;

    let is_unrun = matches!(case, Uncapturable::Unrun);
    assert_eq!(fixture.covered(&window), Some(i64::from(is_unrun)));
    assert_eq!(fixture.uncovered_count(), usize::from(!is_unrun));
    let notes = fixture.version_of("notes.txt");
    if matches!(case, Uncapturable::NoBegan) {
        // The after-capture still reads what changed.
        assert!(notes.is_some());
    } else {
        assert_eq!(notes, None);
    }
}

// Killed by copying the stale index blob instead of the shadow, by taking no fresh shadow, and by
// recording a large file whose shadow is unchanged.
#[tokio::test]
async fn a_large_file_a_command_changes_keeps_its_shadow_and_takes_a_fresh_one() {
    let fixture = Fixture::with_repository(&[]).await;
    for (name, byte) in [("big.bin", b'a'), ("still.bin", b's')] {
        write_large(&fixture.checkout.join(name), byte);
        backdate(&fixture.checkout.join(name));
    }
    let window = fixture.open_window().await;
    let first = fixture.shadows_of("big.bin");
    assert_eq!(first.len(), 1, "the open shadows the large file: {first:?}");
    let (first_id, first_clone, _) = first[0].clone();
    write_large(&fixture.checkout.join("big.bin"), b'b');
    fixture.windows.command_began(&window, true).await;
    fixture
        .close(
            window,
            CommandWindowEnd::Exited {
                exit_code: Some(0),
                signal: None,
            },
        )
        .await;

    let version = fixture
        .version_of("big.bin")
        .expect("the change is recorded");
    match &first_clone {
        Some(clone) => {
            let CheckpointVersionContent::Shadow { shadow_id } = version.content else {
                panic!("the shadow is the copy, not {:?}", version.content);
            };
            assert_eq!(shadow_id.text().as_str(), first_id);
            let kept = std::fs::read(clone).expect("the clone reads");
            assert!(
                kept.iter().all(|&byte| byte == b'a'),
                "the clone keeps the old bytes"
            );
        }
        None => assert_eq!(
            version.content,
            CheckpointVersionContent::NotKept {
                reason: NotKeptReason::TooLarge
            }
        ),
    }
    let shadows = fixture.shadows_of("big.bin");
    let current: Vec<_> = shadows
        .iter()
        .filter(|(_, _, is_current)| *is_current)
        .collect();
    assert_eq!(current.len(), 1, "one fresh shadow: {shadows:?}");
    assert_ne!(current[0].0, first_id);
    if first_clone.is_some() {
        assert!(
            shadows
                .iter()
                .any(|(id, _, is_current)| *id == first_id && !is_current),
            "the first shadow is retired: {shadows:?}"
        );
    }
    assert_eq!(fixture.version_of("still.bin"), None);
}

// Killed by dropping the chat's managed workspace as the window's checkout.
#[tokio::test]
async fn a_chats_command_is_captured_in_its_managed_workspace() {
    let root = tempfile::tempdir().expect("the test makes its folder");
    let git = test_git_runner();
    let folder = root.path().join("chat");
    std::fs::create_dir(&folder).expect("the chat's folder is made");
    git_in(&git, &folder, &["init", "--quiet"]).await;
    let fixture = Fixture::open(root, git, folder.clone()).await;
    let rows = fixture.database.reader();
    let session = fixture.session_id.text();
    insert_session_row(&rows, session.as_str(), None, None);
    let mount_id = mint_uuid_v7().to_string();
    insert_held_managed_mount(&rows, &mount_id, &folder, session.as_str());
    rows.execute(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
                                 created_at, updated_at)
         VALUES (?1, ?2, ?3, 'boundRoot', ?4, 'ready', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')",
        [
            mint_uuid_v7().to_string().as_str(),
            session.as_str(),
            mount_id.as_str(),
            utf8(&folder),
        ],
    )
    .expect("the chat's workspace is stored");
    let run_id = fixture.insert_run();
    fixture.insert_checkpoint(run_id).await;

    let window = fixture.open_window().await;
    std::fs::write(folder.join("draft.md"), "a draft\n").expect("the chat writes a file");
    fixture.windows.command_began(&window, true).await;
    fixture
        .close(
            window,
            CommandWindowEnd::Exited {
                exit_code: Some(0),
                signal: None,
            },
        )
        .await;

    assert_eq!(
        fixture
            .version_of("draft.md")
            .map(|version| version.content),
        Some(CheckpointVersionContent::Created)
    );
}

// Killed by removing the session's shadow lock, where the unique current shadow refuses one open's
// write, and by a second close retiring a shadow the first already retired.
#[tokio::test]
async fn two_windows_of_one_session_share_its_large_files() {
    let fixture = Fixture::with_repository(&[]).await;
    write_large(&fixture.checkout.join("big.bin"), b'a');
    backdate(&fixture.checkout.join("big.bin"));
    let (first, second) = tokio::join!(
        fixture.windows.open_window(fixture.start()),
        fixture.windows.open_window(fixture.start())
    );
    let first = first.expect("the first window opens");
    let second = second.expect("the second window opens");
    std::fs::write(fixture.checkout.join("big.bin"), "small now\n").expect("the file shrinks");
    for window in [&first, &second] {
        fixture.windows.command_began(window, true).await;
    }
    let exited = CommandWindowEnd::Exited {
        exit_code: Some(0),
        signal: None,
    };
    fixture.windows.close_window(first.clone(), exited).await;
    fixture.close(second.clone(), exited).await;

    assert_eq!(fixture.covered(&first), Some(1));
    assert_eq!(fixture.covered(&second), Some(1));
    let shadows = fixture.shadows_of("big.bin");
    assert!(
        shadows.iter().all(|(_, _, is_current)| !is_current),
        "nothing current is left for the path: {shadows:?}"
    );
    assert!(
        shadows.len() <= 1,
        "one shadow was taken and retired: {shadows:?}"
    );
}

// Killed by skipping the settle, or by settling a window as covered.
#[tokio::test]
async fn windows_a_stop_left_open_are_settled_uncovered_at_start() {
    let fixture = Fixture::with_repository(&[]).await;
    let window_id = CommandWindowId::mint();
    let shadow = Shadow {
        shadow_id: ShadowId::mint(),
        session_id: fixture.session_id,
        path: fixture.recorded("big.bin"),
        content: ShadowContent::NotKept {
            reason: NotKeptReason::TooLarge,
        },
        facts: None,
        taken_at: jiff::Timestamp::now(),
        time_precision: Duration::from_secs(1),
    };
    fixture
        .log
        .writer
        .write(vec![
            open_command_window_statement(&bare_opening(
                window_id,
                fixture.checkpoint_id.clone(),
                fixture.start(),
            )),
            insert_current_shadow_statement(&shadow),
            link_window_shadow_statement(window_id, shadow.shadow_id),
        ])
        .await
        .expect("the open window is written");

    let settled = fixture
        .windows
        .settle_open_windows()
        .await
        .expect("the open windows settle");

    assert_eq!(settled, 1);
    let window = PortWindowId::new(window_id.text().as_str().to_owned());
    assert_eq!(fixture.covered(&window), Some(0));
    let links: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM checkpoint_window_shadows WHERE window_id = ?1",
            [window.as_str()],
            |row| row.get(0),
        )
        .expect("the links count");
    assert_eq!(links, 0);
}

// Killed by no row, by the tool call dropped, by the window left open, and by a row written with no
// checkpoint.
#[rstest]
#[case::under_the_checkpoint(true)]
#[case::no_checkpoint(false)]
#[tokio::test]
async fn a_command_no_window_covered_is_recorded_uncovered(#[case] has_checkpoint: bool) {
    let fixture = if has_checkpoint {
        Fixture::with_repository(&[]).await
    } else {
        let root = tempfile::tempdir().expect("the test makes its folder");
        let checkout = root.path().join("checkout");
        Fixture::open(root, test_git_runner(), checkout).await
    };
    let tool_call_id = ToolCallId::new("toolu_1".to_owned()).expect("a call id");

    fixture
        .windows
        .record_uncovered_command(CommandWindowStart {
            tool_call_id: Some(tool_call_id.clone()),
            ..fixture.start()
        })
        .await;
    fixture.windows.stop().await;

    let rows: i64 = fixture
        .database
        .reader()
        .query_row("SELECT COUNT(*) FROM checkpoint_commands", [], |row| {
            row.get(0)
        })
        .expect("the windows count");
    assert_eq!(rows, i64::from(has_checkpoint));
    let uncovered = uncovered_commands(
        &fixture.database.reader(),
        fixture.session_id,
        SafeInt::ZERO,
    )
    .expect("the uncovered commands read");
    let named: Vec<_> = uncovered
        .iter()
        .map(|command| (command.command.as_str(), command.tool_call_id.as_ref()))
        .collect();
    let expected = if has_checkpoint {
        vec![("npm test", Some(&tool_call_id))]
    } else {
        Vec::new()
    };
    assert_eq!(named, expected);
    for command in &uncovered {
        let window = PortWindowId::new(command.window_id.text().as_str().to_owned());
        assert_eq!(fixture.covered(&window), Some(0));
    }
}
