//! The macOS side of the credential store: the login keychain, reached only through Apple's
//! `security` tool, so every item takes the access the tool's writes give it, which trusts the
//! tool, and any build of the daemon reads it with no prompt; its entries capped so an add fits
//! the one line the tool reads it from, the value never on a command line; its search by service;
//! what holds its items; and a locked keychain read from the tool's exit.
//!
//! Each call is one run of the tool, started where the call runs and held to the store's call
//! time: a prompt the person leaves open past it ends the run, so the caller's turn at the store
//! is let go.

#[cfg(test)]
mod tests;

use std::any::Any;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry};
use secrecy::zeroize::Zeroizing;

use crate::KeychainItemRefusal;
use crate::credential_store::KEYCHAIN_CALL_TIMEOUT;
use crate::macos::keychain_tool::printed_form::{listed_items, password_from_errors};
use crate::macos::keychain_tool::{
    Capture, INTERACTIVE_LINE_LIMIT, SECURITY_PROGRAM, ToolAnswer, ToolEnd, add_line, run_tool,
    start_here, tool_answer,
};

/// What holds the items, for the service log.
pub(crate) const DESCRIPTION: &str = "the login keychain, through the security tool";

/// The settings every entry is built with: the login keychain's own.
pub(crate) const ENTRY_MODIFIERS: &[(&str, &str)] = &[];

/// The most bytes one entry holds: its add, the value in hex beside the item's names, fits the
/// tool's 4,095-byte line with about 900 bytes left for the names.
pub(crate) const ENTRY_CAPACITY: Option<usize> = Some(1536);

/// The login keychain through Apple's tool. Never fails.
#[expect(
    clippy::unnecessary_wraps,
    reason = "each platform's store opens through one signature, and Windows' can fail"
)]
pub(crate) fn open_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Ok(KeychainToolStore::over_program(
        PathBuf::from(SECURITY_PROGRAM),
        KEYCHAIN_CALL_TIMEOUT,
    ))
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

/// The login keychain, each call one run of `program`, Apple's tool or a test's stand-in, ended
/// past `run_bound`.
#[derive(Debug)]
pub(crate) struct KeychainToolStore {
    program: PathBuf,
    run_bound: Duration,
}

impl KeychainToolStore {
    /// The store whose calls run `program`, each ended past `run_bound`.
    pub(crate) fn over_program(program: PathBuf, run_bound: Duration) -> Arc<Self> {
        Arc::new(Self { program, run_bound })
    }

    fn item(&self, service: String, account: String) -> Entry {
        Entry::new_with_credential(Arc::new(ToolItem {
            program: self.program.clone(),
            run_bound: self.run_bound,
            service,
            account,
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
        Ok(self.item(service.to_owned(), account.to_owned()))
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
        let ended = run_tool(
            start_here,
            &self.program,
            &[OsStr::new("dump-keychain")],
            None,
            Capture::Output,
            self.run_bound,
        )
        .map_err(store_error)?;
        if tool_answer(ended.status).map_err(store_error)? == ToolAnswer::NoItem {
            return Ok(Vec::new());
        }
        Ok(listed_items(&ended.printed)
            .into_iter()
            .filter(|listed| listed.service == *service)
            .map(|listed| self.item(listed.service, listed.account))
            .collect())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// One item of the keychain, by its service and account, each call ended past `run_bound`.
#[derive(Debug)]
struct ToolItem {
    program: PathBuf,
    run_bound: Duration,
    service: String,
    account: String,
}

impl ToolItem {
    // Runs the tool's `command` on this item, then `rest`, reading the stream `capture` names.
    fn run_named(
        &self,
        command: &str,
        rest: &[&str],
        capture: Capture,
    ) -> Result<ToolEnd, KeychainItemRefusal> {
        let names = [command, "-a", &self.account, "-s", &self.service];
        let arguments: Vec<&OsStr> = names.iter().chain(rest).map(OsStr::new).collect();
        run_tool(
            start_here,
            &self.program,
            &arguments,
            None,
            capture,
            self.run_bound,
        )
    }

    // The add of `hex`, updating an item already there; past the tool's line refused as too long
    // for one entry.
    fn add_line(&self, hex: &str) -> keyring_core::Result<Zeroizing<Vec<u8>>> {
        add_line(&["-U"], &self.service, &self.account, hex)
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
    // Adds the item through `security -i`, the add's one line on the tool's standard input; an
    // item already there is updated in place, its attributes and access left as they are.
    fn set_secret(&self, secret: &[u8]) -> keyring_core::Result<()> {
        let mut hex_buffer = Zeroizing::new(vec![0; secret.len() * 2]);
        let hex = base16ct::lower::encode_str(secret, &mut hex_buffer)
            .expect("the buffer holds twice the value's bytes");
        let line = self.add_line(hex)?;
        let status = run_tool(
            start_here,
            &self.program,
            &[OsStr::new("-i")],
            Some(&line),
            Capture::Output,
            self.run_bound,
        )
        .map_err(store_error)?
        .status;
        match tool_answer(status).map_err(store_error)? {
            ToolAnswer::Done => Ok(()),
            ToolAnswer::NoItem => Err(store_error(KeychainItemRefusal::Ended(status))),
        }
    }

    // Reads the item with `-g`, whose password line prints the value unambiguously, where `-w`
    // prints a value that is hex text the same way as one printed as hex.
    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        let ended = self
            .run_named("find-generic-password", &["-g"], Capture::Errors)
            .map_err(store_error)?;
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
        let ended = self
            .run_named("delete-generic-password", &[], Capture::Output)
            .map_err(store_error)?;
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
