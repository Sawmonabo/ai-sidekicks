//! The macOS sign-in move: each named keychain item into its file at mode `0600`, or each file back
//! into its keychain item, every one written, read back and only then deleted from its source. The
//! item is reached only through Apple's `security` tool, as the provider reaches it, so it keeps
//! the access list the tool's writes give it and no prompt appears for either. A move refused once
//! its copy is written deletes the copy where the source still holds the same sign-in, so no
//! sign-in is left in a file the person never chose. Each step is held to the caller's bound, and
//! a step past it stops the move there, so nothing moves on after the caller has stopped waiting.

mod keychain_item;
#[cfg(test)]
mod tests;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use secrecy::zeroize::Zeroizing;
use subtle::ConstantTimeEq as _;

use self::keychain_item::KeychainItem;
use crate::spawner::Spawner;
use crate::{
    KeychainSignIn, LeftoverSweep, SignInMoveError, flush_folder, remove_atomic_write_leftovers,
    replace_file_atomically,
};

// The mode a sign-in's file is written with: its owner reads and writes it, no one else.
const SIGN_IN_FILE_MODE: u32 = 0o600;

// The keychain tool every move reaches the items through, by its full path so no `PATH` entry
// stands in for it.
const SECURITY_PROGRAM: &str = "/usr/bin/security";

/// The sign-in move, which this system supplies.
#[derive(Clone, Debug)]
pub struct SignInMove {
    security_program: PathBuf,
}

/// The sign-in move this system supplies, which macOS always does.
pub fn sign_in_move() -> Option<SignInMove> {
    Some(SignInMove {
        security_program: PathBuf::from(SECURITY_PROGRAM),
    })
}

impl SignInMove {
    /// Moves each of `sign_ins` from its keychain item into its file at mode `0600`, in order: a
    /// sign-in with no item is already moved, or was never there. Starts the keychain tool on
    /// `spawner`. Fails with the first sign-in that cannot be moved, which keeps its item, and
    /// with [`SignInMoveError::Overran`] once a step runs past `step_bound`, the move stopped there
    /// and the step's child ended; either comes inside [`SignInMoveError::CopyLeft`] where the
    /// sign-in's file was written and stays.
    pub async fn move_into_files(
        &self,
        spawner: &Spawner,
        sign_ins: &[KeychainSignIn],
        step_bound: Duration,
    ) -> Result<(), SignInMoveError> {
        for sign_in in sign_ins {
            let item = KeychainItem::new(sign_in, spawner, &self.security_program, step_bound);
            move_sign_in(&item, &SignInFile::new(sign_in, step_bound)).await?;
        }
        Ok(())
    }

    /// Moves each of `sign_ins` from its file back into its keychain item, in order: a sign-in
    /// with no file is already moved, or was never there. Runs and fails as
    /// [`Self::move_into_files`] does, the failing sign-in keeping its file.
    pub async fn move_into_keychain(
        &self,
        spawner: &Spawner,
        sign_ins: &[KeychainSignIn],
        step_bound: Duration,
    ) -> Result<(), SignInMoveError> {
        for sign_in in sign_ins {
            let item = KeychainItem::new(sign_in, spawner, &self.security_program, step_bound);
            move_sign_in(&SignInFile::new(sign_in, step_bound), &item).await?;
        }
        Ok(())
    }

    /// Removes the temporary files a move stopped mid-write left beside each of `sign_in_files`,
    /// the files sign-ins move into, as a start does before any move runs; a live move's file,
    /// held locked, stays. Blocks; answers each folder's listing failure or removal failure, none
    /// once every leftover is gone.
    pub fn remove_leftovers(&self, sign_in_files: &[PathBuf]) -> Vec<io::Error> {
        sign_in_files
            .iter()
            .flat_map(|file| {
                let folder = file.parent().expect("a sign-in's file names its folder");
                let name = file.file_name().expect("a sign-in's file has a name");
                remove_atomic_write_leftovers(folder, |target| name == target)
            })
            .collect()
    }
}

// Where a sign-in is held: a keychain item or a file. Each call is one step of a move, held to the
// move's step bound.
trait SignInPlace {
    // The sign-in held here, `None` when none is.
    async fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, SignInMoveError>;
    // Holds `sign_in` here, in place of anything held before.
    async fn write(&self, sign_in: &[u8]) -> Result<(), SignInMoveError>;
    // Deletes the sign-in held here, nothing when none is.
    async fn delete(&self) -> Result<(), SignInMoveError>;
    // The place in words for an error, never its contents.
    fn describe(&self) -> String;
}

