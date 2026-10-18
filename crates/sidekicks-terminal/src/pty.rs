//! A shell's PTY: how it opens and the environment it hands the `shell` mode.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::{self, Pty};

/// A program and the arguments it starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandLine {
    /// The program to run.
    pub program: String,
    /// The arguments it starts with, in order.
    pub arguments: Vec<String>,
}

/// What one shell starts as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    /// The shell's program.
    pub program: String,
    /// The arguments the shell's program starts with.
    pub arguments: Vec<String>,
    /// Exactly the shell's environment, in order; a later entry with a name already given wins.
    /// A name is never empty and holds no `=`, and no name or value holds a NUL.
    pub environment: Vec<(String, String)>,
    /// The folder the shell starts in.
    pub working_directory: PathBuf,
    /// The terminal's height in rows.
    pub rows: u16,
    /// The terminal's width in columns.
    pub columns: u16,
    /// The daemon's `shell` mode with its arguments up to the shell's program, which starts
    /// the shell with exactly `environment`.
    pub shell_start: CommandLine,
}

/// Opens the shell's PTY and starts its program through the `shell` mode; blocking, so it
/// runs on the daemon's spawner thread. Fails with `InvalidInput` for an environment entry with
/// an empty name, an `=` in its name or a NUL, with `NotADirectory` when the working folder is not
/// a folder, and with the system's error when the terminal cannot be opened or the program
/// started.
pub(crate) fn open_pty(request: &SpawnRequest) -> io::Result<Pty> {
    check_environment(&request.environment)?;
    if !request.working_directory.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("{} is not a folder", request.working_directory.display()),
        ));
    }
    let mut arguments = request.shell_start.arguments.clone();
    arguments.push(request.program.clone());
    arguments.extend(request.arguments.iter().cloned());
    let options = sidekicks_platforms::terminal_options(
        tty::Shell::new(request.shell_start.program.clone(), arguments),
        Some(request.working_directory.clone()),
        encode_shell_environment(&request.environment),
    );
    let window_size = WindowSize {
        num_lines: request.rows,
        num_cols: request.columns,
        cell_width: 0,
        cell_height: 0,
    };
    tty::new(&options, window_size, 0)
}

/// Refuses an environment the `shell` mode could not hand on as given: an empty name, an `=`
/// in a name, or a NUL anywhere.
fn check_environment(environment: &[(String, String)]) -> io::Result<()> {
    for (index, (name, value)) in environment.iter().enumerate() {
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            // The value may hold a secret, so the error names only the entry.
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "shell environment entry {index} has an empty name, an `=` in its name or \
                     a NUL"
                ),
            ));
        }
    }
    Ok(())
}

/// The variable that tells the `shell` mode how many environment entries it was handed.
const SHELL_ENVIRONMENT_COUNT: &str = "SIDEKICKS_SHELL_ENVIRONMENT_COUNT";

/// The start of every variable that carries one entry of a shell's environment to the
/// `shell` mode; the entry's index in the environment follows it.
const SHELL_ENVIRONMENT_PREFIX: &str = "SIDEKICKS_SHELL_ENVIRONMENT_";

/// The name of the variable that carries entry `index` of a shell's environment.
fn shell_environment_name(index: usize) -> String {
    format!("{SHELL_ENVIRONMENT_PREFIX}{index}")
}

/// The variables that carry `environment` to the `shell` mode: the count, then one
/// `NAME=VALUE` each, in order, a later entry's value replacing an earlier one's of the same name
/// in its place.
fn encode_shell_environment(environment: &[(String, String)]) -> HashMap<String, String> {
    let mut resolved: Vec<(&str, &str)> = Vec::with_capacity(environment.len());
    let mut position_of_name: HashMap<&str, usize> = HashMap::with_capacity(environment.len());
    for (name, value) in environment {
        match position_of_name.entry(name.as_str()) {
            Entry::Occupied(position) => resolved[*position.get()].1 = value.as_str(),
            Entry::Vacant(position) => {
                position.insert(resolved.len());
                resolved.push((name.as_str(), value.as_str()));
            }
        }
    }
    let count = resolved.len();
    resolved
        .into_iter()
        .enumerate()
        .map(|(index, (name, value))| (shell_environment_name(index), format!("{name}={value}")))
        .chain([(SHELL_ENVIRONMENT_COUNT.to_owned(), count.to_string())])
        .collect()
}

