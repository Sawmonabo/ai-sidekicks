//! A stand-in program on macOS and Linux: an executable `sh` script.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

use crate::stand_in_program::{StandInAnswer, StandInProgram, script_path_text};
use crate::{LeftoverSweep, replace_file_atomically};

/// Writes `program` as the executable script `name` in `folder` and answers its path; the file is
/// renamed into place whole, so no writer still holds it open when it runs. Fails as the write
/// fails, or on a record path that is not UTF-8.
pub(crate) fn write_stand_in_script(
    folder: &Path,
    name: &str,
    program: &StandInProgram,
) -> io::Result<PathBuf> {
    let mut script = String::from("#!/bin/sh\n");
    for (first_argument, answer) in &program.answers_by_first_argument {
        writeln!(
            script,
            "if [ \"$1\" = {} ]; then",
            quote_single(first_argument)
        )
        .expect("a String takes every write");
        push_answer(&mut script, answer)?;
        script.push_str("fi\n");
    }
    push_answer(&mut script, &program.otherwise)?;
    let path = folder.join(name);
    replace_file_atomically(&path, script.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .map_err(|error| error.failure)?;
    Ok(path)
}

// Appends the lines that record the arguments, print the output with nothing added and exit.
fn push_answer(script: &mut String, answer: &StandInAnswer) -> io::Result<()> {
    if let Some(record) = &answer.argument_record {
        writeln!(
            script,
            "for argument in \"$@\"; do printf '%s\\n' \"$argument\"; done >> {}",
            quote_single(script_path_text(record)?)
        )
        .expect("a String takes every write");
    }
    if !answer.standard_output.is_empty() {
        writeln!(
            script,
            "printf '%s' {}",
            quote_single(&answer.standard_output)
        )
        .expect("a String takes every write");
    }
    writeln!(script, "exit {}", answer.exit_code).expect("a String takes every write");
    Ok(())
}

// `text` as one single-quoted shell word, each `'` closed, escaped and reopened.
fn quote_single(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}
