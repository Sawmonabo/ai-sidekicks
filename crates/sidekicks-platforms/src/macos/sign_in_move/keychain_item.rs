//! A sign-in's keychain item, reached only through Apple's `security` tool: read with
//! `find-generic-password -w`, written with `add-generic-password -U` on the tool's standard input,
//! and deleted with `delete-generic-password`. The provider reaches the item the same way, so the
//! item keeps the access list the tool's writes give it, which trusts the tool, and neither side
//! meets a prompt.

use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use secrecy::zeroize::Zeroizing;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::{Child, Command};
use tokio::time::Instant;

use super::SignInPlace;
use crate::posix::child_command::prepare_child_command;
use crate::spawner::Spawner;
use crate::{KeychainItemRefusal, SignInMoveError};

// The tool's exit for `errSecItemNotFound`: a read or a delete found no item.
const ITEM_NOT_FOUND: i32 = 44;
// The tool's exit for `errSecInteractionNotAllowed`: the keychain is locked.
const KEYCHAIN_LOCKED: i32 = 36;
// The tool's exits for `errSecNoDefaultKeychain` and `errSecNoSuchKeychain`: the account has no
// login keychain.
const NO_LOGIN_KEYCHAIN: [i32; 2] = [37, 50];

/// The longest line, its newline included, `security -i` reads as one command: it reads each line
/// into a 4096-byte buffer and splits a longer one silently, so a line past this is never sent.
pub(crate) const INTERACTIVE_LINE_LIMIT: usize = 4095;

// How much of the tool's output a read first makes room for; an item is a few kilobytes at most.
const OUTPUT_START_CAPACITY: usize = 8 * 1024;

/// A sign-in's keychain item, each call one child of the keychain tool held to the step bound.
pub(super) struct KeychainItem<'a> {
    service: &'a str,
    account: &'a str,
    spawner: &'a Spawner,
    security_program: &'a Path,
    step_bound: Duration,
}

// How one call of the tool ended: its exit and what it printed, wiped when dropped.
struct ToolEnd {
    status: ExitStatus,
    printed: Zeroizing<Vec<u8>>,
}

/// What a call of the tool answered, where it did not refuse.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ToolAnswer {
    /// The call did what it asked.
    Done,
    /// The item the call named does not exist.
    NoItem,
}

/// How an add reaches the tool: one line on its standard input, or, for a sign-in too long for
/// that line, its own arguments.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AddForm {
    /// The line for `security -i`, its newline included, wiped when dropped.
    Line(Zeroizing<Vec<u8>>),
    /// `add-generic-password` run with the item's names and hex as its arguments, as the
    /// provider's own write does past the line.
    Arguments,
}

impl<'a> KeychainItem<'a> {
    /// The item filed under `service` and `account`, reached through `security_program` started
    /// on `spawner`, each call held to `step_bound`.
    pub(super) fn new(
        service: &'a str,
        account: &'a str,
        spawner: &'a Spawner,
        security_program: &'a Path,
        step_bound: Duration,
    ) -> Self {
        Self {
            service,
            account,
            spawner,
            security_program,
            step_bound,
        }
    }

