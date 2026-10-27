//! A stand-in program on Windows: a `.cmd` batch file, which std runs through `cmd.exe /c`.
//!
//! Each answer's output sits in a sibling file the script prints with `type`, which copies its
//! bytes as they are, where `echo` would end the text with a line break and read `%`, `^` and `&`
//! as script. Each argument is recorded as the token std wrote for it on the command line, which
//! std quotes whenever it holds anything but letters, digits and `#$*+-./:?@\_`, so cmd never
//! reads a quoted token's characters as script; [`read_batch_argument`] undoes that quoting.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

use crate::stand_in_program::{StandInAnswer, StandInProgram, script_path_text};

/// Writes `program` as `name.cmd` in `folder`, beside one output file per answer that prints
/// any, and answers the script's path. Fails as a file fails to write, or on a path that
/// is not UTF-8.
pub(crate) fn write_stand_in_script(
    folder: &Path,
    name: &str,
    program: &StandInProgram,
) -> io::Result<PathBuf> {
    let mut script = String::from("@echo off\r\n");
    for (index, (first_argument, _)) in program.answers_by_first_argument.iter().enumerate() {
        write!(script, "if [%1]==[{first_argument}] goto answer{index}\r\n")
            .expect("a String takes every write");
    }
    push_answer(&mut script, folder, name, "otherwise", &program.otherwise)?;
    for (index, (_, answer)) in program.answers_by_first_argument.iter().enumerate() {
        let label = format!("answer{index}");
        write!(script, ":{label}\r\n").expect("a String takes every write");
        push_answer(&mut script, folder, name, &label, answer)?;
    }
    let path = folder.join(format!("{name}.cmd"));
    std::fs::write(&path, script)?;
    Ok(path)
}

/// The argument std encoded as the batch token `token`: a quoted token loses its outer quotes,
/// each doubled `"` becomes one and the backslashes std doubled before a quote are halved.
pub(crate) fn read_batch_argument(token: &str) -> String {
    let Some(body) = token
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return token.to_owned();
    };
    let mut argument = String::new();
    let mut backslashes = 0;
    let mut characters = body.chars();
    while let Some(character) = characters.next() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                argument.push_str(&"\\".repeat(backslashes / 2));
                backslashes = 0;
                argument.push('"');
                // The second quote of the doubled pair.
                characters.next();
            }
            _ => {
                argument.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                argument.push(character);
            }
        }
    }
    argument.push_str(&"\\".repeat(backslashes / 2));
    argument
}

// Appends the lines that record the arguments one token a line, print the answer's output file
// and exit, writing that file beside the script.
fn push_answer(
    script: &mut String,
    folder: &Path,
    name: &str,
    label: &str,
    answer: &StandInAnswer,
) -> io::Result<()> {
    if let Some(record) = &answer.argument_record {
        let record = quote_batch_path(script_path_text(record)?);
        write!(
            script,
            ":record_{label}\r\nif [%1]==[] goto recorded_{label}\r\n>>{record} echo(%1\r\n\
             shift\r\ngoto record_{label}\r\n:recorded_{label}\r\n"
        )
        .expect("a String takes every write");
    }
    if !answer.standard_output.is_empty() {
        let output = folder.join(format!("{name}.{label}.out"));
        std::fs::write(&output, &answer.standard_output)?;
        let output = quote_batch_path(script_path_text(&output)?);
        write!(script, "type {output}\r\n").expect("a String takes every write");
    }
    write!(script, "exit {}\r\n", answer.exit_code).expect("a String takes every write");
    Ok(())
}

// `path` quoted for a batch line, each `%` doubled so cmd does not expand it.
fn quote_batch_path(path: &str) -> String {
    format!("\"{}\"", path.replace('%', "%%"))
}
