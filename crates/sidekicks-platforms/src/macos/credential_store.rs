//! The macOS side of the credential store: the login keychain, reached only through Apple's
//! `security` tool, so every item takes the access the tool's writes give it, which trusts the
//! tool, and any build of the daemon reads it with no prompt; its entries capped so an add fits
//! the one line the tool reads it from, the value never on a command line; its search by service;
//! what holds its items; a locked keychain read from the tool's exit; and the items another writer
//! made, which the store rewrites once through the tool.
//!
//! Each call is one run of the tool, started where the call runs and waited for to its end: a
//! prompt holds the call until the person answers it, which the caller's turn at the store bounds.

mod printed_form;
#[cfg(test)]
mod tests;

use std::any::Any;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::io::{self, Read, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry};
use secrecy::zeroize::Zeroizing;

use self::printed_form::{listed_items, password_from_errors};
use crate::KeychainItemRefusal;
use crate::macos::keychain_tool::{
    DUPLICATE_ITEM, INTERACTIVE_LINE_LIMIT, SECURITY_PROGRAM, ToolAnswer, add_line, make_room,
    output_buffer, tool_answer,
};

/// What holds the items, for the service log.
pub(crate) const DESCRIPTION: &str = "the login keychain, through the security tool";

/// The settings every entry is built with: the login keychain's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The most bytes one entry holds: its add, the value in hex beside the item's names, fits the
/// tool's 4,095-byte line with about 900 bytes left for the names.
pub(crate) const ENTRY_CAPACITY: Option<usize> = Some(1536);

/// The check that a listed entry was written through this store, so an item another writer made
/// is rewritten through it once.
pub(crate) const ADOPTION: Option<fn(&Entry) -> bool> = Some(is_adopted);

// The creator code every item this store adds carries, which marks it as written through the tool.
const CREATOR: &str = "aisk";

/// The login keychain through Apple's tool. Never fails.
#[expect(
    clippy::unnecessary_wraps,
    reason = "each platform's store opens through one signature, and Windows' can fail"
)]
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Ok(KeychainToolStore::over_program(PathBuf::from(
        SECURITY_PROGRAM,
    )))
}

/// The search for the items filed under `service`: the dump is kept to the items whose service is
/// exactly `service`.
pub(crate) fn search_spec(service: &str) -> Vec<(&'static str, String)> {
    vec![("service", service.to_owned())]
}