/// Why the environment the `shell` mode was handed could not be read.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ShellEnvironmentError {
    /// No variable says how many entries were handed over.
    #[error("the shell environment's count is missing")]
    CountMissing,
    /// The count is not a decimal number.
    #[error("the shell environment's count is not a number")]
    CountInvalid,
    /// An entry below the count has no variable.
    #[error("shell environment entry {index} is missing")]
    IndexMissing {
        /// The entry's index.
        index: usize,
    },
    /// An entry is not Unicode.
    #[error("shell environment entry {index} is not Unicode")]
    NotUnicode {
        /// The entry's index.
        index: usize,
    },
    /// An entry holds no `=` after its name.
    #[error("shell environment entry {index} holds no `=` after its name")]
    NoSeparator {
        /// The entry's index.
        index: usize,
    },
}

/// Reads a shell's environment, in order, from the variables the daemon handed the `shell`
/// mode, reading only the entries below the count it was handed, so any other variable, a stray
/// inherited entry among them, is ignored. Fails when the count is missing or not a number, or an
/// entry below it is missing, not Unicode or holds no `=`.
pub fn shell_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Vec<(String, String)>, ShellEnvironmentError> {
    let variables: HashMap<OsString, OsString> = variables.into_iter().collect();
    let count = variables
        .get(OsStr::new(SHELL_ENVIRONMENT_COUNT))
        .ok_or(ShellEnvironmentError::CountMissing)?
        .to_str()
        .and_then(|count| count.parse::<usize>().ok())
        .ok_or(ShellEnvironmentError::CountInvalid)?;
    (0..count)
        .map(|index| {
            let entry = variables
                .get(OsStr::new(&shell_environment_name(index)))
                .ok_or(ShellEnvironmentError::IndexMissing { index })?
                .to_str()
                // The value may hold a secret, so the error names only the entry.
                .ok_or(ShellEnvironmentError::NotUnicode { index })?;
            let (name, value) = entry
                .split_once('=')
                .ok_or(ShellEnvironmentError::NoSeparator { index })?;
            Ok((name.to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io;

    use super::{
        ShellEnvironmentError, check_environment, encode_shell_environment, shell_environment,
        shell_environment_name,
    };

    #[test]
    fn the_shell_mode_reads_back_exactly_the_environment_it_was_handed() {
        let environment = [
            ("PATH", "/bin"),
            ("EQUATION", "a=b\nc"),
            ("PATH", "/usr/bin"),
            ("LANG", "en_US.UTF-8"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        let encoded = encode_shell_environment(&environment);
        let variables = |encoded: &HashMap<String, String>| {
            encoded
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                // An unrelated variable and an entry past the count, as a parent's leftover.
                .chain([
                    (OsString::from("HOME"), OsString::from("/home/someone")),
                    (
                        OsString::from(shell_environment_name(3)),
                        OsString::from("STRAY=1"),
                    ),
                ])
                .collect::<Vec<_>>()
        };

        let decoded = shell_environment(variables(&encoded));
        let expected = [
            ("PATH", "/usr/bin"),
            ("EQUATION", "a=b\nc"),
            ("LANG", "en_US.UTF-8"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        assert_eq!(decoded, Ok(expected.to_vec()));

        let mut missing_one = encoded;
        missing_one.remove(&shell_environment_name(1));
        assert_eq!(
            shell_environment(variables(&missing_one)),
            Err(ShellEnvironmentError::IndexMissing { index: 1 })
        );

        // An entry the encoding could not carry as given is refused before any shell starts.
        for (name, value) in [("", "x"), ("A=B", "x"), ("A\0", "x"), ("A", "x\0")] {
            let refused = check_environment(&[(name.to_owned(), value.to_owned())]);
            assert_eq!(
                refused.map_err(|error| error.kind()),
                Err(io::ErrorKind::InvalidInput)
            );
        }
    }
}