    /// The item's value, `None` where there is no item. Fails with the keychain's refusal, and
    /// with [`KeychainItemRefusal::Unanswered`] past the step bound, the tool ended.
    pub(super) async fn read_value(
        &self,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainItemRefusal> {
        let ended = self
            .run(
                &self.named_arguments("find-generic-password", &["-w"]),
                None,
            )
            .await?;
        match tool_answer(ended.status)? {
            ToolAnswer::Done => Ok(Some(item_from_printed(&ended.printed))),
            ToolAnswer::NoItem => Ok(None),
        }
    }

    /// Holds `value` in the item, in place of anything held before, its access list kept. Fails
    /// as [`Self::read_value`] does.
    pub(super) async fn write_value(&self, value: &[u8]) -> Result<(), KeychainItemRefusal> {
        let mut hex_buffer = Zeroizing::new(vec![0; value.len() * 2]);
        let hex = base16ct::lower::encode_str(value, &mut hex_buffer)
            .expect("the buffer holds twice the value's bytes");
        let ended = match add_form(self.service, self.account, hex)? {
            AddForm::Line(line) => self.run(&[OsStr::new("-i")], Some(line)).await?,
            AddForm::Arguments => {
                let arguments = self.named_arguments("add-generic-password", &["-U", "-X", hex]);
                self.run(&arguments, None).await?
            }
        };
        match tool_answer(ended.status)? {
            ToolAnswer::Done => Ok(()),
            ToolAnswer::NoItem => Err(KeychainItemRefusal::Ended(ended.status)),
        }
    }

    /// Deletes the item, answering whether there was one. Fails as [`Self::read_value`] does.
    pub(super) async fn delete_value(&self) -> Result<bool, KeychainItemRefusal> {
        let ended = self
            .run(&self.named_arguments("delete-generic-password", &[]), None)
            .await?;
        match tool_answer(ended.status)? {
            ToolAnswer::Done => Ok(true),
            ToolAnswer::NoItem => Ok(false),
        }
    }

    // `refusal` as the move's error: past the step bound the move stops there; any other refusal
    // names the item.
    fn refused(&self, refusal: KeychainItemRefusal) -> SignInMoveError {
        match refusal {
            KeychainItemRefusal::Unanswered => SignInMoveError::Overran,
            refusal @ (KeychainItemRefusal::Locked
            | KeychainItemRefusal::NoLoginKeychain
            | KeychainItemRefusal::Ended(_)
            | KeychainItemRefusal::Unreachable(_)
            | KeychainItemRefusal::UnwritableName) => SignInMoveError::Keychain {
                service: self.service.to_owned(),
                account: self.account.to_owned(),
                refusal,
            },
        }
    }

    // `command` with the item's names, then `rest`.
    fn named_arguments<'b>(&'b self, command: &'b str, rest: &[&'b str]) -> Vec<&'b OsStr> {
        let names = [command, "-a", self.account, "-s", self.service];
        names.iter().chain(rest).copied().map(OsStr::new).collect()
    }

    // Runs the tool with `arguments` and `line` on its standard input, or none, on the spawner
    // within the step bound; past it the child is ended and reaped before the call answers.
    async fn run(
        &self,
        arguments: &[&OsStr],
        line: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<ToolEnd, KeychainItemRefusal> {
        let deadline = Instant::now() + self.step_bound;
        let mut command = Command::new(self.security_program);
        command
            .args(arguments)
            .stdin(if line.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        prepare_child_command(&mut command, std::process::id());
        let started = match tokio::time::timeout_at(
            deadline,
            self.spawner.run(move || command.spawn()),
        )
        .await
        {
            Ok(started) => started,
            Err(_elapsed) => return Err(KeychainItemRefusal::Unanswered),
        };
        let mut child = started
            .and_then(|spawned| spawned)
            .map_err(KeychainItemRefusal::Unreachable)?;
        match tokio::time::timeout_at(deadline, talk(&mut child, line)).await {
            Ok(ended) => ended.map_err(KeychainItemRefusal::Unreachable),
            Err(_elapsed) => {
                if let Err(error) = child.kill().await {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a keychain call past its bound could not be ended"
                    );
                }
                Err(KeychainItemRefusal::Unanswered)
            }
        }
    }
}

impl SignInPlace for KeychainItem<'_> {
    async fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, SignInMoveError> {
        self.read_value()
            .await
            .map_err(|refusal| self.refused(refusal))
    }

    async fn write(&self, sign_in: &[u8]) -> Result<(), SignInMoveError> {
        self.write_value(sign_in)
            .await
            .map_err(|refusal| self.refused(refusal))
    }

    async fn delete(&self) -> Result<(), SignInMoveError> {
        self.delete_value()
            .await
            .map(drop)
            .map_err(|refusal| self.refused(refusal))
    }

    fn describe(&self) -> String {
        format!("the keychain item {} for {}", self.service, self.account)
    }
}

