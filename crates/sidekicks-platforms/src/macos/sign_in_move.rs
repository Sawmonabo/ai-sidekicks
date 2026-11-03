//! The macOS sign-in move: each named keychain item into its file at mode `0600`, or each file back
//! into its keychain item, every one written, read back and only then deleted from its source. Each
//! step is timed against the caller's bound, and a step that outlasts it stops the move before the
//! next, so nothing moves on after the caller has stopped waiting.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use secrecy::zeroize::Zeroize as _;
use secrecy::{ExposeSecret as _, SecretString};
use subtle::ConstantTimeEq as _;

use crate::{
    CredentialStore, KeychainSignIn, LeftoverSweep, SignInMoveError, flush_folder,
    remove_atomic_write_leftovers, replace_file_atomically,
};

// The mode a sign-in's file is written with: its owner reads and writes it, no one else.
const SIGN_IN_FILE_MODE: u32 = 0o600;

/// The sign-in move, which this system supplies.
#[derive(Clone, Copy, Debug)]
pub struct SignInMove(());

/// The sign-in move this system supplies, which macOS always does.
pub fn sign_in_move() -> Option<SignInMove> {
    Some(SignInMove(()))
}

impl SignInMove {
    /// Moves each of `sign_ins` from its item in `store` into its file at mode `0600`, in order: a
    /// sign-in with no item is already moved, or was never there. Blocks on every store call, so
    /// the caller runs it on a blocking thread. Fails with the first sign-in that cannot be moved,
    /// which keeps its item, and with [`SignInMoveError::Overran`] once a step has run longer than
    /// `step_bound`, the move stopped before its next step.
    pub fn move_into_files(
        &self,
        store: &CredentialStore,
        sign_ins: &[KeychainSignIn],
        step_bound: Duration,
    ) -> Result<(), SignInMoveError> {
        let mut steps = BoundedSteps::new(step_bound);
        for sign_in in sign_ins {
            move_sign_in(
                &KeychainItem { store, sign_in },
                &SignInFile(sign_in),
                &mut steps,
            )?;
        }
        Ok(())
    }

    /// Moves each of `sign_ins` from its file back into its item in `store`, in order: a sign-in
    /// with no file is already moved, or was never there. Blocks and fails as
    /// [`Self::move_into_files`] does, the failing sign-in keeping its file.
    pub fn move_into_keychain(
        &self,
        store: &CredentialStore,
        sign_ins: &[KeychainSignIn],
        step_bound: Duration,
    ) -> Result<(), SignInMoveError> {
        let mut steps = BoundedSteps::new(step_bound);
        for sign_in in sign_ins {
            move_sign_in(
                &SignInFile(sign_in),
                &KeychainItem { store, sign_in },
                &mut steps,
            )?;
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

// The steps of one move, each timed against one bound: once a step has outlasted it, no later step
// runs.
struct BoundedSteps {
    bound: Duration,
    has_overrun: bool,
}

impl BoundedSteps {
    fn new(bound: Duration) -> Self {
        Self {
            bound,
            has_overrun: false,
        }
    }

    // Runs `step` unless an earlier step outlasted the bound, and notes whether this one did.
    fn run<Answer>(
        &mut self,
        step: impl FnOnce() -> Result<Answer, SignInMoveError>,
    ) -> Result<Answer, SignInMoveError> {
        if self.has_overrun {
            return Err(SignInMoveError::Overran);
        }
        let started = Instant::now();
        let answer = step();
        self.has_overrun = started.elapsed() > self.bound;
        answer
    }
}

// Where a sign-in is held: a keychain item or a file.
trait SignInPlace {
    // The sign-in held here, `None` when none is.
    fn read(&self) -> Result<Option<SecretString>, SignInMoveError>;
    // Holds `sign_in` here, in place of anything held before.
    fn write(&self, sign_in: &SecretString) -> Result<(), SignInMoveError>;
    // Deletes the sign-in held here, nothing when none is.
    fn delete(&self) -> Result<(), SignInMoveError>;
    // The place in words for an error, never its contents.
    fn describe(&self) -> String;
}

// Moves the sign-in at `source` to `destination`: written, read back and compared, and only then
// deleted from `source`, each step one of `steps` and `SIGN_IN_MOVE_STEPS` counting them, so a stop
// at any step leaves it whole in one place or both.
fn move_sign_in(
    source: &dyn SignInPlace,
    destination: &dyn SignInPlace,
    steps: &mut BoundedSteps,
) -> Result<(), SignInMoveError> {
    let Some(sign_in) = steps.run(|| source.read())? else {
        return Ok(());
    };
    steps.run(|| destination.write(&sign_in))?;
    let is_same = steps.run(|| destination.read())?.is_some_and(|copy| {
        bool::from(
            copy.expose_secret()
                .as_bytes()
                .ct_eq(sign_in.expose_secret().as_bytes()),
        )
    });
    if !is_same {
        return Err(SignInMoveError::CopyDiffers {
            destination: destination.describe(),
        });
    }
    steps.run(|| source.delete())
}

// A sign-in's keychain item in the store.
struct KeychainItem<'a> {
    store: &'a CredentialStore,
    sign_in: &'a KeychainSignIn,
}

impl KeychainItem<'_> {
    fn refused(&self, source: crate::CredentialStoreError) -> SignInMoveError {
        SignInMoveError::Store {
            service: self.sign_in.service.clone(),
            account: self.sign_in.account.clone(),
            source,
        }
    }
}

impl SignInPlace for KeychainItem<'_> {
    fn read(&self) -> Result<Option<SecretString>, SignInMoveError> {
        self.store
            .read(&self.sign_in.service, &self.sign_in.account)
            .map_err(|source| self.refused(source))
    }

