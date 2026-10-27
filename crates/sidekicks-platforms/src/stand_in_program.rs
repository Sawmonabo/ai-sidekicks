//! A stand-in a test writes for another program: a script the system runs by name, whose
//! standard output, exit code and record of its arguments the test sets.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use crate::posix::stand_in_program::write_stand_in_script;
#[cfg(windows)]
use crate::windows::stand_in_program::{read_batch_argument, write_stand_in_script};

/// What a stand-in program does for one call: prints `standard_output` byte for byte, and exits
/// with `exit_code`, first appending each argument to `argument_record` where one is set.
pub struct StandInAnswer {
    /// The exact text the program prints, nothing added.
    pub standard_output: String,
    /// The code the program exits with.
    pub exit_code: u8,
    /// The file each argument of the call is appended to, for [`read_recorded_arguments`].
    pub argument_record: Option<PathBuf>,
}

/// The answers of a stand-in program: the one paired with a call's first argument, or
/// `otherwise` for a call no pair names.
pub struct StandInProgram {
    /// Each first argument, a plain word of letters, digits, `-` and `_`, and its answer.
    pub answers_by_first_argument: Vec<(String, StandInAnswer)>,
    /// The answer to every other call.
    pub otherwise: StandInAnswer,
}

/// Writes `program` in `folder` as a script the system's program search finds for `name`, and
/// answers its path: `name` itself, executable, on macOS and Linux, and `name.cmd` on Windows,
/// where `.cmd` is in the search's default extensions. Panics on a first argument that is not a
/// plain word; fails as the files fail to write, or on a path that is not UTF-8.
pub fn write_stand_in_program(
    folder: &Path,
    name: &str,
    program: &StandInProgram,
) -> io::Result<PathBuf> {
    for (first_argument, _) in &program.answers_by_first_argument {
        assert!(
            !first_argument.is_empty()
                && first_argument
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character)),
            "a stand-in's first argument is a plain word"
        );
    }
    write_stand_in_script(folder, name, program)
}

/// The arguments a stand-in program appended to `record`, in the order its calls passed them.
pub fn read_recorded_arguments(record: &Path) -> io::Result<Vec<String>> {
    let recorded = std::fs::read_to_string(record)?;
    #[cfg(unix)]
    let arguments = recorded.lines().map(str::to_owned).collect();
    #[cfg(windows)]
    let arguments = recorded.lines().map(read_batch_argument).collect();
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
    use std::process::Command;

    use super::{StandInAnswer, StandInProgram, read_recorded_arguments, write_stand_in_program};

    // Killed by a line end after the output (`printf '%s\n'`, or `echo` for `type`), by a quote,
    // percent or caret in the output read as script text, by another exit code, by recording the
    // arguments of a call its first argument answered, and by an argument recorded other than as
    // passed.
    #[test]
    fn a_stand_in_program_prints_its_exact_answer_exits_with_its_code_and_records_its_arguments() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let record = folder.path().join("arguments");
        let listing = r#"[{"name": "it's ^ 100%"}]"#;
        let program = write_stand_in_program(
            folder.path(),
            "tool",
            &StandInProgram {
                answers_by_first_argument: vec![(
                    "list".to_owned(),
                    StandInAnswer {
                        standard_output: listing.to_owned(),
                        exit_code: 3,
                        argument_record: None,
                    },
                )],
                otherwise: StandInAnswer {
                    standard_output: String::new(),
                    exit_code: 1,
                    argument_record: Some(record.clone()),
                },
            },
        )
        .expect("the stand-in is written");

        let listed = Command::new(&program)
            .args(["list", "--json"])
            .output()
            .expect("the stand-in runs");
        assert_eq!(String::from_utf8_lossy(&listed.stdout), listing);
        assert_eq!(listed.status.code(), Some(3));
        assert!(
            !record.exists(),
            "an answered first argument records nothing"
        );

        let arguments = [
            "-c",
            r#"web_search="disabled""#,
            r#"servers={"a b" = {on = false}}"#,
            "",
            r"C:\a folder\",
            "%PATH% ^&",
        ];
        let other = Command::new(&program)
            .args(arguments)
            .output()
            .expect("the stand-in runs");
        assert!(other.stdout.is_empty(), "the other answer prints nothing");
        assert_eq!(other.status.code(), Some(1));
        assert_eq!(
            read_recorded_arguments(&record).expect("the record reads"),
            arguments
        );
    }
}
