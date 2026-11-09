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
    for (index, (first_argument, answer)) in program.answers_by_first_argument.iter().enumerate() {
        writeln!(
            script,
            "if [ \"$1\" = {} ]; then",
            quote_single(first_argument)
        )
        .expect("a String takes every write");
        push_answer(&mut script, index, answer)?;
        script.push_str("fi\n");
    }
    let otherwise_index = program.answers_by_first_argument.len();
    push_answer(&mut script, otherwise_index, &program.otherwise)?;
    let path = folder.join(name);
    replace_file_atomically(&path, script.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .map_err(|error| error.failure)?;
    Ok(path)
}

// Appends the lines of the answer at `index`: its first call's wait, marked by a file beside the
// script, then the lines that record the arguments, print the output with nothing added and exit.
fn push_answer(script: &mut String, index: usize, answer: &StandInAnswer) -> io::Result<()> {
    if let Some(delay) = answer.first_call_delay {
        writeln!(
            script,
            "if [ ! -e \"$0.first-call-{index}\" ]; then : > \"$0.first-call-{index}\"; \
             sleep {}; fi",
            delay.as_secs_f64()
        )
        .expect("a String takes every write");
    }
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