    fn write(&self, sign_in: &SecretString) -> Result<(), SignInMoveError> {
        self.store
            .write(&self.sign_in.service, &self.sign_in.account, sign_in)
            .map_err(|source| self.refused(source))
    }

    fn delete(&self) -> Result<(), SignInMoveError> {
        self.store
            .remove(&self.sign_in.service, &self.sign_in.account)
            .map(drop)
            .map_err(|source| self.refused(source))
    }

    fn describe(&self) -> String {
        format!(
            "the keychain item {} for {}",
            self.sign_in.service, self.sign_in.account
        )
    }
}

// A sign-in's file.
struct SignInFile<'a>(&'a KeychainSignIn);

impl SignInFile<'_> {
    fn path(&self) -> &Path {
        &self.0.file
    }

    // Flushes the file's folder, so its write or removal survives a power loss before the other
    // place changes.
    fn flush_folder(&self) -> Result<(), SignInMoveError> {
        let folder = self
            .path()
            .parent()
            .expect("a sign-in's file names its folder");
        flush_folder(folder).map_err(SignInMoveError::File)
    }
}

impl SignInPlace for SignInFile<'_> {
    fn read(&self) -> Result<Option<SecretString>, SignInMoveError> {
        let bytes = match fs::read(self.path()) {
            Ok(bytes) => bytes,
            Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(SignInMoveError::File(source)),
        };
        match String::from_utf8(bytes) {
            Ok(mut text) => {
                // Built from the text, so this copy is wiped here, not left behind.
                let sign_in = SecretString::from(text.as_str());
                text.zeroize();
                Ok(Some(sign_in))
            }
            Err(not_text) => {
                not_text.into_bytes().zeroize();
                Err(SignInMoveError::NotText)
            }
        }
    }

    fn write(&self, sign_in: &SecretString) -> Result<(), SignInMoveError> {
        replace_file_atomically(
            self.path(),
            sign_in.expose_secret().as_bytes(),
            SIGN_IN_FILE_MODE,
            LeftoverSweep::Swept,
        )
        .map_err(SignInMoveError::Write)?;
        self.flush_folder()
    }

    fn delete(&self) -> Result<(), SignInMoveError> {
        match fs::remove_file(self.path()) {
            Ok(()) => self.flush_folder(),
            Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(SignInMoveError::File(source)),
        }
    }

    // The file's path names the account's home, so it stays out of the words.
    fn describe(&self) -> String {
        String::from("the sign-in file")
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;
    use std::time::Duration;

    use secrecy::ExposeSecret as _;

    use super::sign_in_move;
    use crate::{BlockingCredentialStore, CredentialStore, KeychainSignIn, SignInMoveError};

    const SERVICE: &str = "Provider-credentials-test";

    // A bound no step of a test's move nears.
    const STEP_BOUND: Duration = Duration::from_secs(60);

    // Two sign-ins, each filed under its own account and moving to its own file in `folder`.
    fn two_sign_ins(folder: &Path) -> [KeychainSignIn; 2] {
        ["first", "second"].map(|account| KeychainSignIn {
            service: SERVICE.to_owned(),
            account: account.to_owned(),
            file: folder.join(account).join(".credentials.json"),
        })
    }

    fn sign_in_text(sign_in: &KeychainSignIn) -> String {
        format!("{{\"token\":\"secret-of-{}\"}}", sign_in.account)
    }

    // Each sign-in is held exactly once, in its file when `in_files`, else in its item, with the
    // text it started with.
    fn assert_each_held_once(store: &CredentialStore, sign_ins: &[KeychainSignIn], in_files: bool) {
        for sign_in in sign_ins {
            let item = store
                .read(&sign_in.service, &sign_in.account)
                .expect("the store reads")
                .map(|value| value.expose_secret().to_owned());
            let file = std::fs::read_to_string(&sign_in.file).ok();
            let expected = Some(sign_in_text(sign_in));
            if in_files {
                assert_eq!((item, file), (None, expected), "{}", sign_in.account);
            } else {
                assert_eq!((item, file), (expected, None), "{}", sign_in.account);
            }
        }
    }

    /// The move into files leaves each sign-in in its file at mode 0600 and its item gone, and the
    /// move back reverses it. Mutations: write the file at 0644; skip the source's delete.
    #[test]
    fn the_sign_in_move_puts_each_sign_in_in_a_private_file_and_back() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let store = CredentialStore::in_memory();
        let sign_ins = two_sign_ins(folder.path());
        for sign_in in &sign_ins {
            std::fs::create_dir(sign_in.file.parent().expect("a file has a folder"))
                .expect("the store folder is made");
            store
                .write(
                    &sign_in.service,
                    &sign_in.account,
                    &sign_in_text(sign_in).into(),
                )
                .expect("the store writes");
        }
        let mover = sign_in_move().expect("macOS supplies the move");

        mover
            .move_into_files(&store, &sign_ins, STEP_BOUND)
            .expect("the sign-ins move into files");

        assert_each_held_once(&store, &sign_ins, true);
        for sign_in in &sign_ins {
            let mode = std::fs::metadata(&sign_in.file)
                .expect("the file is there")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{}", sign_in.account);
        }

        mover
            .move_into_keychain(&store, &sign_ins, STEP_BOUND)
            .expect("the sign-ins move back");

        assert_each_held_once(&store, &sign_ins, false);
    }

    /// A move stopped after one sign-in, and one stopped between a copy and its source's delete,
    /// each finish on the next call with every sign-in held exactly once. Mutations: refuse a
    /// sign-in whose source is already gone; skip a sign-in whose destination already holds it.
    #[test]
    fn a_stopped_sign_in_move_finishes_on_the_next_call() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let store = CredentialStore::in_memory();
        let sign_ins = two_sign_ins(folder.path());
        for sign_in in &sign_ins {
            std::fs::create_dir(sign_in.file.parent().expect("a file has a folder"))
                .expect("the store folder is made");
            store
                .write(
                    &sign_in.service,
                    &sign_in.account,
                    &sign_in_text(sign_in).into(),
                )
                .expect("the store writes");
        }
        let mover = sign_in_move().expect("macOS supplies the move");
        let [_, second] = &sign_ins;
        store.refuse_next_call(&second.service, &second.account);

        let stopped = mover.move_into_files(&store, &sign_ins, STEP_BOUND);

        let stopped_at = match &stopped {
            Err(SignInMoveError::Store { account, .. }) => Some(account.as_str()),
            _ => None,
        };
        assert_eq!(stopped_at, Some("second"), "{stopped:?}");
        mover
            .move_into_files(&store, &sign_ins, STEP_BOUND)
            .expect("the next call finishes the move");
        assert_each_held_once(&store, &sign_ins, true);

        // Stopped after the first copy reached the keychain and before its file was deleted.
        let [first, _] = &sign_ins;
        store
            .write(&first.service, &first.account, &sign_in_text(first).into())
            .expect("the store writes");
        mover
            .move_into_keychain(&store, &sign_ins, STEP_BOUND)
            .expect("the next call finishes the move back");
        assert_each_held_once(&store, &sign_ins, false);
    }

    /// A copy that reads back differently keeps its source, so no sign-in is lost to a store that
    /// accepts a write but keeps something else. Mutation: delete the source before the copy is
    /// read back.
    #[test]
    fn a_sign_in_move_keeps_the_source_when_its_copy_reads_back_differently() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let blocking = BlockingCredentialStore::new();
        blocking.release();
        blocking.keep_changed_values_for(SERVICE);
        let store = CredentialStore::from_store(blocking);
        let [sign_in, _] = two_sign_ins(folder.path());
        std::fs::create_dir(sign_in.file.parent().expect("a file has a folder"))
            .expect("the store folder is made");
        std::fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");

        let refused = sign_in_move()
            .expect("macOS supplies the move")
            .move_into_keychain(&store, std::slice::from_ref(&sign_in), STEP_BOUND);

        assert!(
            matches!(refused, Err(SignInMoveError::CopyDiffers { .. })),
            "{refused:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&sign_in.file).ok(),
            Some(sign_in_text(&sign_in)),
            "the source file stays"
        );
        let refusal = refused.expect_err("the move is refused");
        let shown = format!("{refusal} {refusal:?}");
        assert!(!shown.contains("secret-of-"), "{shown}");
    }

    /// A keychain read that answers only after its bound stops the move before anything is
    /// written: no file, and the item where it was. Killed by a move that carries on past a step
    /// that outlasted its bound.
    #[test]
    fn a_step_past_its_bound_stops_the_move_before_the_next() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let blocking = BlockingCredentialStore::new();
        blocking.release();
        let store = CredentialStore::from_store(blocking.clone());
        let [sign_in, _] = two_sign_ins(folder.path());
        std::fs::create_dir(sign_in.file.parent().expect("a file has a folder"))
            .expect("the store folder is made");
        store
            .write(
                &sign_in.service,
                &sign_in.account,
                &sign_in_text(&sign_in).into(),
            )
            .expect("the store writes");
        blocking.hold_calls_for(SERVICE);
        let bound = Duration::from_millis(20);
        let releasing = std::thread::spawn(move || {
            // Released only once the held read has waited well past its bound.
            std::thread::sleep(bound * 5);
            blocking.release();
        });

        let stopped = sign_in_move()
            .expect("macOS supplies the move")
            .move_into_files(&store, std::slice::from_ref(&sign_in), bound);

        releasing.join().expect("the release ends");
        assert!(
            matches!(stopped, Err(SignInMoveError::Overran)),
            "{stopped:?}"
        );
        assert!(!sign_in.file.exists(), "no file is written past the bound");
        assert_each_held_once(&store, std::slice::from_ref(&sign_in), false);
    }

    /// The leftover a move stopped mid-write left beside a sign-in file is swept, while the sign-in
    /// file and another target's leftover stay. Killed by a sweep that misses the leftover, and by
    /// one that takes files of other targets.
    #[test]
    fn a_stopped_moves_leftover_is_swept() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let [sign_in, _] = two_sign_ins(folder.path());
        let store_folder = sign_in.file.parent().expect("a file has a folder");
        std::fs::create_dir(store_folder).expect("the store folder is made");
        std::fs::write(&sign_in.file, sign_in_text(&sign_in)).expect("the sign-in file is written");
        let leftover = store_folder.join(".credentials.json.a1b2c3.tmp");
        let other = store_folder.join("settings.json.d4e5f6.tmp");
        for path in [&leftover, &other] {
            std::fs::write(path, sign_in_text(&sign_in)).expect("a temporary file is written");
        }

        let failures = sign_in_move()
            .expect("macOS supplies the move")
            .remove_leftovers(std::slice::from_ref(&sign_in.file));

        assert!(failures.is_empty(), "{failures:?}");
        assert!(!leftover.exists(), "the stopped move's leftover is gone");
        assert!(other.exists(), "another target's file stays");
        assert_eq!(
            std::fs::read_to_string(&sign_in.file).ok(),
            Some(sign_in_text(&sign_in))
        );
    }
}
