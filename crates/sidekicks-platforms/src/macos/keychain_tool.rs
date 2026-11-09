//! What every call of Apple's `security` tool shares, whoever makes it: the tool's path, how its
//! exit reads as the keychain's answer, the line `security -i` reads an add from, and the buffer a
//! value read from its output grows in.

use std::process::ExitStatus;

use secrecy::zeroize::Zeroizing;

use crate::KeychainItemRefusal;

/// The keychain tool, by its full path so no `PATH` entry stands in for it.
pub(crate) const SECURITY_PROGRAM: &str = "/usr/bin/security";

/// The longest line, its newline included, `security -i` reads as one command: it reads each line
/// into a 4096-byte buffer and splits a longer one silently, so a line past this is never sent.
pub(crate) const INTERACTIVE_LINE_LIMIT: usize = 4095;

/// The tool's exit for `errSecDuplicateItem`: an add without `-U` met an item already there.
pub(crate) const DUPLICATE_ITEM: i32 = 45;

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

/// An empty buffer for the tool's output, wiped when dropped.
pub(crate) fn output_buffer() -> Zeroizing<Vec<u8>> {
    Zeroizing::new(Vec::with_capacity(OUTPUT_START_CAPACITY))
}

/// Makes room in `held` for the next read: a full buffer is copied into one of twice its size and
/// wiped, so no copy of the output is left behind in freed memory.
pub(crate) fn make_room(held: &mut Zeroizing<Vec<u8>>) {
    if held.len() == held.capacity() {
        let mut larger = Zeroizing::new(Vec::with_capacity(held.capacity() * 2));
        larger.extend_from_slice(held);
        *held = larger;
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
