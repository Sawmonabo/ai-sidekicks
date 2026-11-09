//! The move of a provider's sign-ins between the login keychain and files, each sign-in named by
//! its caller: into files at mode `0600` when the service runs while its account is logged out,
//! where the keychain is locked, and back into the keychain when that ends. Each sign-in is
//! written at its destination, read back, and only then deleted from its source, so a move stopped
//! partway finishes on the next call in the same direction. The same keychain tool the move runs
//! reads and deletes one sign-in's item for a provider's driver, so the item is reached the way its
//! provider reaches it and never by the daemon's own signature. macOS supplies the move in its own
//! module; on any other system, where a provider keeps its sign-in in a file already,
//! [`SignInMove`] has no value, so [`sign_in_move`] answers `None` there and nothing else is
//! called.

use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;

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
/// are where they were, the one it stopped at in both places where [`SignInMoveError::CopyLeft`]
/// says so or where a write that outlasted its bound lands after the move stopped. It never
/// carries a sign-in's bytes, the keychain tool's output, nor its file's path, which names the
/// account's home.
#[derive(Debug, thiserror::Error)]
pub enum SignInMoveError {
    /// The keychain refused or could not answer a call on the item.
    #[error("the keychain item {service} for {account} could not be used")]
    Keychain {
        /// The item's service.
        service: String,
        /// The item's account.
        account: String,
        /// The keychain's refusal.
        #[source]
        refusal: KeychainItemRefusal,
    },
    /// The sign-in's file could not be read, removed or flushed.
    #[error("the sign-in file could not be used")]
    File(#[source] io::Error),
    /// The sign-in's file could not be written, for the reason its kind names; the write's own
    /// error is not kept, since it can name the file's folder.
    #[error("the sign-in file could not be written: {0}")]
    Write(io::ErrorKind),
    /// The copy read back from the destination differs from the source, so the source is kept.
    #[error("the sign-in copied to {destination} read back differently")]
    CopyDiffers {
        /// The destination in words: a keychain item's service and account, or the sign-in file,
        /// never its path.
        destination: String,
    },
    /// A step of the move outlasted the caller's bound, so the move stopped there, the step's
    /// child ended.
    #[error("a step of the sign-in move outlasted its bound, so the move stopped")]
    Overran,
    /// The move was refused after the sign-in's copy was written, and the copy stays at its
    /// destination for the reason `cause` names.
    #[error(
        "the sign-in copied to {destination} stays there after the move was refused, since {cause}"
    )]
    CopyLeft {
        /// The destination in words, as [`SignInMoveError::CopyDiffers`] names it.
        destination: String,
        /// Why the copy stays.
        cause: CopyLeftCause,
        /// Why the move was refused.
        #[source]
        refusal: Box<SignInMoveError>,
    },
}

/// Why a refused move's copy stays at its destination, with the failure that kept it where one
/// did.
#[derive(Debug, thiserror::Error)]
pub enum CopyLeftCause {
    /// The source no longer holds the sign-in the copy was made from, so the copy may be the only
    /// one left.
    #[error("its source no longer holds the same sign-in")]
    SourceNotSame,
    /// The source could not be read again, so whether it still holds the sign-in is not known.
    #[error("its source could not be read ({0})")]
    SourceUnreadable(Box<SignInMoveError>),
    /// The copy's delete failed.
    #[error("the copy could not be deleted ({0})")]
    CopyUndeletable(Box<SignInMoveError>),
    /// A step outlasted its bound, which stops the move with no further step.
    #[error("a step outlasted its bound")]
    Overran,
}

/// Why the keychain refused a call on a sign-in's item, as the keychain tool's exit answers it.
#[derive(Debug, thiserror::Error)]
pub enum KeychainItemRefusal {
    /// The login keychain is locked, as it is while the account is logged out.
    #[error("the login keychain is locked")]
    Locked,
    /// The account has no login keychain to hold the item.
    #[error("this account has no login keychain")]
    NoLoginKeychain,
    /// The keychain tool ended with a code or a signal no other refusal names.
    #[error("the keychain tool ended with {0}")]
    Ended(ExitStatus),
    /// The keychain tool could not be started, or its input or output failed.
    #[error("the keychain tool could not be reached")]
    Unreachable(#[source] io::Error),
    /// The item's service or account holds a line break or a NUL, which the tool's input line
    /// cannot carry.
    #[error("the item's name holds a line break or a NUL")]
    UnwritableName,
    /// The keychain tool gave no answer within the call's bound, as while a prompt stays open,
    /// so it was ended.
    #[error("the keychain tool gave no answer in time")]
    Unanswered,
}

/// The sign-in move on a system with none built: the type has no value, so no method is ever
/// called.
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, Debug)]
pub enum SignInMove {}

#[cfg(not(target_os = "macos"))]
impl SignInMove {
    /// Moves sign-ins into files; never called, since no value exists.
    pub async fn move_into_files(
        &self,
        _spawner: &crate::Spawner,
        _sign_ins: &[KeychainSignIn],
        _step_bound: std::time::Duration,
    ) -> Result<(), SignInMoveError> {
        match *self {}
    }

    /// Moves sign-ins back into the keychain; never called, since no value exists.
    pub async fn move_into_keychain(
        &self,
        _spawner: &crate::Spawner,
        _sign_ins: &[KeychainSignIn],
        _step_bound: std::time::Duration,
    ) -> Result<(), SignInMoveError> {
        match *self {}
    }

    /// Removes a stopped move's leftovers; never called, since no value exists.
    pub fn remove_leftovers(&self, _sign_in_files: &[PathBuf]) -> Vec<io::Error> {
        match *self {}
    }

    /// Reads a keychain item; never called, since no value exists.
    pub async fn read_item(
        &self,
        _spawner: &crate::Spawner,
        _service: &str,
        _account: &str,
        _bound: std::time::Duration,
    ) -> Result<Option<secrecy::zeroize::Zeroizing<Vec<u8>>>, KeychainItemRefusal> {
        match *self {}
    }

    /// Deletes a keychain item; never called, since no value exists.
    pub async fn delete_item(
        &self,
        _spawner: &crate::Spawner,
        _service: &str,
        _account: &str,
        _bound: std::time::Duration,
    ) -> Result<bool, KeychainItemRefusal> {
        match *self {}
    }
}

/// The sign-in move on this system: `None` here, where none is built.
#[cfg(not(target_os = "macos"))]
pub fn sign_in_move() -> Option<SignInMove> {
    None
}
