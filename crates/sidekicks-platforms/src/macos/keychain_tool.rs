//! What every call of Apple's `security` tool shares, whoever makes it: the tool's path, the one
//! runner that starts it, feeds its input and reads its output within a bound, ending it past the
//! bound, how its exit reads as the keychain's answer, the line `security -i` reads an add from,
//! and what it prints of an item (`printed_form`).
//!
//! A call blocks until the tool ends, and a prompt the person leaves open holds it only until its
//! bound.

pub(crate) mod printed_form;

use std::ffi::OsStr;
use std::io::{self, Read, Write as _};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use secrecy::zeroize::Zeroizing;

use crate::KeychainItemRefusal;

/// The keychain tool, by its full path so no `PATH` entry stands in for it.
pub(crate) const SECURITY_PROGRAM: &str = "/usr/bin/security";

/// The longest line, its newline included, `security -i` reads as one command: it reads each line
/// into a 4096-byte buffer and splits a longer one silently, so a line past this is never sent.
pub(crate) const INTERACTIVE_LINE_LIMIT: usize = 4095;

// The tool's exit for `errSecItemNotFound`: a read or a delete found no item.
const ITEM_NOT_FOUND: i32 = 44;
// The tool's exits for a keychain that cannot answer now: `errSecInteractionNotAllowed`, a locked
// keychain where no prompt can be shown, and `errSecUserCanceled`, its unlock or access prompt
// dismissed, so either way the person is told to unlock it and retry.
const KEYCHAIN_LOCKED: [i32; 2] = [36, 128];
// The tool's exits for `errSecNoDefaultKeychain` and `errSecNoSuchKeychain`: the account has no
// login keychain.
const NO_LOGIN_KEYCHAIN: [i32; 2] = [37, 50];

// How much of the tool's output a call first makes room for; an item is a few kilobytes at most.
const OUTPUT_START_CAPACITY: usize = 8 * 1024;

/// What a call of the tool answered, where it did not refuse.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ToolAnswer {
    /// The call did what it asked.
    Done,
    /// The item the call named does not exist.
    NoItem,
}

/// What the tool's exit `status` answers: done, no item, or the keychain's refusal.
pub(crate) fn tool_answer(status: ExitStatus) -> Result<ToolAnswer, KeychainItemRefusal> {
    match status.code() {
        Some(0) => Ok(ToolAnswer::Done),
        Some(ITEM_NOT_FOUND) => Ok(ToolAnswer::NoItem),
        Some(code) if KEYCHAIN_LOCKED.contains(&code) => Err(KeychainItemRefusal::Locked),
        Some(code) if NO_LOGIN_KEYCHAIN.contains(&code) => {
            Err(KeychainItemRefusal::NoLoginKeychain)
        }
        Some(_) | None => Err(KeychainItemRefusal::Ended(status)),
    }
}

