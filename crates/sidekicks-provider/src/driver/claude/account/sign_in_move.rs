//! The move of each registered Claude Code account's sign-in between the keychain item Claude
//! Code files for that account's store folder and the `.credentials.json` it keeps there where the
//! keychain is not used: into the files while the service runs while the person is logged out, and
//! back once that service is removed. The direction is where the daemon's own secrets go, read from
//! their place record, so a move stopped partway finishes on the next call the same way. Each
//! account moves under its home's lock and never while a sign-in or a turn holds that home. The
//! keychain is read first outside that lock, and every keychain call is bounded, since a locked
//! keychain or an access prompt may never answer: a step past its bound stops the move before the
//! next, and the whole move under the lock is bounded too, so a prompt left open never keeps the
//! home from a sign-in, the observer or a reset. Past that bound the home is let go and the account
//! is unmovable until its last call ends, so no second move runs beside it; that call may still
//! land once the home is free. A move stopped mid-write leaves a temporary file beside the sign-in
//! file, which the daemon's start sweeps.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the logged-out service's install and uninstall")
)]

use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::slice;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{
    CredentialStore, KeychainSignIn, SignInMoveError, create_missing_private_folders, sign_in_move,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::place::{
    PlaceRecord, SecretsPlace, read_record, record_path,
};

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::registry::{ProviderAccountRegistry, RegisteredAccount};
use crate::account::resolver::credential_home_folders;
use crate::account::sign_in::AccountsSigningIn;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, claude_keychain_account, claude_keychain_service,
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
    /// The accounts with a sign-in in flight, each of which holds its account's home.
    pub(crate) signing_in: &'a AccountsSigningIn,
    /// The turns live on each account, each of which holds its account's home.
    pub(crate) live_turns: &'a dyn AccountLiveTurns,
    /// The person's login keychain.
    pub(crate) keychain: &'a CredentialStore,
    /// How long one keychain call, and one account's whole move under its home's lock, may run
    /// before the move stops, [`CLAUDE_SIGN_IN_MOVE_KEYCHAIN_WAIT`] outside a test.
    pub(crate) keychain_wait: Duration,
    /// The accounts whose move outlasted its bound and still runs, kept across moves.
    pub(crate) unmovable: &'a ClaudeUnmovableSignIns,
}

/// The accounts whose sign-in move outlasted its bound and still runs on its blocking thread, each
/// unmovable until that move ends.
#[derive(Clone, Default)]
pub(crate) struct ClaudeUnmovableSignIns(Arc<Mutex<HashSet<ProviderAccountId>>>);

impl ClaudeUnmovableSignIns {
    // Whether a move of `provider_account_id` outlasted its bound and still runs.
    fn contains(&self, provider_account_id: &ProviderAccountId) -> bool {
        lock(&self.0).contains(provider_account_id)
    }

    // Marks `provider_account_id` unmovable until the answered mark is dropped, which the move's
    // blocking task does as it ends.
    fn mark(&self, provider_account_id: ProviderAccountId) -> UnmovableMark {
        lock(&self.0).insert(provider_account_id.clone());
        UnmovableMark {
            accounts: self.clone(),
            provider_account_id,
        }
    }
}

// One account's mark in `ClaudeUnmovableSignIns`, let go when dropped.
struct UnmovableMark {
    accounts: ClaudeUnmovableSignIns,
    provider_account_id: ProviderAccountId,
}

impl Drop for UnmovableMark {
    fn drop(&mut self) {
        lock(&self.accounts.0).remove(&self.provider_account_id);
    }
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
    /// A keychain call or the account's whole move did not answer within the bound, as a prompt
    /// left open does not, or an earlier move of the account that did not still runs; the move
    /// stopped, and the account's sign-in is where it was or in both places.
    #[error("the keychain did not answer for the Claude Code account in time")]
    KeychainUnanswered {
        /// The account.
        provider_account_id: ProviderAccountId,
    },
}

