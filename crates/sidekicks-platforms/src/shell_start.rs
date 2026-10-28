//! What the daemon's `shell` mode starts a shell from, the one frame that carries it from the
//! daemon to the mode over the start confirmation, why the start can fail, and the plain words a
//! failed exec is shown in, in the shapes every platform shares; each platform's module holds the
//! calls behind them.

use std::io;
use std::path::PathBuf;

#[cfg(unix)]
use crate::posix::shell_start::start_failure_words;
#[cfg(target_os = "windows")]
use crate::windows::shell_start::start_failure_words;

/// The environment variable that names the `shell` mode's end of the daemon's start confirmation:
/// the inherited descriptor's number on macOS and Linux, the named pipe's name on Windows. It is
/// the only entry the mode's own environment needs.
pub const SHELL_START_CONFIRMATION: &str = "SIDEKICKS_SHELL_START_CONFIRMATION";

/// Whether the `shell` mode stays a process of its own in the folder it was spawned in, with the
/// shell its child started in the shell's folder: on Windows; on macOS and Linux the mode enters
/// the shell's folder and becomes the shell.
pub const DOES_SHELL_MODE_KEEP_ITS_FOLDER: bool = cfg!(target_os = "windows");

/// The most bytes one shell launch frame holds, so a reader never allocates past it: far above two
/// launches with the largest environment a system lets a program start with.
pub(crate) const SHELL_LAUNCH_MAX_BYTES: usize = 16 * 1024 * 1024;

/// One shell the `shell` mode starts: the program, its arguments, the folder it starts in and
/// exactly its environment. It derives no `Debug`, since the environment may hold secrets.
pub struct ShellStart {
    /// The shell's program: an absolute path, or a bare name looked up on the environment's `PATH`.
    pub program: String,
    /// The arguments the program starts with, in order.
    pub arguments: Vec<String>,
    /// Text the program parses itself, written after the arguments exactly as given on Windows;
    /// macOS and Linux, which hand a program its arguments unparsed, pass it as one last argument.
    pub raw_command_tail: Option<String>,
    /// The folder the shell starts in: on macOS and Linux the mode enters it before its exec, and
    /// on Windows the shell is started in it while the mode keeps the folder it was spawned in.
    pub folder: PathBuf,
    /// Exactly the shell's environment, in order, one entry per name; a name is never empty and
    /// holds no `=`, and no name or value holds a NUL.
    pub environment: Vec<(String, String)>,
}

/// What the `shell` mode reads in its one frame: the shell it starts, and the platform's default
/// shell it starts instead when the first cannot be started. Nothing of it rides the mode's
/// command line, which any account can read, or the mode's own environment.
pub struct ShellLaunch {
    /// The shell the person's terminal runs.
    pub shell: ShellStart,
    /// The shell started in its place, in the same folder, when the first one's start fails.
    pub fallback: ShellStart,
}

impl ShellLaunch {
    /// The frame the daemon writes after the start's confirmation: its body's length as four
    /// little-endian bytes, then each launch's texts, each text's length before it. Fails with
    /// `InvalidInput` for a folder that is not text, an environment entry with an empty name, an
    /// `=` in its name or a NUL, and a frame past its bound.
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let mut frame = vec![0; size_of::<u32>()];
        for start in [&self.shell, &self.fallback] {
            check_environment(&start.environment)?;
            let folder = start.folder.to_str().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("the shell folder {} is not text", start.folder.display()),
                )
            })?;
            put_text(&mut frame, &start.program)?;
            put_count(&mut frame, start.arguments.len())?;
            for argument in &start.arguments {
                put_text(&mut frame, argument)?;
            }
            frame.push(u8::from(start.raw_command_tail.is_some()));
            if let Some(tail) = &start.raw_command_tail {
                put_text(&mut frame, tail)?;
            }
            put_text(&mut frame, folder)?;
            put_count(&mut frame, start.environment.len())?;
            for (name, value) in &start.environment {
                put_text(&mut frame, name)?;
                put_text(&mut frame, value)?;
            }
        }
        let body_length = frame.len() - size_of::<u32>();
        if body_length > SHELL_LAUNCH_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the shell's launch is past the frame's bound",
            ));
        }
        let length = u32::try_from(body_length).expect("the bound fits four bytes");
        frame[..size_of::<u32>()].copy_from_slice(&length.to_le_bytes());
        Ok(frame)
    }

    /// Reads a frame from `reader`, written by [`Self::encode`]. Fails with `InvalidData` for a
    /// length past the bound, a text that is not UTF-8, an environment entry the mode could not
    /// hand on or bytes left over, and with the read's error, `UnexpectedEof` when the frame ends
    /// early.
    pub(crate) fn read_from(reader: &mut impl io::Read) -> io::Result<Self> {
        let mut length = [0; size_of::<u32>()];
        reader.read_exact(&mut length)?;
        let length = usize::try_from(u32::from_le_bytes(length)).map_err(io::Error::other)?;
        if length > SHELL_LAUNCH_MAX_BYTES {
            return Err(invalid_frame("its length is past the bound"));
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body)?;
        let mut cursor = body.as_slice();
        let shell = take_start(&mut cursor)?;
        let fallback = take_start(&mut cursor)?;
        if !cursor.is_empty() {
            return Err(invalid_frame("bytes follow the second launch"));
        }
        Ok(Self { shell, fallback })
    }
}

