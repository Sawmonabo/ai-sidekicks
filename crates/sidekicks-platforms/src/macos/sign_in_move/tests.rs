//! The macOS sign-in move run against a stand-in for the keychain tool, and the tool's line, print
//! and exit rules the move keeps.

use std::fs;
use std::io::{self, Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::Duration;

use rstest::rstest;
use secrecy::zeroize::Zeroizing;

use super::keychain_item::{
    AddForm, INTERACTIVE_LINE_LIMIT, ToolAnswer, add_form, item_from_printed, tool_answer,
};
use super::{SignInMove, sign_in_move};
use crate::spawner::Spawner;
use crate::test_program::{harness_test_name, this_test_arguments};
use crate::{KeychainItemRefusal, KeychainSignIn, SignInMoveError};

const SERVICE: &str = "Provider-credentials-test";

// A bound no step of a test's move nears.
const STEP_BOUND: Duration = Duration::from_secs(60);

// The variable naming the stand-in's keychain folder on its first line and a switch on each line
// after: `locked-once:<account>` answers the first call on that account as a locked keychain,
// `delete-locked:<account>` answers every delete of that account's item as a locked keychain,
// `keep-changed` keeps every added value with its last byte dropped, and `sleep` sleeps before
// answering, its process id written to the folder's `pid` file.
const STAND_IN_VARIABLE: &str = "SIDEKICKS_SECURITY_STAND_IN";

// The test whose body is the keychain tool's stand-in.
const STAND_IN_TEST: &str = "the_keychain_tool_stand_in";

// The tool's exits the stand-in answers with.
const ITEM_NOT_FOUND: i32 = 44;
const KEYCHAIN_LOCKED: i32 = 36;

// A stand-in keychain: a folder of items, one file each, and a script that runs this test program
// as `security` over it, the harness's own output sent away and the tool's on descriptor 3 put in
// its place.
struct StandInKeychain {
    folder: tempfile::TempDir,
    program: PathBuf,
}

impl StandInKeychain {
    fn new(switches: &[&str]) -> Self {
        let folder = tempfile::tempdir().expect("the keychain's folder is made");
        let folder_text = folder.path().to_str().expect("the folder's path is text");
        let test_program = std::env::current_exe().expect("the test program names itself");
        let test_program = test_program
            .to_str()
            .expect("the test program's path is text");
        let variable = std::iter::once(folder_text)
            .chain(switches.iter().copied())
            .collect::<Vec<_>>()
            .join("\n");
        let name = harness_test_name(module_path!(), STAND_IN_TEST);
        let harness_arguments = this_test_arguments(&name);
        for word in [variable.as_str(), test_program]
            .into_iter()
            .chain(harness_arguments)
        {
            assert!(!word.contains('\''), "a script word holds no single quote");
        }
        let script = format!(
            "#!/bin/sh\n{STAND_IN_VARIABLE}='{variable}'\nexport {STAND_IN_VARIABLE}\n\
             exec '{test_program}' '{}' -- \"$@\" 3>&1 1>/dev/null\n",
            harness_arguments.join("' '"),
        );
        let program = folder.path().join("security");
        fs::write(&program, script).expect("the stand-in's script is written");
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755))
            .expect("the stand-in's script runs");
        Self { folder, program }
    }

    fn sign_in_move(&self) -> SignInMove {
        SignInMove {
            security_program: self.program.clone(),
        }
    }

    fn item(&self, sign_in: &KeychainSignIn) -> Option<Vec<u8>> {
        fs::read(item_path(
            self.folder.path(),
            &sign_in.service,
            &sign_in.account,
        ))
        .ok()
    }

    fn put_item(&self, sign_in: &KeychainSignIn, value: &str) {
        fs::write(
            item_path(self.folder.path(), &sign_in.service, &sign_in.account),
            value,
        )
        .expect("the item is written");
    }
}

