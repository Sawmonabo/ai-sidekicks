//! A stand-in a test writes for another program: a script the system runs by name, whose
//! standard output, exit code, record of its arguments and environment, hold until the test
//! releases it, and wait on its first call, the test sets.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
use crate::posix::stand_in_program::write_stand_in_script;
#[cfg(windows)]
use crate::windows::stand_in_program::{read_recorded_argument, write_stand_in_script};

/// What a stand-in program does for one call: appends each argument, then the value of each
/// variable `recorded_environment` names, to `argument_record` where one is set; waits as `hold`
/// says where one is set; then prints `standard_output` byte for byte and exits with
/// `exit_code`.
#[derive(Default)]
pub struct StandInAnswer {
    /// The exact text the program prints, nothing added.
    pub standard_output: String,
    /// The code the program exits with.
    pub exit_code: u8,
    /// The file each argument of the call is appended to, for [`read_recorded_arguments`].
    pub argument_record: Option<PathBuf>,
    /// The environment variables, each a plain name of letters, digits and `_`, whose values are
    /// appended to `argument_record` after the arguments, in order, an unset one as empty.
    pub recorded_environment: Vec<String>,
    /// Where the call waits for the test once it recorded.
    pub hold: Option<StandInHold>,
}

/// A call held until the test releases it: once recorded, it makes `waiting`, then waits until
/// `release` exists.
pub struct StandInHold {
    /// The file the call makes once it recorded, which the test waits for.
    pub waiting: PathBuf,
    /// The file the test makes to let the call print and exit.
    pub release: PathBuf,
}

/// The answers of a stand-in program: the one paired with the first pair's word among a call's
/// arguments, wherever it stands, or `otherwise` for a call carrying none.
pub struct StandInProgram {
    /// Each word, a plain word of letters, digits, `-` and `_`, and its answer.
    pub answers_by_argument: Vec<(String, StandInAnswer)>,
    /// The answer to every other call.
    pub otherwise: StandInAnswer,
    /// How long the program's first call waits before it answers, its later calls answering at
    /// once; a file beside the program named `<name>.first-call` marks the first call made.
    pub first_call_wait: Option<Duration>,
}

/// Writes `program` in `folder` as a script the system's program search finds for `name`, and
/// answers its path, which [`program_start`](crate::program_start) starts: `name` itself,
/// executable, on macOS and Linux, and on Windows an npm-shaped shim `name.cmd` over a Node script.
/// Panics on a word or a variable name that is not plain; fails as the files fail to write, on a
/// path that is not UTF-8, and on Windows where this process finds no Node.
pub fn write_stand_in_program(
    folder: &Path,
    name: &str,
    program: &StandInProgram,
) -> io::Result<PathBuf> {
    let answers = program
        .answers_by_argument
        .iter()
        .map(|(_, answer)| answer)
        .chain([&program.otherwise]);
    for answer in answers {
        for variable in &answer.recorded_environment {
            assert!(
                is_plain(variable, "_"),
                "a stand-in's recorded variable is a plain name"
            );
        }
    }
    for (word, _) in &program.answers_by_argument {
        assert!(is_plain(word, "-_"), "a stand-in's word is a plain word");
    }
    write_stand_in_script(folder, name, program)
}

// Whether `text` is not empty and holds only letters, digits and the characters `also` names.
fn is_plain(text: &str, also: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || also.contains(character))
}

/// The lines a stand-in program appended to `record`, in the order its calls wrote them: each
/// call's arguments, then the values of the variables it records.
pub fn read_recorded_arguments(record: &Path) -> io::Result<Vec<String>> {
    let recorded = std::fs::read_to_string(record)?;
    #[cfg(unix)]
    let arguments = recorded.lines().map(str::to_owned).collect();
    #[cfg(windows)]
    let arguments = recorded
        .lines()
        .map(read_recorded_argument)
        .collect::<io::Result<_>>()?;
    Ok(arguments)
}

/// `path` as the text a script names it by. Fails with `InvalidInput` on a path that is not UTF-8.
pub(crate) fn script_path_text(path: &Path) -> io::Result<&str> {
    path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a path a stand-in names is not UTF-8",
        )
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use super::{
        StandInAnswer, StandInHold, StandInProgram, read_recorded_arguments, write_stand_in_program,
    };
    use crate::program_start;

    // Started as the daemon starts a program, through `program_start`. Killed by a line end after
    // the output (`printf '%s\n'`, or `console.log`), by a quote, percent or caret in the output
    // read as script text, by another exit code, by recording the arguments of a call its word
    // answered, by a word matched only as the first argument, by an argument recorded other than
    // as passed, by an empty line recorded for a call with no arguments (`printf '%s\n' "$@"`), by
    // a recorded variable left out or recorded before the arguments, and by a held call that
    // prints before its release.
    #[test]
    fn a_stand_in_program_prints_its_exact_answer_exits_with_its_code_and_records_its_call() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let record = folder.path().join("arguments");
        let (waiting, release) = (folder.path().join("waiting"), folder.path().join("release"));
        let listing = r#"[{"name": "it's ^ 100%"}]"#;
        let program = write_stand_in_program(
            folder.path(),
            "tool",
            &StandInProgram {
                answers_by_argument: vec![(
                    "list".to_owned(),
                    StandInAnswer {
                        standard_output: listing.to_owned(),
                        exit_code: 3,
                        ..StandInAnswer::default()
                    },
                )],
                otherwise: StandInAnswer {
                    standard_output: "released".to_owned(),
                    exit_code: 1,
                    argument_record: Some(record.clone()),
                    recorded_environment: vec!["STAND_IN_VALUE".to_owned()],
                    hold: Some(StandInHold {
                        waiting: waiting.clone(),
                        release: release.clone(),
                    }),
                },
                first_call_wait: None,
            },
        )
        .expect("the stand-in is written");
        let start = program_start(&program, |_| Some(PathBuf::from("node")))
            .expect("the stand-in starts with no shell");
        let command = |arguments: &[&str]| {
            let mut command = Command::new(&start.program);
            command
                .args(&start.leading_arguments)
                .args(arguments)
                .env("STAND_IN_VALUE", "it's %PATH% ^&")
                .stdout(Stdio::piped());
            command
        };

        let listed = command(&["--json", "list"])
            .output()
            .expect("the stand-in runs");
        assert_eq!(String::from_utf8_lossy(&listed.stdout), listing);
        assert_eq!(listed.status.code(), Some(3));
        assert!(!record.exists(), "an answered word records nothing");

        let arguments = [
            "-c",
            r#"web_search="disabled""#,
            r#"servers={"a b" = {on = false}}"#,
            "",
            r"C:\a folder\",
            "%PATH% ^&",
        ];
        let mut held = command(&arguments).spawn().expect("the stand-in runs");
        while !waiting.exists() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            held.try_wait().expect("the call is read").is_none(),
            "a held call waits for its release"
        );
        std::fs::write(&release, "").expect("the call is released");
        let other = held.wait_with_output().expect("the stand-in ends");
        assert_eq!(String::from_utf8_lossy(&other.stdout), "released");
        assert_eq!(other.status.code(), Some(1));
        command(&[]).output().expect("the stand-in runs");
        let mut expected: Vec<&str> = arguments.to_vec();
        expected.push("it's %PATH% ^&");
        expected.push("it's %PATH% ^&");
        assert_eq!(
            read_recorded_arguments(&record).expect("the record reads"),
            expected
        );
    }
}