/// Why the `shell` mode could not prepare its own process to start a shell.
#[derive(Debug, thiserror::Error)]
pub enum ShellStartError {
    /// The daemon that opened the shell is no longer the mode's parent, so the shell would outlive
    /// it.
    #[error("the daemon that opened this shell is no longer its parent")]
    DaemonGone,
    /// The system refused to arm the parent-death signal or clear the huge-page switch.
    #[error("the system refused to arm the shell's process")]
    ArmingRefused(#[source] io::Error),
    /// The system refused to make the terminal the mode started on its controlling one.
    #[error("the system refused to make the shell's terminal its controlling one")]
    TerminalRefused(#[source] io::Error),
    /// The system refused to enter the shell's folder: it is gone, not a folder, or not open to
    /// the user.
    #[error("the system refused to enter the shell's folder")]
    FolderRefused(#[source] io::Error),
    /// The system refused to set `SIGPIPE` back to its default.
    #[error("the system refused to set SIGPIPE back to its default")]
    SignalResetRefused(#[source] io::Error),
    /// No confirmation and launch came from the daemon that opened the shell: the mode's
    /// environment names no end, another process wrote it, or it ended early; the mode starts
    /// nothing.
    #[error("the daemon that opened this shell did not confirm its start")]
    Unconfirmed(#[source] io::Error),
}

/// The words a failed shell start is shown in: `no such file`, `not allowed to run`, `not a
/// program for this computer`, `its path is too long` or `the disk could not be read` for the
/// errors the platform reads that way, and otherwise the system's own text for the error.
pub fn describe_start_failure(error: &io::Error) -> String {
    let words = error.raw_os_error().and_then(start_failure_words);
    match (words, error.raw_os_error()) {
        (Some(words), _) => words.to_owned(),
        // The system's text, without the code std writes after it.
        (None, Some(code)) => {
            let text = error.to_string();
            text.strip_suffix(&format!(" (os error {code})"))
                .map_or(text.clone(), str::to_owned)
        }
        (None, None) => error.to_string(),
    }
}

/// Refuses an environment the `shell` mode could not hand on as given: an empty name, an `=` in a
/// name, or a NUL anywhere. The value may hold a secret, so the error names only the entry.
fn check_environment(environment: &[(String, String)]) -> io::Result<()> {
    for (index, (name, value)) in environment.iter().enumerate() {
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
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

// Writes a count as four little-endian bytes; fails past four bytes.
fn put_count(frame: &mut Vec<u8>, count: usize) -> io::Result<()> {
    let count =
        u32::try_from(count).map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    frame.extend_from_slice(&count.to_le_bytes());
    Ok(())
}

// Writes a text's length, then its bytes.
fn put_text(frame: &mut Vec<u8>, text: &str) -> io::Result<()> {
    put_count(frame, text.len())?;
    frame.extend_from_slice(text.as_bytes());
    Ok(())
}

// Reads one launch from the front of `cursor`.
fn take_start(cursor: &mut &[u8]) -> io::Result<ShellStart> {
    let program = take_text(cursor)?;
    let argument_count = take_count(cursor)?;
    let arguments = (0..argument_count)
        .map(|_| take_text(cursor))
        .collect::<io::Result<Vec<_>>>()?;
    let raw_command_tail = match take_bytes(cursor, 1)? {
        [0] => None,
        [1] => Some(take_text(cursor)?),
        _ => return Err(invalid_frame("its raw tail's mark is neither 0 nor 1")),
    };
    let folder = PathBuf::from(take_text(cursor)?);
    let entry_count = take_count(cursor)?;
    let environment = (0..entry_count)
        .map(|_| Ok((take_text(cursor)?, take_text(cursor)?)))
        .collect::<io::Result<Vec<_>>>()?;
    check_environment(&environment)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(ShellStart {
        program,
        arguments,
        raw_command_tail,
        folder,
        environment,
    })
}

// Reads a count from the front of `cursor`.
fn take_count(cursor: &mut &[u8]) -> io::Result<usize> {
    let bytes = take_bytes(cursor, size_of::<u32>())?;
    let count = u32::from_le_bytes(bytes.try_into().expect("four bytes were taken"));
    usize::try_from(count).map_err(io::Error::other)
}

// Reads a text from the front of `cursor`.
fn take_text(cursor: &mut &[u8]) -> io::Result<String> {
    let length = take_count(cursor)?;
    let bytes = take_bytes(cursor, length)?;
    String::from_utf8(bytes.to_vec())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

// Takes `length` bytes from the front of `cursor`; fails when fewer are left.
fn take_bytes<'frame>(cursor: &mut &'frame [u8], length: usize) -> io::Result<&'frame [u8]> {
    if cursor.len() < length {
        return Err(invalid_frame("it ends inside a value"));
    }
    let (taken, rest) = cursor.split_at(length);
    *cursor = rest;
    Ok(taken)
}

// A frame that is not one launch frame.
fn invalid_frame(why: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("the shell's launch frame is malformed: {why}"),
    )
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::PathBuf;

    use super::{ShellLaunch, ShellStart};

    fn start(program: &str, environment: &[(&str, &str)]) -> ShellStart {
        ShellStart {
            program: program.to_owned(),
            arguments: vec!["-l".to_owned(), String::new()],
            raw_command_tail: Some("a \"b\" c".to_owned()),
            folder: PathBuf::from("/a folder"),
            environment: environment
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
        }
    }

    // The frame carries both launches exactly, a value holding `=`, a line break or nothing among
    // them; a frame cut short, one past its bound and an entry the mode could not hand on are
    // refused before any shell starts.
    #[test]
    fn the_frame_carries_both_launches_exactly_and_refuses_a_broken_one() {
        let launch = ShellLaunch {
            shell: start("zsh", &[("EQUATION", "a=b\nc"), ("EMPTY", "")]),
            fallback: fallback(),
        };
        let frame = launch.encode().expect("the launch encodes");

        let read = ShellLaunch::read_from(&mut frame.as_slice()).expect("the frame reads");

        for (written, read) in [
            (&launch.shell, &read.shell),
            (&launch.fallback, &read.fallback),
        ] {
            assert_eq!(read.program, written.program);
            assert_eq!(read.arguments, written.arguments);
            assert_eq!(read.raw_command_tail, written.raw_command_tail);
            assert_eq!(read.folder, written.folder);
            assert_eq!(read.environment, written.environment);
        }
        let cut = &frame[..frame.len() - 1];
        assert_eq!(
            ShellLaunch::read_from(&mut &cut[..])
                .map(drop)
                .map_err(|error| error.kind()),
            Err(io::ErrorKind::UnexpectedEof)
        );
        let mut past_bound = frame.clone();
        past_bound[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            ShellLaunch::read_from(&mut past_bound.as_slice())
                .map(drop)
                .map_err(|error| error.kind()),
            Err(io::ErrorKind::InvalidData)
        );
        for (name, value) in [("", "x"), ("A=B", "x"), ("A\0", "x"), ("A", "x\0")] {
            let refused = ShellLaunch {
                shell: start("zsh", &[(name, value)]),
                fallback: fallback(),
            };
            assert_eq!(
                refused.encode().map(drop).map_err(|error| error.kind()),
                Err(io::ErrorKind::InvalidInput)
            );
        }
    }

    fn fallback() -> ShellStart {
        ShellStart {
            program: "/bin/sh".to_owned(),
            arguments: Vec::new(),
            raw_command_tail: None,
            folder: PathBuf::from("/a folder"),
            environment: vec![("PATH".to_owned(), "/bin".to_owned())],
        }
    }
}