// Writes `line` to the child's standard input and closes it, drains its standard error, which is
// never kept, and reads its standard output until it exits.
async fn talk(child: &mut Child, line: Option<Zeroizing<Vec<u8>>>) -> io::Result<ToolEnd> {
    let input = child.stdin.take();
    let mut output = child.stdout.take().expect("the tool's output is piped");
    let mut errors = child.stderr.take().expect("the tool's errors are piped");
    let send = async move {
        if let (Some(mut input), Some(line)) = (input, line) {
            input.write_all(&line).await?;
            input.shutdown().await?;
        }
        Ok::<(), io::Error>(())
    };
    let mut discarded = tokio::io::sink();
    let (sent, printed, drained, status) = tokio::join!(
        send,
        read_wiped(&mut output),
        tokio::io::copy(&mut errors, &mut discarded),
        child.wait()
    );
    sent?;
    drained?;
    Ok(ToolEnd {
        status: status?,
        printed: printed?,
    })
}

// Reads `reader` to its end into a buffer wiped when dropped; a full buffer is copied into one of
// twice its size and wiped, so no copy of the output is left behind in freed memory.
async fn read_wiped(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut held = Zeroizing::new(Vec::with_capacity(OUTPUT_START_CAPACITY));
    loop {
        if held.len() == held.capacity() {
            let mut larger = Zeroizing::new(Vec::with_capacity(held.capacity() * 2));
            larger.extend_from_slice(&held);
            held = larger;
        }
        if reader.read_buf(&mut *held).await? == 0 {
            return Ok(held);
        }
    }
}

/// What the tool's exit `status` answers: done, no item, or the keychain's refusal.
pub(super) fn tool_answer(status: ExitStatus) -> Result<ToolAnswer, KeychainItemRefusal> {
    match status.code() {
        Some(0) => Ok(ToolAnswer::Done),
        Some(ITEM_NOT_FOUND) => Ok(ToolAnswer::NoItem),
        Some(KEYCHAIN_LOCKED) => Err(KeychainItemRefusal::Locked),
        Some(code) if NO_LOGIN_KEYCHAIN.contains(&code) => {
            Err(KeychainItemRefusal::NoLoginKeychain)
        }
        Some(_) | None => Err(KeychainItemRefusal::Ended(status)),
    }
}

/// The item's bytes from what `find-generic-password -w` printed: the tool prints an item whose
/// every byte is printable (0x20 to 0x7E) as it is, else as lowercase hex, then one newline. So
/// printed text that is lowercase hex of even length decoding to a byte outside that range is the
/// decoded bytes, and anything else is the text itself, one trailing newline dropped and nothing
/// else trimmed.
pub(super) fn item_from_printed(printed: &[u8]) -> Zeroizing<Vec<u8>> {
    let text = printed.strip_suffix(b"\n").unwrap_or(printed);
    let mut decoded = Zeroizing::new(vec![0; text.len() / 2]);
    let is_hex_of_unprintable = base16ct::lower::decode(text, &mut decoded)
        .is_ok_and(|bytes| bytes.iter().any(|byte| !(0x20..=0x7E).contains(byte)));
    if is_hex_of_unprintable {
        decoded
    } else {
        Zeroizing::new(text.to_vec())
    }
}

/// How the add of `hex` under `service` and `account` reaches the tool: the line
/// `add-generic-password -U -a "<account>" -s "<service>" -X "<hex>"` while it fits
/// [`INTERACTIVE_LINE_LIMIT`], each name quoted with `\` and `"` escaped, else its own arguments.
/// Fails with [`KeychainItemRefusal::UnwritableName`] when a name holds a line break or a NUL.
pub(super) fn add_form(
    service: &str,
    account: &str,
    hex: &str,
) -> Result<AddForm, KeychainItemRefusal> {
    if [service, account]
        .iter()
        .any(|name| name.contains(['\n', '\0']))
    {
        return Err(KeychainItemRefusal::UnwritableName);
    }
    // Room for the words, each name doubled by escapes, and the hex, so the line never moves.
    let capacity = 64 + 2 * (service.len() + account.len()) + hex.len();
    let mut line = Zeroizing::new(Vec::with_capacity(capacity));
    line.extend_from_slice(b"add-generic-password -U -a ");
    push_quoted(&mut line, account);
    line.extend_from_slice(b" -s ");
    push_quoted(&mut line, service);
    line.extend_from_slice(b" -X \"");
    line.extend_from_slice(hex.as_bytes());
    line.extend_from_slice(b"\"\n");
    if line.len() <= INTERACTIVE_LINE_LIMIT {
        Ok(AddForm::Line(line))
    } else {
        Ok(AddForm::Arguments)
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