// Moves the sign-in at `source` to `destination`: written, read back and compared in constant
// time, and only then deleted from `source`, the steps `SIGN_IN_MOVE_STEPS` counts, so a stop at
// any step leaves it whole in one place or both, and a refusal once the copy is written takes the
// copy back as `take_copy_back` does.
async fn move_sign_in(
    source: &impl SignInPlace,
    destination: &impl SignInPlace,
) -> Result<(), SignInMoveError> {
    let Some(sign_in) = source.read().await? else {
        return Ok(());
    };
    destination.write(&sign_in).await?;
    let Err(refusal) = check_copy_then_delete_source(source, destination, &sign_in).await else {
        return Ok(());
    };
    Err(take_copy_back(refusal, source, destination, &sign_in).await)
}

// Reads `sign_in`'s copy back from `destination` and, once it is the same, deletes `source`'s.
// Fails with `CopyDiffers` when the copy is not the same, and as a step fails.
async fn check_copy_then_delete_source(
    source: &impl SignInPlace,
    destination: &impl SignInPlace,
    sign_in: &[u8],
) -> Result<(), SignInMoveError> {
    let copy = destination.read().await?;
    if !is_held(copy.as_ref().map(|copy| copy.as_slice()), sign_in) {
        return Err(SignInMoveError::CopyDiffers {
            destination: destination.describe(),
        });
    }
    source.delete().await
}

// `refusal`, a refusal once `sign_in`'s copy was written at `destination`, after the copy is
// deleted where `source` still reads the same sign-in; else `CopyLeft` over `refusal`, the copy
// kept since it may be the only one left. A step past its bound stops the move, so it keeps the
// copy with no further step.
async fn take_copy_back(
    refusal: SignInMoveError,
    source: &impl SignInPlace,
    destination: &impl SignInPlace,
    sign_in: &[u8],
) -> SignInMoveError {
    if !matches!(refusal, SignInMoveError::Overran) {
        let is_source_whole = matches!(
            source.read().await,
            Ok(Some(held)) if is_held(Some(held.as_slice()), sign_in)
        );
        if is_source_whole && destination.delete().await.is_ok() {
            return refusal;
        }
    }
    SignInMoveError::CopyLeft {
        destination: destination.describe(),
        refusal: Box::new(refusal),
    }
}

// Whether `held` is `sign_in`, compared in constant time.
fn is_held(held: Option<&[u8]>, sign_in: &[u8]) -> bool {
    held.is_some_and(|held| bool::from(held.ct_eq(sign_in)))
}

// A sign-in's file, each call run on a blocking thread.
struct SignInFile {
    path: PathBuf,
    step_bound: Duration,
}

impl SignInFile {
    fn new(sign_in: &KeychainSignIn, step_bound: Duration) -> Self {
        Self {
            path: sign_in.file.clone(),
            step_bound,
        }
    }

    // Runs `step` on the file's path on a blocking thread within the step bound; past it the move
    // stops while the step runs on to its end.
    async fn run<Answer: Send + 'static>(
        &self,
        step: impl FnOnce(&Path) -> Result<Answer, SignInMoveError> + Send + 'static,
    ) -> Result<Answer, SignInMoveError> {
        let path = self.path.clone();
        let running = tokio::task::spawn_blocking(move || step(&path));
        match tokio::time::timeout(self.step_bound, running).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(stopped)) => Err(SignInMoveError::File(io::Error::other(stopped))),
            Err(_elapsed) => Err(SignInMoveError::Overran),
        }
    }
}

// Flushes the folder of the sign-in file at `path`, so its write or removal survives a power loss
// before the other place changes.
fn flush_folder_of(path: &Path) -> Result<(), SignInMoveError> {
    let folder = path.parent().expect("a sign-in's file names its folder");
    flush_folder(folder).map_err(SignInMoveError::File)
}

impl SignInPlace for SignInFile {
    async fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, SignInMoveError> {
        self.run(|path| match fs::read(path) {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(SignInMoveError::File(source)),
        })
        .await
    }

    async fn write(&self, sign_in: &[u8]) -> Result<(), SignInMoveError> {
        let sign_in = Zeroizing::new(sign_in.to_vec());
        self.run(move |path| {
            replace_file_atomically(path, &sign_in, SIGN_IN_FILE_MODE, LeftoverSweep::Swept)
                .map_err(|refusal| SignInMoveError::Write(refusal.failure.kind()))?;
            flush_folder_of(path)
        })
        .await
    }

    async fn delete(&self) -> Result<(), SignInMoveError> {
        self.run(|path| match fs::remove_file(path) {
            Ok(()) => flush_folder_of(path),
            Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(SignInMoveError::File(source)),
        })
        .await
    }

    // The file's path names the account's home, so it stays out of the words.
    fn describe(&self) -> String {
        String::from("the sign-in file")
    }
}
