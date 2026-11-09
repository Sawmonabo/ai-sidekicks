//! A stand-in for Apple's keychain tool that a test runs in its place: a folder of items, one file
//! each, and a script that runs the test's own program as `security` over it, its body
//! [`run_keychain_tool_stand_in`], each call's arguments recorded. Only macOS runs the tool, so
//! elsewhere the stand-in's folder holds items no move or read reaches.

use std::fs;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::SignInMove;
use crate::test_program::this_test_arguments;

// The variable naming the stand-in's keychain folder on its first line and a switch on each line
// after: `locked-once:<account>` answers the first call on that account as a locked keychain,
// `delete-locked:<account>` answers every delete of that account's item as a locked keychain,
// `keep-changed` keeps every added value with its last byte dropped, and `sleep` sleeps before
// answering, its process id written to the folder's `pid` file.
const STAND_IN_VARIABLE: &str = "SIDEKICKS_SECURITY_STAND_IN";

// The file in the folder each call appends its arguments to, one call a line, tab-separated.
const CALLS_FILE: &str = "calls";

// The stand-in's script in its folder.
const PROGRAM_FILE: &str = "security";

// The tool's exits the stand-in answers with: no such item, and a locked keychain.
const ITEM_NOT_FOUND: i32 = 44;
const KEYCHAIN_LOCKED: i32 = 36;

/// A stand-in keychain over a folder of its own, removed when dropped.
pub struct StandInKeychain {
    folder: tempfile::TempDir,
}

impl StandInKeychain {
    /// A keychain whose tool is this test program run with only `stand_in_test`, the harness's
    /// name for a test whose body is [`run_keychain_tool_stand_in`], answering as `switches` say
    /// (see the module's variable). Panics where its folder or script cannot be written.
    pub fn new(stand_in_test: &str, switches: &[&str]) -> Self {
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
        let harness_arguments = this_test_arguments(stand_in_test);
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
        let program = folder.path().join(PROGRAM_FILE);
        fs::write(&program, script).expect("the stand-in's script is written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755))
                .expect("the stand-in's script runs");
        }
        Self { folder }
    }

    /// The sign-in move, and its item reads and deletes, through this stand-in in place of
    /// Apple's tool; `None` where the system has no move.
    pub fn sign_in_move(&self) -> Option<SignInMove> {
        #[cfg(target_os = "macos")]
        {
            Some(SignInMove::over_program(
                self.folder.path().join(PROGRAM_FILE),
            ))
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    /// The folder the items, the calls' record and a sleeping call's `pid` file are kept in.
    pub fn folder(&self) -> &Path {
        self.folder.path()
    }

    /// The value of the item filed under `service` and `account`, `None` where there is none.
    pub fn item(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        fs::read(item_path(self.folder.path(), service, account)).ok()
    }

    /// Files `value` under `service` and `account`, in place of any value there.
    pub fn put_item(&self, service: &str, account: &str, value: &[u8]) {
        fs::write(item_path(self.folder.path(), service, account), value)
            .expect("the item is written");
    }

    /// The arguments of every call the tool answered, in order; none before the first call.
    pub fn calls(&self) -> Vec<Vec<String>> {
        let recorded = fs::read_to_string(self.folder.path().join(CALLS_FILE))
            .or_else(|failure| {
                if failure.kind() == io::ErrorKind::NotFound {
                    Ok(String::new())
                } else {
                    Err(failure)
                }
            })
            .expect("the calls' record reads");
        recorded
            .lines()
            .map(|call| call.split('\t').map(str::to_owned).collect())
            .collect()
    }
}

/// The body of the test a [`StandInKeychain`] runs as `security`: answers the call its arguments
/// after `--` make over the folder the stand-in's variable names, and exits with the tool's code;
/// in any other run, where that variable is unset, it does nothing.
#[expect(
    clippy::exit,
    reason = "the tool's exit code is what the caller reads, where the harness would exit with \
              its own"
)]
pub fn run_keychain_tool_stand_in() {
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
    let mut calls = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder.join(CALLS_FILE))
        .expect("the calls' record opens");
    writeln!(calls, "{}", arguments.join("\t")).expect("the call is recorded");
    std::process::exit(answer_as_security(&folder, &switches, &arguments));
}

// The file holding the item filed under `service` and `account`.
fn item_path(folder: &Path, service: &str, account: &str) -> PathBuf {
    folder.join(format!(
        "item-{}-{}",
        base16ct::lower::encode_string(service.as_bytes()),
        base16ct::lower::encode_string(account.as_bytes())
    ))
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
        #[cfg(target_os = "macos")]
        assert!(
            input.len() <= crate::macos::sign_in_move::INTERACTIVE_LINE_LIMIT,
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

/// Splits `line` into words as `security -i` does: whitespace between words, a word opened by `"`
/// or `'` running to the same quote, and `\` taking the next character as it is.
pub(crate) fn split_line(line: &str) -> Vec<String> {
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
