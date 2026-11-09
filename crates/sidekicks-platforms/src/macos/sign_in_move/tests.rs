//! The macOS sign-in move run against a stand-in for the keychain tool, and the tool's line, print
//! and exit rules the move keeps.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::process::ExitStatus;
use std::time::Duration;

use rstest::rstest;

use super::sign_in_move;
use crate::macos::keychain_tool::{INTERACTIVE_LINE_LIMIT, ToolAnswer, add_line, tool_answer};
use crate::spawner::Spawner;
use crate::stand_in_keychain::split_line;
use crate::test_program::harness_test_name;
use crate::{
    CopyLeftCause, KeychainItemRefusal, KeychainSignIn, SignInMoveError, StandInKeychain,
    run_keychain_tool_stand_in,
};

const SERVICE: &str = "Provider-credentials-test";

// A bound no step of a test's move nears.
const STEP_BOUND: Duration = Duration::from_secs(60);

// The test whose body is the keychain tool's stand-in.
const STAND_IN_TEST: &str = "the_keychain_tool_stand_in";

// A stand-in keychain answering as `switches` say, its tool this module's stand-in test.
fn stand_in_keychain(switches: &[&str]) -> StandInKeychain {
    StandInKeychain::new(&harness_test_name(module_path!(), STAND_IN_TEST), switches)
}

// Two sign-ins, each filed under its own account and moving to its own file in `folder`, whose
// folder is made.
fn two_sign_ins(folder: &Path) -> [KeychainSignIn; 2] {
    ["first", "second"].map(|account| {
        let file = folder.join(account).join(".credentials.json");
        fs::create_dir(file.parent().expect("a file has a folder"))
            .expect("the store folder is made");
        KeychainSignIn {
            service: SERVICE.to_owned(),
            account: account.to_owned(),
            file,
        }
    })
}

// A sign-in's text, holding a byte past 0x7E so the tool prints it as hex.
fn sign_in_text(sign_in: &KeychainSignIn) -> String {
    format!(
        "{{\"token\":\"secret-of-{}\",\"note\":\"café\"}}",
        sign_in.account
    )
}

// Each sign-in is held exactly once, in its file when `in_files`, else in its item, with the text
// it started with.
fn assert_each_held_once(keychain: &StandInKeychain, sign_ins: &[KeychainSignIn], in_files: bool) {
    for sign_in in sign_ins {
        let item = keychain.item(&sign_in.service, &sign_in.account);
        let file = fs::read(&sign_in.file).ok();
        let expected = Some(sign_in_text(sign_in).into_bytes());
        if in_files {
            assert_eq!((item, file), (None, expected), "{}", sign_in.account);
        } else {
            assert_eq!((item, file), (expected, None), "{}", sign_in.account);
        }
    }
}

fn spawner() -> Spawner {
    Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts")
}

