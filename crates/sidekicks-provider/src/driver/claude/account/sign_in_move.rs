//! The move of each registered Claude Code account's sign-in between the keychain item Claude
//! Code files for that account's store folder and the `.credentials.json` it keeps there where the
//! keychain is not used: into the files while the service runs while the person is logged out, and
//! back once that service is removed. The direction is where the daemon's own secrets go, read from
//! their place record, so a move stopped partway finishes on the next call the same way. Each
//! account moves under its home's lock and never while a sign-in or a turn holds that home. The
//! keychain is read first outside that lock, and every keychain call is bounded, since a locked
//! keychain or an access prompt may never answer.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the logged-out service's install and uninstall")
)]

use std::io;
use std::slice;
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{
    CredentialStore, KeychainSignIn, SignInMoveError, create_missing_private_folders, sign_in_move,
};
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::place::{
    PlaceRecord, SecretsPlace, read_record, record_path,
};

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::registry::ProviderAccountRegistry;
use crate::account::resolver::credential_home_folders;
use crate::account::sign_in::ProviderSignInBroker;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, claude_credential_folder, claude_keychain_account,
    claude_keychain_service,
};
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::contract::error::DriverError;

/// What the move runs over besides the legs: the accounts it moves, the lock each account's home
/// moves under, what holds a home the move refuses, and the keychain the sign-ins leave or reach.
pub(crate) struct ClaudeSignInMoveBounds<'a> {
    /// The registered accounts; only Claude Code's move.
    pub(crate) registry: &'a ProviderAccountRegistry,
    /// The lock every act in an account's home takes, which an observation holds while it reads.
    pub(crate) home_lock: &'a AccountHomeLock,
    /// The sign-ins in flight, each of which holds its account's home.
    pub(crate) sign_ins: &'a ProviderSignInBroker,
    /// The turns live on each account, each of which holds its account's home.
    pub(crate) live_turns: &'a dyn AccountLiveTurns,
    /// The person's login keychain.
    pub(crate) keychain: &'a CredentialStore,
}