/// The line `security -i` reads as `add-generic-password` with `options`, then
/// `-a "<account>" -s "<service>" -X "<hex>"` and a newline, each name quoted with `\` and `"`
/// escaped; `None` when it would run past [`INTERACTIVE_LINE_LIMIT`]. Fails with
/// [`KeychainItemRefusal::UnwritableName`] when a name holds a line break or a NUL.
pub(crate) fn add_line(
    options: &[&str],
    service: &str,
    account: &str,
    hex: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainItemRefusal> {
    if [service, account]
        .iter()
        .any(|name| name.contains(['\n', '\0']))
    {
        return Err(KeychainItemRefusal::UnwritableName);
    }
    let options_length: usize = options.iter().map(|option| option.len() + 1).sum();
    // Room for the words, each name doubled by escapes, and the hex, so the line never moves.
    let capacity = 64 + options_length + 2 * (service.len() + account.len()) + hex.len();
    let mut line = Zeroizing::new(Vec::with_capacity(capacity));
    line.extend_from_slice(b"add-generic-password");
    for option in options {
        line.push(b' ');
        line.extend_from_slice(option.as_bytes());
    }
    line.extend_from_slice(b" -a ");
    push_quoted(&mut line, account);
    line.extend_from_slice(b" -s ");
    push_quoted(&mut line, service);
    line.extend_from_slice(b" -X \"");
    line.extend_from_slice(hex.as_bytes());
    line.extend_from_slice(b"\"\n");
    Ok((line.len() <= INTERACTIVE_LINE_LIMIT).then_some(line))
}

/// Which of the tool's streams a call reads to its end; the other output stream is closed.
#[derive(Clone, Copy)]
pub(crate) enum Capture {
    /// Its standard output, where a dump and a delete's or an add's words go.
    Output,
    /// Its standard error, where `find-generic-password -g` prints the password line.
    Errors,
}

/// How one run of the tool ended: its exit and the stream it was asked for, wiped when dropped.
pub(crate) struct ToolEnd {
    /// The tool's exit.
    pub(crate) status: ExitStatus,
    /// What it printed on the stream the call named.
    pub(crate) printed: Zeroizing<Vec<u8>>,
}

/// Starts the tool from the thread the call runs on: a credential-store call's tool, which is
/// waited on before the call returns.
pub(crate) fn start_here(mut command: Command) -> io::Result<Child> {
    command.spawn()
}

/// Runs `program` through `start` with `arguments`, `line` written to its standard input and
/// closed, and reads the stream `capture` names to its end, all within `bound`. Blocks. Fails with
/// [`KeychainItemRefusal::Unanswered`] past the bound, the tool ended and reaped first, as while a
/// prompt stays open, and with [`KeychainItemRefusal::Unreachable`] when the tool cannot be started
/// or a stream fails.
pub(crate) fn run_tool(
    start: impl FnOnce(Command) -> io::Result<Child>,
    program: &Path,
    arguments: &[&OsStr],
    line: Option<&[u8]>,
    capture: Capture,
    bound: Duration,
) -> Result<ToolEnd, KeychainItemRefusal> {
    let piped_if = |is_piped: bool| {
        if is_piped {
            Stdio::piped()
        } else {
            Stdio::null()
        }
    };
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(piped_if(line.is_some()))
        .stdout(piped_if(matches!(capture, Capture::Output)))
        .stderr(piped_if(matches!(capture, Capture::Errors)));
    let mut child = start(command).map_err(KeychainItemRefusal::Unreachable)?;
    let input = child.stdin.take();
    let printed: Box<dyn Read + Send> = match capture {
        Capture::Output => Box::new(child.stdout.take().expect("the output is piped")),
        Capture::Errors => Box::new(child.stderr.take().expect("the errors are piped")),
    };
    std::thread::scope(|scope| {
        let (sender, talked) = mpsc::sync_channel(1);
        // The stream closes when the tool exits, or once it is ended past the bound, so this
        // thread always ends before the scope does.
        scope.spawn(move || {
            // A call past its bound has stopped listening.
            sender.send(talk(input, line, printed)).unwrap_or(());
        });
        match talked.recv_timeout(bound) {
            Ok(talked) => {
                let status = child.wait().map_err(KeychainItemRefusal::Unreachable)?;
                Ok(ToolEnd {
                    status,
                    printed: talked.map_err(KeychainItemRefusal::Unreachable)?,
                })
            }
            Err(_unanswered) => {
                end_child(&mut child);
                Err(KeychainItemRefusal::Unanswered)
            }
        }
    })
}

// Writes `line` to the tool's standard input and closes it, then reads `printed` to its end.
fn talk(
    input: Option<ChildStdin>,
    line: Option<&[u8]>,
    mut printed: Box<dyn Read + Send>,
) -> io::Result<Zeroizing<Vec<u8>>> {
    if let (Some(mut input), Some(line)) = (input, line) {
        input.write_all(line)?;
    }
    read_wiped(&mut printed)
}

// Ends and reaps a run past its bound; a failure is logged, since the call already answers.
fn end_child(child: &mut Child) {
    if let Err(error) = child.kill().and_then(|()| child.wait().map(drop)) {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a keychain call past its bound could not be ended"
        );
    }
}

// Reads `reader` to its end into a buffer wiped when dropped; a full buffer is copied into one of
// twice its size and wiped, so no copy of the output is left behind in freed memory.
fn read_wiped(reader: &mut impl Read) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut held = Zeroizing::new(Vec::with_capacity(OUTPUT_START_CAPACITY));
    loop {
        if held.len() == held.capacity() {
            let mut larger = Zeroizing::new(Vec::with_capacity(held.capacity() * 2));
            larger.extend_from_slice(&held);
            held = larger;
        }
        let filled = held.len();
        let capacity = held.capacity();
        held.resize(capacity, 0);
        let read = reader.read(&mut held[filled..]);
        held.truncate(filled + read.as_ref().map_or(0, |read| *read));
        match read {
            Ok(0) => return Ok(held),
            Ok(_) => {}
            Err(interrupted) if interrupted.kind() == io::ErrorKind::Interrupted => {}
            Err(failure) => return Err(failure),
        }
    }
}

// Appends `name` in double quotes, a `\` before each `\` and `"`, as the tool's line reader
// unquotes it.
fn push_quoted(line: &mut Vec<u8>, name: &str) {
    line.push(b'"');
    for byte in name.bytes() {
        if matches!(byte, b'\\' | b'"') {
            line.push(b'\\');
        }
        line.push(byte);
    }
    line.push(b'"');
}