// The file holding the item filed under `service` and `account`.
fn item_path(folder: &Path, service: &str, account: &str) -> PathBuf {
    folder.join(format!(
        "item-{}-{}",
        base16ct::lower::encode_string(service.as_bytes()),
        base16ct::lower::encode_string(account.as_bytes())
    ))
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
        let item = keychain.item(sign_in);
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
    let keychain = StandInKeychain::new(&[]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let sign_ins = two_sign_ins(folder.path());
    for sign_in in &sign_ins {
        keychain.put_item(sign_in, &sign_in_text(sign_in));
    }
    let mover = keychain.sign_in_move();
    let spawner = spawner();

    mover
        .move_into_files(&spawner, &sign_ins, STEP_BOUND)
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
        .move_into_keychain(&spawner, &sign_ins, STEP_BOUND)
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
    let keychain = StandInKeychain::new(&["locked-once:second"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let sign_ins = two_sign_ins(folder.path());
    for sign_in in &sign_ins {
        keychain.put_item(sign_in, &sign_in_text(sign_in));
    }
    let mover = keychain.sign_in_move();
    let spawner = spawner();

    let stopped = mover.move_into_files(&spawner, &sign_ins, STEP_BOUND).await;

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
        .move_into_files(&spawner, &sign_ins, STEP_BOUND)
        .await
        .expect("the next call finishes the move");
    assert_each_held_once(&keychain, &sign_ins, true);

    // Stopped after the first copy reached the keychain and before its file was deleted.
    let [first, _] = &sign_ins;
    keychain.put_item(first, &sign_in_text(first));
    mover
        .move_into_keychain(&spawner, &sign_ins, STEP_BOUND)
        .await
        .expect("the next call finishes the move back");
    assert_each_held_once(&keychain, &sign_ins, false);
}

/// A copy that reads back differently keeps its source, so no sign-in is lost to a keychain that
/// accepts a write but keeps something else, and the bad copy is deleted. Mutations: delete the
/// source before the copy is read back; leave the copy.
#[tokio::test]
async fn a_sign_in_move_keeps_the_source_when_its_copy_reads_back_differently() {
    let keychain = StandInKeychain::new(&["keep-changed"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");

    let refused = keychain
        .sign_in_move()
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
    assert_eq!(keychain.item(&sign_in), None, "the bad copy is deleted");
    let refusal = refused.expect_err("the move is refused");
    let shown = format!("{refusal} {refusal:?}");
    assert!(!shown.contains("secret-of-"), "{shown}");
}

/// A move into the files whose delete of the keychain item is refused, after its file was written,
/// deletes that file, since the item still holds the sign-in, so none is left in a plain file the
/// person never chose. Killed by the copy left in its file.
#[tokio::test]
async fn a_sign_in_move_refused_after_its_copy_deletes_the_copy() {
    let keychain = StandInKeychain::new(&["delete-locked:first"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    keychain.put_item(&sign_in, &sign_in_text(&sign_in));

    let refused = keychain
        .sign_in_move()
        .move_into_files(&spawner(), std::slice::from_ref(&sign_in), STEP_BOUND)
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
    assert_each_held_once(&keychain, std::slice::from_ref(&sign_in), false);
}

/// A keychain read that has not answered by its bound stops the move: no file is written, the
/// item stays, and the tool's process is gone once the move returns. Killed by a move that
/// carries on past the bound, and by one that leaves the tool running.
#[tokio::test]
async fn a_step_past_its_bound_stops_the_move_and_ends_its_child() {
    let keychain = StandInKeychain::new(&["sleep"]);
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let [sign_in, _] = two_sign_ins(folder.path());
    keychain.put_item(&sign_in, &sign_in_text(&sign_in));

    let stopped = keychain
        .sign_in_move()
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
    let pid = fs::read_to_string(keychain.folder.path().join("pid"))
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
/// more takes the arguments. Mutations: an unescaped quote; the bound off by one.
#[test]
fn the_add_line_quotes_its_names_and_keeps_within_the_tools_line() {
    let service = r#"Provider "quoted" \ service"#;
    let account = r"person\";
    let Ok(AddForm::Line(line)) = add_form(service, account, "00ff") else {
        unreachable!("a short add is a line");
    };
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

    let Ok(AddForm::Line(empty)) = add_form(SERVICE, "person", "") else {
        unreachable!("an empty add is a line");
    };
    let at_bound = "a".repeat(INTERACTIVE_LINE_LIMIT - empty.len());
    let Ok(AddForm::Line(longest)) = add_form(SERVICE, "person", &at_bound) else {
        unreachable!("a line at the bound goes on standard input");
    };
    assert_eq!(longest.len(), INTERACTIVE_LINE_LIMIT);
    let past_bound = format!("{at_bound}a");
    assert!(matches!(
        add_form(SERVICE, "person", &past_bound),
        Ok(AddForm::Arguments)
    ));
    for name in ["line\nbreak", "nul\0byte"] {
        assert!(matches!(
            add_form(SERVICE, name, "00"),
            Err(KeychainItemRefusal::UnwritableName)
        ));
    }
}

/// The item is read back whether the tool printed it as it is or as hex, with only the tool's
/// one newline dropped. Killed by hex never decoded, by printable hex decoded, and by a trim in
/// place of the one newline.
#[rstest]
#[case::json_text(b"{\"token\":\"t\"}\n".to_vec(), b"{\"token\":\"t\"}".to_vec())]
#[case::json_past_ascii_as_hex(
    format!("{}\n", base16ct::lower::encode_string("{\"note\":\"café\"}".as_bytes())).into_bytes(),
    "{\"note\":\"café\"}".as_bytes().to_vec()
)]
#[case::printable_hex_kept_as_text(b"7b7d\n".to_vec(), b"7b7d".to_vec())]
#[case::trailing_space_kept(b"{} \n".to_vec(), b"{} ".to_vec())]
#[case::own_newline_kept(b"{}\n\n".to_vec(), b"{}\n".to_vec())]
fn a_read_takes_the_items_bytes_whether_printed_raw_or_as_hex(
    #[case] printed: Vec<u8>,
    #[case] item: Vec<u8>,
) {
    assert_eq!(item_from_printed(&printed), Zeroizing::new(item));
}

/// The tool's exits read as the keychain's answers: 44 is no item, which a read answers as none
/// and a delete as done, 36 a locked keychain, 37 and 50 no login keychain, and any other end its
/// own. Mutation: 44 read as a failure.
#[test]
fn the_tools_exit_codes_read_as_the_keychains_answers() {
    let exited = |code: i32| ExitStatus::from_raw(code << 8);
    assert_eq!(tool_answer(exited(0)).ok(), Some(ToolAnswer::Done));
    assert_eq!(tool_answer(exited(44)).ok(), Some(ToolAnswer::NoItem));
    assert!(matches!(
        tool_answer(exited(36)),
        Err(KeychainItemRefusal::Locked)
    ));
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

/// The keychain tool's stand-in, run as `security` through the script a move test writes, its
/// keychain the folder `STAND_IN_VARIABLE` names; it does nothing in any other run.
#[test]
#[ignore = "run only as the keychain tool's stand-in, through the script a move test writes"]
#[expect(
    clippy::exit,
    reason = "the tool's exit code is what the move reads, where the harness would exit with its own"
)]
fn the_keychain_tool_stand_in() {
    let Some(variable) = std::env::var_os(STAND_IN_VARIABLE) else {
        return;
    };
    let variable = variable.into_string().expect("the variable is text");
    let mut lines = variable.lines();
    let folder = PathBuf::from(
        lines
            .next()
            .expect("the variable names the keychain's folder"),
    );
    let switches: Vec<&str> = lines.collect();
    let arguments: Vec<String> = std::env::args()
        .skip_while(|argument| argument != "--")
        .skip(1)
        .collect();
    std::process::exit(answer_as_security(&folder, &switches, &arguments));
}

// Answers one call of the keychain tool over the items in `folder`, as `security` answers it, and
// gives its exit code.
fn answer_as_security(folder: &Path, switches: &[&str], arguments: &[String]) -> i32 {
    if switches.contains(&"sleep") {
        fs::write(folder.join("pid"), std::process::id().to_string()).expect("the pid is written");
        std::thread::sleep(Duration::from_secs(120));
    }
    let words = if arguments.first().is_some_and(|word| word == "-i") {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .expect("the input reads");
        assert!(
            input.len() <= INTERACTIVE_LINE_LIMIT,
            "one line within the tool's bound"
        );
        let line = input
            .strip_suffix('\n')
            .expect("the line ends with a newline");
        assert!(!line.contains('\n'), "the input is one line");
        split_line(line)
    } else {
        arguments.to_vec()
    };
    let (command, options) = words.split_first().expect("the call names a command");
    let option = |flag: &str| {
        let at = options.iter().position(|word| word == flag)?;
        options.get(at + 1).cloned()
    };
    let service = option("-s").expect("the call names a service");
    let account = option("-a").expect("the call names an account");
    let locked_once = switches
        .iter()
        .find_map(|switch| switch.strip_prefix("locked-once:"));
    if locked_once == Some(account.as_str())
        && fs::File::create_new(folder.join("locked-once-answered")).is_ok()
    {
        return KEYCHAIN_LOCKED;
    }
    let item = item_path(folder, &service, &account);
    match command.as_str() {
        "find-generic-password" => {
            assert!(
                options.iter().any(|word| word == "-w"),
                "the read prints the item"
            );
            let value = match fs::read(&item) {
                Ok(value) => value,
                Err(missing) => {
                    assert_eq!(missing.kind(), io::ErrorKind::NotFound, "the item reads");
                    return ITEM_NOT_FOUND;
                }
            };
            let mut printed = if value.iter().all(|byte| (0x20..=0x7E).contains(byte)) {
                value
            } else {
                base16ct::lower::encode_string(&value).into_bytes()
            };
            printed.push(b'\n');
            fs::OpenOptions::new()
                .write(true)
                .open("/dev/fd/3")
                .and_then(|mut output| output.write_all(&printed))
                .expect("the item is printed");
            0
        }
        "add-generic-password" => {
            assert!(options.iter().any(|word| word == "-U"), "the add updates");
            let hex = option("-X").expect("the add carries the value as hex");
            let mut value = base16ct::lower::decode_vec(hex).expect("the value is lowercase hex");
            if switches.contains(&"keep-changed") {
                value.pop();
            }
            fs::write(&item, value).expect("the item is written");
            0
        }
        "delete-generic-password"
            if switches
                .iter()
                .any(|switch| switch.strip_prefix("delete-locked:") == Some(account.as_str())) =>
        {
            KEYCHAIN_LOCKED
        }
        "delete-generic-password" => match fs::remove_file(&item) {
            Ok(()) => 0,
            Err(missing) => {
                assert_eq!(
                    missing.kind(),
                    io::ErrorKind::NotFound,
                    "the item is removed"
                );
                ITEM_NOT_FOUND
            }
        },
        _ => 2,
    }
}

// Splits `line` into words as `security -i` does: whitespace between words, a word opened by `"`
// or `'` running to the same quote, and `\` taking the next character as it is.
fn split_line(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quote = None;
    let mut characters = line.chars();
    while let Some(character) = characters.next() {
        match (quote, character) {
            (_, '\\') => word.get_or_insert_default().extend(characters.next()),
            (Some(open), _) if character == open => {
                words.push(word.take().unwrap_or_default());
                quote = None;
            }
            (None, '"' | '\'') if word.is_none() => {
                quote = Some(character);
                word = Some(String::new());
            }
            (None, _) if character.is_whitespace() => words.extend(word.take()),
            _ => word.get_or_insert_default().push(character),
        }
    }
    words.extend(word);
    words
}