/// Why the move stopped; every account before the one it names is moved, and that account's
/// sign-in is where it was or in both places. It never carries a sign-in's bytes.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSignInMoveError {
    /// The daemon's place record could not be read, so the direction is not known.
    #[error("where the daemon's secrets are kept could not be read")]
    Record(#[source] KeychainRefusal),
    /// The registered accounts could not be listed.
    #[error(transparent)]
    Accounts(#[from] ProviderAccountRegistryError),
    /// A sign-in or a turn holds the account's home, so its sign-in is left where it is.
    #[error("a sign-in or a turn holds the Claude Code account's home")]
    HomeInUse {
        /// The account.
        provider_account_id: ProviderAccountId,
    },
    /// The environment Claude Code runs with on the account's home could not be composed.
    #[error("the Claude Code account's environment could not be composed")]
    Environment(#[source] DriverError),
    /// The store folder the sign-in moves into could not be made.
    #[error("the Claude Code account's store folder could not be made")]
    StoreFolder(#[source] io::Error),
    /// The sign-in could not be moved.
    #[error(transparent)]
    Move(#[from] SignInMoveError),
    /// The move's blocking task ended without an answer.
    #[error("the sign-in move ended without an answer")]
    Stopped(#[source] tokio::task::JoinError),
    /// The keychain did not answer within the bound, as a prompt left open does not; the
    /// account's home was let go and its sign-in is where it was or in both places.
    #[error("the keychain did not answer for the Claude Code account in time")]
    KeychainUnanswered {
        /// The account.
        provider_account_id: ProviderAccountId,
    },
}

// How long one keychain call of the move may run before the move stops and lets the account's
// home go: the daemon's stop drain.
const KEYCHAIN_WAIT: Duration = Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS);

// Where the sign-ins go.
#[derive(Clone, Copy, Debug)]
enum MoveDirection {
    IntoFiles,
    IntoKeychain,
}

impl ClaudeAccountLegs {
    /// Moves every registered Claude Code account's sign-in toward where the daemon's place record
    /// says the secrets go: into the files for the service run while logged out, back into the
    /// keychain for the operating system's store, and nothing where no record or a Linux file is
    /// kept, or on a system with no move. Each account moves under its home's hold, after any
    /// observation there ends. Fails with [`ClaudeSignInMoveError::HomeInUse`] at the first account
    /// a sign-in or a turn holds, with [`ClaudeSignInMoveError::KeychainUnanswered`] where a
    /// keychain call outlasts its bound, and otherwise as [`ClaudeSignInMoveError`] says; the next
    /// call finishes the move.
    pub(crate) async fn move_sign_ins(
        &self,
        bounds: ClaudeSignInMoveBounds<'_>,
    ) -> Result<(), ClaudeSignInMoveError> {
        let record = read_record(&record_path(&self.data_folder))
            .await
            .map_err(ClaudeSignInMoveError::Record)?;
        let direction = match record.map(PlaceRecord::destination) {
            Some(SecretsPlace::LoggedOutServiceFile) => MoveDirection::IntoFiles,
            Some(SecretsPlace::OperatingSystem) => MoveDirection::IntoKeychain,
            Some(SecretsPlace::SealedFile | SecretsPlace::PlainFile { .. }) | None => return Ok(()),
        };
        let Some(mover) = sign_in_move() else {
            return Ok(());
        };
        let accounts = bounds.registry.list(Some(DESCRIPTOR.provider_id())).await?;
        for account in &accounts {
            let provider_account_id = &account.account_id;
            let folders = ClaudeAccountFolders::from(&credential_home_folders(
                &account.provider,
                &account.credential_home,
            ));
            let environment = self
                .compose_environment_on(ClaudeProcessHome::Account {
                    folders: &folders,
                    provider_account_id,
                })
                .map_err(ClaudeSignInMoveError::Environment)?;
            let sign_in = KeychainSignIn {
                service: claude_keychain_service(&environment),
                account: claude_keychain_account(&environment),
                file: claude_credential_folder(&environment)
                    .expect("an account's environment names its store folder")
                    .join(CLAUDE_CREDENTIALS_FILE),
            };
            // Read before the home is held: a locked keychain refuses here and a prompt waits here,
            // while every observation, switch and sign-in on the home goes on.
            let keychain = bounds.keychain.clone();
            let item = sign_in.clone();
            call_keychain_within(KEYCHAIN_WAIT, provider_account_id, move || {
                keychain
                    .read(&item.service, &item.account)
                    .map(drop)
                    .map_err(|source| {
                        SignInMoveError::Store {
                            service: item.service,
                            account: item.account,
                            source,
                        }
                        .into()
                    })
            })
            .await?;
            let _hold = bounds.home_lock.hold(provider_account_id.clone()).await;
            if bounds.sign_ins.is_signing_in(provider_account_id)
                || !bounds
                    .live_turns
                    .sessions_with_live_turns(provider_account_id)
                    .is_empty()
            {
                return Err(ClaudeSignInMoveError::HomeInUse {
                    provider_account_id: provider_account_id.clone(),
                });
            }
            let keychain = bounds.keychain.clone();
            call_keychain_within(
                KEYCHAIN_WAIT,
                provider_account_id,
                move || match direction {
                    MoveDirection::IntoFiles => {
                        let folder = sign_in
                            .file
                            .parent()
                            .expect("a sign-in's file has a folder");
                        create_missing_private_folders(folder)
                            .map_err(ClaudeSignInMoveError::StoreFolder)?;
                        Ok(mover.move_into_files(&keychain, slice::from_ref(&sign_in))?)
                    }
                    MoveDirection::IntoKeychain => {
                        Ok(mover.move_into_keychain(&keychain, slice::from_ref(&sign_in))?)
                    }
                },
            )
            .await?;
        }
        tracing::info!(
            accounts = accounts.len(),
            direction = ?direction,
            "the Claude Code sign-ins moved"
        );
        Ok(())
    }
}

// Runs the blocking keychain `call` for `provider_account_id`'s sign-in on a blocking thread and
// waits at most `wait` for it: one that has not answered by then is left to end on its own, and the
// move stops naming the account.
async fn call_keychain_within<Output: Send + 'static>(
    wait: Duration,
    provider_account_id: &ProviderAccountId,
    call: impl FnOnce() -> Result<Output, ClaudeSignInMoveError> + Send + 'static,
) -> Result<Output, ClaudeSignInMoveError> {
    match tokio::time::timeout(wait, tokio::task::spawn_blocking(call)).await {
        Ok(answered) => answered.map_err(ClaudeSignInMoveError::Stopped)?,
        Err(_elapsed) => Err(ClaudeSignInMoveError::KeychainUnanswered {
            provider_account_id: provider_account_id.clone(),
        }),
    }
}

#[cfg(test)]
mod tests;
