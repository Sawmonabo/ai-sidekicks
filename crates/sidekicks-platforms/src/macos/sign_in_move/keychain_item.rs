//! A sign-in's keychain item, reached only through Apple's `security` tool: read with
//! `find-generic-password -g`, written with `add-generic-password -U` on the tool's standard input,
//! and deleted with `delete-generic-password`. The provider reaches the item the same way, so the
//! item keeps the access list the tool's writes give it, which trusts the tool, and neither side
//! meets a prompt. A sign-in too long for the tool's input line is never written: it is never sent
//! as arguments, which every process on the machine can read.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;

use secrecy::zeroize::Zeroizing;
use tokio::runtime::Handle;

use super::SignInPlace;
use crate::macos::keychain_tool::printed_form::password_from_errors;
use crate::macos::keychain_tool::{Capture, ToolAnswer, ToolEnd, add_line, run_tool, tool_answer};
use crate::spawner::Spawner;
use crate::{KeychainItemRefusal, SignInMoveError};

/// A sign-in's keychain item, each call one child of the keychain tool held to the step bound.
pub(super) struct KeychainItem<'a> {
    service: &'a str,
    account: &'a str,
    spawner: &'a Spawner,
    security_program: &'a Path,
    step_bound: Duration,
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
                self.named_arguments("find-generic-password", &["-g"]),
                None,
                Capture::Errors,
            )
            .await?;
        match tool_answer(ended.status)? {
            ToolAnswer::Done => password_from_errors(&ended.printed)
                .map(Some)
                .ok_or_else(|| {
                    KeychainItemRefusal::Unreachable(io::Error::other(
                        "the keychain tool printed no password line",
                    ))
                }),
            ToolAnswer::NoItem => Ok(None),
        }
    }

    /// Deletes the item, answering whether there was one. Fails as [`Self::read_value`] does.
    pub(super) async fn delete_value(&self) -> Result<bool, KeychainItemRefusal> {
        let ended = self
            .run(
                self.named_arguments("delete-generic-password", &[]),
                None,
                Capture::Output,
            )
            .await?;
        match tool_answer(ended.status)? {
            ToolAnswer::Done => Ok(true),
            ToolAnswer::NoItem => Ok(false),
        }
    }

    // Holds `value` in the item, in place of anything held before, its access list kept. Fails
    // with `TooLongForTheKeychainTool` when the add's line would run past the tool's, nothing
    // written, and as `read_value` does.
    async fn write_value(&self, value: &[u8]) -> Result<(), SignInMoveError> {
        let mut hex_buffer = Zeroizing::new(vec![0; value.len() * 2]);
        let hex = base16ct::lower::encode_str(value, &mut hex_buffer)
            .expect("the buffer holds twice the value's bytes");
        let line = add_line(&["-U"], self.service, self.account, hex)
            .map_err(|refusal| self.refused(refusal))?
            .ok_or_else(|| SignInMoveError::TooLongForTheKeychainTool {
                service: self.service.to_owned(),
                account: self.account.to_owned(),
            })?;
        let ended = self
            .run(vec![OsString::from("-i")], Some(line), Capture::Output)
            .await
            .map_err(|refusal| self.refused(refusal))?;
        match tool_answer(ended.status).map_err(|refusal| self.refused(refusal))? {
            ToolAnswer::Done => Ok(()),
            ToolAnswer::NoItem => Err(self.refused(KeychainItemRefusal::Ended(ended.status))),
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
    fn named_arguments(&self, command: &str, rest: &[&str]) -> Vec<OsString> {
        [command, "-a", self.account, "-s", self.service]
            .iter()
            .chain(rest)
            .map(OsString::from)
            .collect()
    }

    // Runs the tool with `arguments` and `line` on its standard input, or none, started on the
    // spawner and waited for on a blocking thread within the step bound; past it the tool is
    // ended and reaped before the call answers.
    async fn run(
        &self,
        arguments: Vec<OsString>,
        line: Option<Zeroizing<Vec<u8>>>,
        capture: Capture,
    ) -> Result<ToolEnd, KeychainItemRefusal> {
        let program = self.security_program.to_owned();
        let bound = self.step_bound;
        let (spawner, runtime) = (self.spawner.clone(), Handle::current());
        tokio::task::spawn_blocking(move || {
            let arguments: Vec<&OsStr> = arguments.iter().map(OsString::as_os_str).collect();
            let start = |command| start_on_spawner(&runtime, &spawner, command);
            let line = line.as_deref().map(Vec::as_slice);
            run_tool(start, &program, &arguments, line, capture, bound)
        })
        .await
        .map_err(|stopped| KeychainItemRefusal::Unreachable(io::Error::other(stopped)))?
    }
}

impl SignInPlace for KeychainItem<'_> {
    async fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, SignInMoveError> {
        self.read_value()
            .await
            .map_err(|refusal| self.refused(refusal))
    }

    async fn write(&self, sign_in: &[u8]) -> Result<(), SignInMoveError> {
        self.write_value(sign_in).await
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

// Starts `command` on the spawner's thread, waiting from the blocking thread the call runs on.
fn start_on_spawner(
    runtime: &Handle,
    spawner: &Spawner,
    mut command: Command,
) -> io::Result<Child> {
    runtime
        .block_on(spawner.run(move || command.spawn()))
        .and_then(|spawned| spawned)
}