/// The move into files leaves each sign-in in its file at mode 0600 and its item gone, and the
/// move back reverses it. Mutations: write the file at 0644; skip the source's delete.
#[tokio::test]
async fn the_sign_in_move_puts_each_sign_in_in_a_private_file_and_back() {
    let keychain = stand_in_keychain(&[]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let sign_ins = two_sign_ins(folder.path());
    for sign_in in &sign_ins {
        keychain.put_item(
            &sign_in.service,
            &sign_in.account,
            sign_in_text(sign_in).as_bytes(),
        );
    }
    let mover = keychain.sign_in_move().expect("macOS supplies the move");

    mover
        .move_into_files(&spawner(), &sign_ins, STEP_BOUND)
        .await
        .expect("the sign-ins move into files");

    assert_each_held_once(&keychain, &sign_ins, true);
    for sign_in in &sign_ins {
        let mode = fs::metadata(&sign_in.file)
            .expect("the file is there")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{}", sign_in.account);
    }

    mover
        .move_into_keychain(&spawner(), &sign_ins, STEP_BOUND)
        .await
        .expect("the sign-ins move back");

    assert_each_held_once(&keychain, &sign_ins, false);
}

/// A move stopped by a locked keychain after one sign-in, and one stopped between a copy and its
/// source's delete, each finish on the next call with every sign-in held exactly once. Mutations:
/// refuse a sign-in whose source is already gone; skip a sign-in whose destination already holds
/// it.
#[tokio::test]
async fn a_stopped_sign_in_move_finishes_on_the_next_call() {
    let keychain = stand_in_keychain(&["locked-once:second"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let sign_ins = two_sign_ins(folder.path());
    for sign_in in &sign_ins {
        keychain.put_item(
            &sign_in.service,
            &sign_in.account,
            sign_in_text(sign_in).as_bytes(),
        );
    }
    let mover = keychain.sign_in_move().expect("macOS supplies the move");

    let stopped = mover
        .move_into_files(&spawner(), &sign_ins, STEP_BOUND)
        .await;

    let stopped_at = match &stopped {
        Err(SignInMoveError::Keychain {
            account,
            refusal: KeychainItemRefusal::Locked,
            ..
        }) => Some(account.as_str()),
        _ => None,
    };
    assert_eq!(stopped_at, Some("second"), "{stopped:?}");
    mover
        .move_into_files(&spawner(), &sign_ins, STEP_BOUND)
        .await
        .expect("the next call finishes the move");
    assert_each_held_once(&keychain, &sign_ins, true);

    // Stopped after the first copy reached the keychain and before its file was deleted.
    let [first, _] = &sign_ins;
    keychain.put_item(
        &first.service,
        &first.account,
        sign_in_text(first).as_bytes(),
    );
    mover
        .move_into_keychain(&spawner(), &sign_ins, STEP_BOUND)
        .await
        .expect("the next call finishes the move back");
    assert_each_held_once(&keychain, &sign_ins, false);
}

/// A copy that reads back differently keeps its source, so no sign-in is lost to a keychain that
/// accepts a write but keeps something else, and the bad copy is deleted. Mutations: delete the
/// source before the copy is read back; leave the copy.
#[tokio::test]
async fn a_sign_in_move_keeps_the_source_when_its_copy_reads_back_differently() {
    let keychain = stand_in_keychain(&["keep-changed"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");

    let refused = keychain
        .sign_in_move()
        .expect("macOS supplies the move")
        .move_into_keychain(&spawner(), std::slice::from_ref(&sign_in), STEP_BOUND)
        .await;

    assert!(
        matches!(refused, Err(SignInMoveError::CopyDiffers { .. })),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(&sign_in.file).ok(),
        Some(sign_in_text(&sign_in)),
        "the source file stays"
    );
    assert_eq!(
        keychain.item(&sign_in.service, &sign_in.account),
        None,
        "the bad copy is deleted"
    );
    let refusal = refused.expect_err("the move is refused");
    let shown = format!("{refusal} {refusal:?}");
    assert!(!shown.contains("secret-of-"), "{shown}");
}

/// A move refused after its copy was written takes the copy back where the source still holds
/// the sign-in: into the files, the item's delete refused, the file is deleted and the item stays
/// whole. Moving back into the keychain with the file's delete refused and the copy's delete
/// refused too, both stay and the refusal names the copy left and the delete that kept it. Killed
/// by the copy left in its file, and by the copy's delete failure dropped.
#[rstest]
#[case::copy_taken_back(true)]
#[case::copy_delete_refused(false)]
#[tokio::test]
async fn a_sign_in_move_refused_after_its_copy_takes_the_copy_back(#[case] is_toward_files: bool) {
    let keychain = stand_in_keychain(&["delete-locked:first"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    let sign_ins = std::slice::from_ref(&sign_in);
    let mover = keychain.sign_in_move().expect("macOS supplies the move");
    if is_toward_files {
        keychain.put_item(
            &sign_in.service,
            &sign_in.account,
            sign_in_text(&sign_in).as_bytes(),
        );
        let refused = mover
            .move_into_files(&spawner(), sign_ins, STEP_BOUND)
            .await;

        assert!(
            matches!(
                refused,
                Err(SignInMoveError::Keychain {
                    refusal: KeychainItemRefusal::Locked,
                    ..
                })
            ),
            "{refused:?}"
        );
        assert_each_held_once(&keychain, sign_ins, false);
        return;
    }
    fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");
    let file_folder = sign_in.file.parent().expect("a file has a folder");
    // A folder its owner cannot write keeps the file from being deleted.
    fs::set_permissions(file_folder, fs::Permissions::from_mode(0o500))
        .expect("the folder is made read-only");
    let refused = mover
        .move_into_keychain(&spawner(), sign_ins, STEP_BOUND)
        .await;
    fs::set_permissions(file_folder, fs::Permissions::from_mode(0o700))
        .expect("the folder is made writable again");

    let refusal = refused.expect_err("the file's delete is refused");
    let shown = refusal.to_string();
    assert!(
        matches!(
            &refusal,
            SignInMoveError::CopyLeft {
                cause: CopyLeftCause::CopyUndeletable(failure),
                refusal,
                ..
            } if matches!(**failure, SignInMoveError::Keychain {
                refusal: KeychainItemRefusal::Locked,
                ..
            }) && matches!(**refusal, SignInMoveError::File(_))
        ),
        "{refusal:?}"
    );
    assert!(shown.contains("the copy could not be deleted"), "{shown}");
    assert_eq!(
        keychain.item(&sign_in.service, &sign_in.account),
        Some(sign_in_text(&sign_in).into_bytes())
    );
    assert_eq!(
        fs::read_to_string(&sign_in.file).ok(),
        Some(sign_in_text(&sign_in))
    );
}

/// A keychain read that has not answered by its bound stops the move: no file is written, the
/// item stays, and the tool's process is gone once the move returns. Killed by a move that
/// carries on past the bound, and by one that leaves the tool running.
#[tokio::test]
async fn a_step_past_its_bound_stops_the_move_and_ends_its_child() {
    let keychain = stand_in_keychain(&["sleep"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    keychain.put_item(
        &sign_in.service,
        &sign_in.account,
        sign_in_text(&sign_in).as_bytes(),
    );

    let stopped = keychain
        .sign_in_move()
        .expect("macOS supplies the move")
        .move_into_files(
            &spawner(),
            std::slice::from_ref(&sign_in),
            Duration::from_secs(5),
        )
        .await;

    assert!(
        matches!(stopped, Err(SignInMoveError::Overran)),
        "{stopped:?}"
    );
    assert!(!sign_in.file.exists(), "no file is written past the bound");
    assert_each_held_once(&keychain, std::slice::from_ref(&sign_in), false);
    let pid = fs::read_to_string(keychain.folder().join("pid"))
        .expect("the stand-in wrote its process id before sleeping");
    let pid = nix::unistd::Pid::from_raw(pid.parse().expect("the process id is a number"));
    assert_eq!(
        nix::sys::signal::kill(pid, None),
        Err(nix::errno::Errno::ESRCH),
        "the tool's process is gone"
    );
}

/// A name's `"` and `\` are escaped so the tool's line reader reads the name back whole, and a
/// line of exactly the tool's bound, its newline included, goes on standard input while one byte
/// more is no line at all. Mutations: an unescaped quote; the bound off by one.
#[test]
fn the_add_line_quotes_its_names_and_keeps_within_the_tools_line() {
    let service = r#"Provider "quoted" \ service"#;
    let account = r"person\";
    let line = add_line(&["-U"], service, account, "00ff")
        .expect("the names are writable")
        .expect("a short add is a line");
    let line_text = std::str::from_utf8(&line).expect("the line is text");
    assert_eq!(
        line_text,
        "add-generic-password -U -a \"person\\\\\" -s \"Provider \\\"quoted\\\" \\\\ service\" \
         -X \"00ff\"\n"
    );
    let words = split_line(line_text.trim_end_matches('\n'));
    assert_eq!(
        words,
        [
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            service,
            "-X",
            "00ff"
        ]
    );

    let line_of =
        |hex: &str| add_line(&["-U"], SERVICE, "person", hex).expect("the names are writable");
    let empty = line_of("").expect("an empty add is a line");
    let at_bound = "a".repeat(INTERACTIVE_LINE_LIMIT - empty.len());
    let longest = line_of(&at_bound).expect("a line at the bound goes on standard input");
    assert_eq!(longest.len(), INTERACTIVE_LINE_LIMIT);
    assert!(line_of(&format!("{at_bound}a")).is_none());
    for name in ["line\nbreak", "nul\0byte"] {
        assert!(matches!(
            add_line(&["-U"], SERVICE, name, "00"),
            Err(KeychainItemRefusal::UnwritableName)
        ));
    }
}

/// A sign-in too long for the tool's input line is refused by a move into the keychain and stays
/// in its file, with nothing sent to the tool. Mutation: the add sent as arguments past the line.
#[tokio::test]
async fn a_sign_in_past_the_tools_line_stays_in_its_file() {
    let keychain = stand_in_keychain(&[]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    let long = "x".repeat(INTERACTIVE_LINE_LIMIT);
    fs::write(&sign_in.file, &long).expect("the sign-in file is written");

    let refused = keychain
        .sign_in_move()
        .expect("macOS supplies the move")
        .move_into_keychain(&spawner(), std::slice::from_ref(&sign_in), STEP_BOUND)
        .await;

    assert!(
        matches!(
            refused,
            Err(SignInMoveError::TooLongForTheKeychainTool { .. })
        ),
        "{refused:?}"
    );
    assert_eq!(fs::read_to_string(&sign_in.file).ok(), Some(long));
    assert_eq!(keychain.item(&sign_in.service, &sign_in.account), None);
    assert!(keychain.calls().is_empty(), "{:?}", keychain.calls());
}

/// The tool's exits read as the keychain's answers: 44 is no item, which a read answers as none
/// and a delete as done, 36 a locked keychain and 128 its prompt dismissed, both locked, 37 and 50
/// no login keychain, and any other end its own. Mutations: 44 read as a failure; 128 read as an
/// end of its own.
#[test]
fn the_tools_exit_codes_read_as_the_keychains_answers() {
    let exited = |code: i32| ExitStatus::from_raw(code << 8);
    assert_eq!(tool_answer(exited(0)).ok(), Some(ToolAnswer::Done));
    assert_eq!(tool_answer(exited(44)).ok(), Some(ToolAnswer::NoItem));
    for code in [36, 128] {
        assert!(matches!(
            tool_answer(exited(code)),
            Err(KeychainItemRefusal::Locked)
        ));
    }
    for code in [37, 50] {
        assert!(matches!(
            tool_answer(exited(code)),
            Err(KeychainItemRefusal::NoLoginKeychain)
        ));
    }
    for status in [exited(1), ExitStatus::from_raw(libc::SIGKILL)] {
        assert!(matches!(
            tool_answer(status),
            Err(KeychainItemRefusal::Ended(ended)) if ended == status
        ));
    }
}

/// The leftover a move stopped mid-write left beside a sign-in file is swept, while the sign-in
/// file and another target's leftover stay. Killed by a sweep that misses the leftover, and by
/// one that takes files of other targets.
#[test]
fn a_stopped_moves_leftover_is_swept() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    let store_folder = sign_in.file.parent().expect("a file has a folder");
    fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");
    let leftover = store_folder.join(".credentials.json.a1b2c3.tmp");
    let other = store_folder.join("settings.json.d4e5f6.tmp");
    for path in [&leftover, &other] {
        fs::write(path, sign_in_text(&sign_in)).expect("a temporary file is written");
    }

    let failures = sign_in_move()
        .expect("macOS supplies the move")
        .remove_leftovers(std::slice::from_ref(&sign_in.file));

    assert!(failures.is_empty(), "{failures:?}");
    assert!(!leftover.exists(), "the stopped move's leftover is gone");
    assert!(other.exists(), "another target's file stays");
    assert_eq!(
        fs::read_to_string(&sign_in.file).ok(),
        Some(sign_in_text(&sign_in))
    );
}

/// The keychain tool's stand-in, run as `security` through the script a move test writes; it
/// does nothing in any other run.
#[test]
#[ignore = "run only as the keychain tool's stand-in, through the script a move test writes"]
fn the_keychain_tool_stand_in() {
    run_keychain_tool_stand_in();
}