/// How long one keychain call of the move may run before the move stops: the daemon's stop drain.
pub(crate) const CLAUDE_SIGN_IN_MOVE_KEYCHAIN_WAIT: Duration =
    Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS);

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
    /// observation there ends, for at most the bound, past which the hold is let go and the
    /// account stays unmovable until its move ends. Fails at once with
    /// [`ClaudeSignInMoveError::HomeInUse`] at the first account a sign-in or a turn holds, with
    /// [`ClaudeSignInMoveError::KeychainUnanswered`] where a keychain call or the move outlasts its
    /// bound or the account is unmovable, and otherwise as [`ClaudeSignInMoveError`] says; the
    /// next call finishes the move.
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
            if bounds.unmovable.contains(provider_account_id) {
                return Err(ClaudeSignInMoveError::KeychainUnanswered {
                    provider_account_id: provider_account_id.clone(),
                });
            }
            // Refused before any wait, as the hold below may wait behind an observation.
            if is_home_in_use(&bounds, provider_account_id) {
                return Err(ClaudeSignInMoveError::HomeInUse {
                    provider_account_id: provider_account_id.clone(),
                });
            }
            let folders = ClaudeAccountFolders::from(&credential_home_folders(
                &account.provider,
                &account.credential_home,
            ));
            let environment = self
                .compose_environment_on(ClaudeProcessHome::Account { folders: &folders })
                .map_err(ClaudeSignInMoveError::Environment)?;
            let sign_in = KeychainSignIn {
                service: claude_keychain_service(&environment),
                account: claude_keychain_account(&environment),
                file: sign_in_file(account),
            };
            // Read before the home is held: a locked keychain refuses here and a prompt waits here,
            // while every observation, switch and sign-in on the home goes on.
            let keychain = bounds.keychain.clone();
            let item = sign_in.clone();
            call_keychain_within(bounds.keychain_wait, provider_account_id, move || {
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
            if is_home_in_use(&bounds, provider_account_id) {
                return Err(ClaudeSignInMoveError::HomeInUse {
                    provider_account_id: provider_account_id.clone(),
                });
            }
            let keychain = bounds.keychain.clone();
            let step_bound = bounds.keychain_wait;
            // Unmovable until the task ends, whether or not the hold outlasts it.
            let running = bounds.unmovable.mark(provider_account_id.clone());
            // The move bounds each of its own steps, so a step past its bound stops it before the
            // next; the whole task is bounded here, so a step that never answers lets the home go.
            let moving = tokio::task::spawn_blocking(move || {
                let _running = running;
                match direction {
                    MoveDirection::IntoFiles => {
                        let folder = sign_in
                            .file
                            .parent()
                            .expect("a sign-in's file has a folder");
                        create_missing_private_folders(folder)
                            .map_err(ClaudeSignInMoveError::StoreFolder)?;
                        Ok(mover.move_into_files(
                            &keychain,
                            slice::from_ref(&sign_in),
                            step_bound,
                        )?)
                    }
                    MoveDirection::IntoKeychain => Ok(mover.move_into_keychain(
                        &keychain,
                        slice::from_ref(&sign_in),
                        step_bound,
                    )?),
                }
            });
            let Ok(joined) = tokio::time::timeout(bounds.keychain_wait, moving).await else {
                return Err(ClaudeSignInMoveError::KeychainUnanswered {
                    provider_account_id: provider_account_id.clone(),
                });
            };
            let moved = joined.map_err(ClaudeSignInMoveError::Stopped)?;
            if let Err(ClaudeSignInMoveError::Move(SignInMoveError::Overran)) = &moved {
                return Err(ClaudeSignInMoveError::KeychainUnanswered {
                    provider_account_id: provider_account_id.clone(),
                });
            }
            moved?;
        }
        tracing::info!(
            accounts = accounts.len(),
            direction = ?direction,
            "the Claude Code sign-ins moved"
        );
        Ok(())
    }
}

/// Removes the temporary files a sign-in move stopped mid-write left beside each registered
/// Claude Code account's sign-in file, as the daemon's start does before any move can run;
/// nothing on a system with no move. Answers each leftover that could not be removed, for the
/// caller to log. Fails when the accounts cannot be listed, or the sweep's task ended without
/// an answer.
pub(crate) async fn remove_claude_sign_in_move_leftovers(
    registry: &ProviderAccountRegistry,
) -> Result<Vec<io::Error>, ClaudeSignInMoveError> {
    let Some(mover) = sign_in_move() else {
        return Ok(Vec::new());
    };
    let files: Vec<PathBuf> = registry
        .list(Some(DESCRIPTOR.provider_id()))
        .await?
        .iter()
        .map(sign_in_file)
        .collect();
    tokio::task::spawn_blocking(move || mover.remove_leftovers(&files))
        .await
        .map_err(ClaudeSignInMoveError::Stopped)
}

// The file `account`'s sign-in moves into where the keychain is not used: `.credentials.json` in
// its credential store folder.
fn sign_in_file(account: &RegisteredAccount) -> PathBuf {
    credential_home_folders(&account.provider, &account.credential_home)
        .credential_store_folder
        .join(CLAUDE_CREDENTIALS_FILE)
}

// Whether a sign-in in flight or a live turn holds `provider_account_id`'s home.
fn is_home_in_use(
    bounds: &ClaudeSignInMoveBounds<'_>,
    provider_account_id: &ProviderAccountId,
) -> bool {
    bounds.signing_in.is_signing_in(provider_account_id)
        || !bounds
            .live_turns
            .sessions_with_live_turns(provider_account_id)
            .is_empty()
}

// Runs the blocking keychain `call` for `provider_account_id`'s sign-in on a blocking thread and
// waits at most `wait` for it: one that has not answered by then is left to end on its own, and the
// move stops naming the account. Only a read before the home is held runs here, so a call left
// running changes nothing.
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