/// Whether the keychain's `failure` says it is locked or its prompt was dismissed; every other
/// end of the tool means it cannot be used.
pub(crate) fn is_locked(failure: &(dyn Error + 'static)) -> bool {
    matches!(
        failure.downcast_ref::<KeychainItemRefusal>(),
        Some(KeychainItemRefusal::Locked)
    )
}

// Whether `entry` was written through this store: an entry a listing found another writer made
// is not; one built or written here always is.
fn is_adopted(entry: &Entry) -> bool {
    entry
        .as_any()
        .downcast_ref::<ToolItem>()
        .is_none_or(|item| item.is_written_here)
}

/// The login keychain, each call one run of `program`, Apple's tool or a test's stand-in.
#[derive(Debug)]
pub(crate) struct KeychainToolStore {
    program: PathBuf,
}

impl KeychainToolStore {
    /// The store whose calls run `program`.
    pub(crate) fn over_program(program: PathBuf) -> Arc<Self> {
        Arc::new(Self { program })
    }

    fn item(&self, service: String, account: String, is_written_here: bool) -> Entry {
        Entry::new_with_credential(Arc::new(ToolItem {
            program: self.program.clone(),
            service,
            account,
            is_written_here,
        }))
    }
}

impl CredentialStoreApi for KeychainToolStore {
    fn vendor(&self) -> String {
        String::from("the login keychain, through Apple's security tool")
    }

    fn id(&self) -> String {
        String::from("keychain-tool")
    }

    fn build(
        &self,
        service: &str,
        account: &str,
        _modifiers: Option<&HashMap<&str, &str>>,
    ) -> keyring_core::Result<Entry> {
        Ok(self.item(service.to_owned(), account.to_owned(), true))
    }

    // Every generic password whose service is the one the search names, from one dump of the
    // keychain's attributes, which reads no item's value and so raises no access prompt.
    fn search(&self, spec: &HashMap<&str, &str>) -> keyring_core::Result<Vec<Entry>> {
        let Some(service) = spec.get("service") else {
            return Err(keyring_core::Error::Invalid(
                String::from("service"),
                String::from("the search names no service"),
            ));
        };
        let ended = run_tool(&self.program, &["dump-keychain"], None, Capture::Output)
            .map_err(store_error)?;
        if tool_answer(ended.status).map_err(store_error)? == ToolAnswer::NoItem {
            return Ok(Vec::new());
        }
        Ok(listed_items(&ended.printed, CREATOR.as_bytes())
            .into_iter()
            .filter(|listed| listed.service == *service)
            .map(|listed| self.item(listed.service, listed.account, listed.has_creator))
            .collect())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// One item of the keychain, by its service and account, and whether a listing found it written
// through this store.
#[derive(Debug)]
struct ToolItem {
    program: PathBuf,
    service: String,
    account: String,
    is_written_here: bool,
}

impl ToolItem {
    // The tool's arguments for `command` on this item, then `rest`.
    fn named<'a>(&'a self, command: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
        let names = [command, "-a", &self.account, "-s", &self.service];
        names.iter().chain(rest).copied().collect()
    }

    // Runs `line` through `security -i`, the add's one line on the tool's standard input.
    fn add(&self, line: &[u8]) -> Result<ExitStatus, KeychainItemRefusal> {
        Ok(run_tool(&self.program, &["-i"], Some(line), Capture::Nothing)?.status)
    }

    // The add of `hex` with `options`, past the tool's line refused as too long for one entry.
    fn add_line(&self, options: &[&str], hex: &str) -> keyring_core::Result<Zeroizing<Vec<u8>>> {
        add_line(options, &self.service, &self.account, hex)
            .map_err(store_error)?
            .ok_or_else(|| {
                keyring_core::Error::TooLong(
                    String::from("the item's names"),
                    u32::try_from(INTERACTIVE_LINE_LIMIT).expect("the line limit fits a u32"),
                )
            })
    }
}

impl CredentialApi for ToolItem {
    // Adds the item marked with this store's creator code; an item already there is updated in
    // place, its attributes and access left as they are.
    fn set_secret(&self, secret: &[u8]) -> keyring_core::Result<()> {
        let mut hex_buffer = Zeroizing::new(vec![0; secret.len() * 2]);
        let hex = base16ct::lower::encode_str(secret, &mut hex_buffer)
            .expect("the buffer holds twice the value's bytes");
        let mut status = self
            .add(&self.add_line(&["-c", CREATOR], hex)?)
            .map_err(store_error)?;
        if status.code() == Some(DUPLICATE_ITEM) {
            status = self
                .add(&self.add_line(&["-U"], hex)?)
                .map_err(store_error)?;
        }
        match tool_answer(status).map_err(store_error)? {
            ToolAnswer::Done => Ok(()),
            ToolAnswer::NoItem => Err(store_error(KeychainItemRefusal::Ended(status))),
        }
    }

    // Reads the item with `-g`, whose password line prints the value unambiguously, where `-w`
    // prints a value that is hex text the same way as one printed as hex.
    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        let arguments = self.named("find-generic-password", &["-g"]);
        let ended =
            run_tool(&self.program, &arguments, None, Capture::Errors).map_err(store_error)?;
        match tool_answer(ended.status).map_err(store_error)? {
            ToolAnswer::Done => password_from_errors(&ended.printed)
                .map(|value| value.to_vec())
                .ok_or_else(|| {
                    keyring_core::Error::PlatformFailure(Box::new(io::Error::other(
                        "the keychain tool printed no password line",
                    )))
                }),
            ToolAnswer::NoItem => Err(keyring_core::Error::NoEntry),
        }
    }

    fn delete_credential(&self) -> keyring_core::Result<()> {
        let arguments = self.named("delete-generic-password", &[]);
        let ended =
            run_tool(&self.program, &arguments, None, Capture::Nothing).map_err(store_error)?;
        match tool_answer(ended.status).map_err(store_error)? {
            ToolAnswer::Done => Ok(()),
            ToolAnswer::NoItem => Err(keyring_core::Error::NoEntry),
        }
    }

    fn get_credential(&self) -> keyring_core::Result<Option<Arc<Credential>>> {
        Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
        Some((self.service.clone(), self.account.clone()))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// Which of the tool's streams a call reads; the other two are closed.
#[derive(Clone, Copy)]
enum Capture {
    Nothing,
    Output,
    Errors,
}

// How one run of the tool ended: its exit and the stream it was asked for, wiped when dropped.
struct ToolEnd {
    status: ExitStatus,
    printed: Zeroizing<Vec<u8>>,
}

// Runs `program` with `arguments`, `line` written to its standard input and closed, and reads the
// stream `capture` names to its end. Fails with `Unreachable` when the tool cannot be started or a
// stream fails.
fn run_tool(
    program: &Path,
    arguments: &[&str],
    line: Option<&[u8]>,
    capture: Capture,
) -> Result<ToolEnd, KeychainItemRefusal> {
    let piped_if = |is_piped: bool| {
        if is_piped {
            Stdio::piped()
        } else {
            Stdio::null()
        }
    };
    let mut child = Command::new(program)
        .args(arguments.iter().map(OsStr::new))
        .stdin(piped_if(line.is_some()))
        .stdout(piped_if(matches!(capture, Capture::Output)))
        .stderr(piped_if(matches!(capture, Capture::Errors)))
        .spawn()
        .map_err(KeychainItemRefusal::Unreachable)?;
    let talked = talk(&mut child, line, capture);
    let status = child.wait().map_err(KeychainItemRefusal::Unreachable)?;
    Ok(ToolEnd {
        status,
        printed: talked.map_err(KeychainItemRefusal::Unreachable)?,
    })
}

// Writes `line` to the child's standard input and closes it, then reads the stream `capture`
// names to its end.
fn talk(
    child: &mut std::process::Child,
    line: Option<&[u8]>,
    capture: Capture,
) -> io::Result<Zeroizing<Vec<u8>>> {
    if let (Some(mut input), Some(line)) = (child.stdin.take(), line) {
        input.write_all(line)?;
    }
    match capture {
        Capture::Nothing => Ok(output_buffer()),
        Capture::Output => read_wiped(child.stdout.as_mut().expect("the output is piped")),
        Capture::Errors => read_wiped(child.stderr.as_mut().expect("the errors are piped")),
    }
}

// Reads `reader` to its end into a buffer wiped when dropped, grown without leaving a copy.
fn read_wiped(reader: &mut impl Read) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut held = output_buffer();
    loop {
        make_room(&mut held);
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

// `refusal` as the store's error, which carries it whole for the locked reading.
fn store_error(refusal: KeychainItemRefusal) -> keyring_core::Error {
    match refusal {
        KeychainItemRefusal::NoLoginKeychain => {
            keyring_core::Error::NoStorageAccess(Box::new(refusal))
        }
        KeychainItemRefusal::Locked
        | KeychainItemRefusal::Ended(_)
        | KeychainItemRefusal::Unreachable(_)
        | KeychainItemRefusal::UnwritableName
        | KeychainItemRefusal::Unanswered => {
            keyring_core::Error::PlatformFailure(Box::new(refusal))
        }
    }
}
