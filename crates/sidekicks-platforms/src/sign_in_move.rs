//! The move of a provider's sign-ins between the login keychain and files, each sign-in named by
//! its caller: into files at mode `0600` when the service runs while its account is logged out,
//! where the keychain is locked, and back into the keychain when that ends. Each sign-in is
//! written at its destination, read back, and only then deleted from its source, so a move stopped
//! partway finishes on the next call in the same direction. macOS supplies the move in its own
//! module; on any other system, where a provider keeps its sign-in in a file already,
//! [`SignInMove`] has no value, so [`sign_in_move`] answers `None` there and nothing else is
//! called.

use std::io;
use std::path::PathBuf;

use crate::{AtomicWriteError, CredentialStoreError};

/// One sign-in to move: its keychain item, by service and account, and the file it moves to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeychainSignIn {
    /// The service the keychain item is filed under.
    pub service: String,
    /// The account the keychain item is filed under.
    pub account: String,
    /// The file the sign-in moves to, in a folder that exists.
    pub file: PathBuf,
}

/// Why a sign-in move stopped; every sign-in before it is moved, and it and every one after it
/// are where they were or in both places. It never carries a sign-in's bytes, nor its file's path,
/// which names the account's home.
#[derive(Debug, thiserror::Error)]
pub enum SignInMoveError {
    /// The credential store refused or could not answer a call on the item.
    #[error("the keychain item {service} for {account} could not be used")]
    Store {
        /// The item's service.
        service: String,
        /// The item's account.
        account: String,
        /// The store's refusal.
        #[source]
        source: CredentialStoreError,
    },
    /// The sign-in's file could not be read, removed or flushed.
    #[error("the sign-in file could not be used")]
    File(#[source] io::Error),
    /// The sign-in's file could not be written.
    #[error("the sign-in file could not be written")]
    Write(#[source] AtomicWriteError),
    /// The sign-in's file holds something other than UTF-8 text, which no keychain item holds.
    #[error("the sign-in file is not text")]
    NotText,
    /// The copy read back from the destination differs from the source, so the source is kept.
    #[error("the sign-in copied to {destination} read back differently")]
    CopyDiffers {
        /// The destination, a keychain item's service and account or a file's path.
        destination: String,
    },
    /// A step of the move outlasted the caller's bound, so the move stopped before its next step.
    #[error("a step of the sign-in move outlasted its bound, so the move stopped")]
    Overran,
}

/// The sign-in move on a system with none built: the type has no value, so no method is ever
/// called.
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, Debug)]
pub enum SignInMove {}

#[cfg(not(target_os = "macos"))]
impl SignInMove {
    /// Moves sign-ins into files; never called, since no value exists.
    pub fn move_into_files(
        &self,
        _store: &crate::CredentialStore,
        _sign_ins: &[KeychainSignIn],
        _step_bound: std::time::Duration,
    ) -> Result<(), SignInMoveError> {
        match *self {}
    }

    /// Moves sign-ins back into the keychain; never called, since no value exists.
    pub fn move_into_keychain(
        &self,
        _store: &crate::CredentialStore,
        _sign_ins: &[KeychainSignIn],
        _step_bound: std::time::Duration,
    ) -> Result<(), SignInMoveError> {
        match *self {}
    }

    /// Removes a stopped move's leftovers; never called, since no value exists.
    pub fn remove_leftovers(&self, _sign_in_files: &[PathBuf]) -> Vec<io::Error> {
        match *self {}
    }
}

/// The sign-in move on this system: `None` here, where none is built.
#[cfg(not(target_os = "macos"))]
pub fn sign_in_move() -> Option<SignInMove> {
    None
}
