//! A file its writer holds locked while another process may sweep its name: the writer makes it
//! under a fresh name, locks it and checks the name still names it, trying a fresh name when a
//! sweep took it, and the sweeper removes it only while holding the lock itself, so a writer never
//! ends up holding a file without a name.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

use crate::AtomicWriteError;
use crate::entry_identity::EntryIdentity;
use crate::open_file_identity;
#[cfg(unix)]
use crate::posix::entry_identity::{is_marked_for_deletion, named_identity};
#[cfg(target_os = "windows")]
use crate::windows::entry_identity::{is_marked_for_deletion, named_identity};

// How many fresh names a held create tries: a name is lost only when a sweep removed the file in
// the instant between its create and its lock.
const HELD_CREATE_ATTEMPTS: usize = 8;

/// Makes a file through `create` (a new file under a fresh name at each call), locks it until it
/// is closed and checks the name still names it, trying a fresh name when a sweep removed the file
/// in the instant before the lock. Fails when a create, the lock or the check fails, or every try
/// lost its name, removing the file it made and keeping the removal's own failure beside it.
pub fn create_held_file<Name: AsRef<Path>>(
    mut create: impl FnMut() -> io::Result<(File, Name)>,
) -> Result<(File, Name), AtomicWriteError> {
    for _ in 0..HELD_CREATE_ATTEMPTS {
        let (file, name) = create().map_err(|failure| AtomicWriteError {
            failure,
            removal_failure: None,
        })?;
        let is_lost = file
            .lock()
            .and_then(|()| is_name_lost(name.as_ref(), &file));
        if matches!(is_lost, Ok(false)) {
            return Ok((file, name));
        }
        // Closed before the removal, which Windows needs to remove a file once marked for it.
        drop(file);
        let removal_failure = match fs::remove_file(name.as_ref()) {
            Err(failure) if failure.kind() != io::ErrorKind::NotFound => Some(failure),
            _removed => None,
        };
        match is_lost {
            Err(failure) => {
                return Err(AtomicWriteError {
                    failure,
                    removal_failure,
                });
            }
            Ok(_lost) if removal_failure.is_some() => {
                return Err(AtomicWriteError {
                    failure: lost_names_failure(),
                    removal_failure,
                });
            }
            Ok(_lost) => {}
        }
    }
    Err(AtomicWriteError {
        failure: lost_names_failure(),
        removal_failure: None,
    })
}

// Whether the name `path` no longer names the open file `file`, as a sweep that removed it leaves
// it: nothing is there, another entry is, or the name is refused while `file` is marked for
// deletion, as Windows refuses a removed name another handle still holds. Fails with any other
// error reading the name or the file, a refusal of a file not so marked among them.
fn is_name_lost(path: &Path, file: &File) -> io::Result<bool> {
    is_named_identity_lost(named_identity(path), open_file_identity(file)?, || {
        is_marked_for_deletion(file)
    })
}

// `is_name_lost` on the identity the name read, `named`, the held file's, `held`, and the held
// file's mark for deletion, read only for a refused name.
fn is_named_identity_lost(
    named: io::Result<EntryIdentity>,
    held: EntryIdentity,
    is_marked: impl FnOnce() -> io::Result<bool>,
) -> io::Result<bool> {
    match named {
        Ok(named) => Ok(named != held),
        Err(gone) if gone.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(refused) if refused.kind() == io::ErrorKind::PermissionDenied => {
            if is_marked()? {
                Ok(true)
            } else {
                Err(refused)
            }
        }
        Err(failure) => Err(failure),
    }
}

fn lost_names_failure() -> io::Error {
    io::Error::other("every name the file was made under was removed before it was locked")
}

/// Removes the file at `path` unless another handle holds it locked, removing the name while its
/// own lock is still held, so a writer whose lock waited on it finds its name gone; answers whether
/// another handle held it (a file already gone was not held). Opens the file for writing too, since
/// NFS grants an exclusive lock only on such a handle. Fails with the open's, the lock's or the
/// removal's error.
pub fn remove_unless_held(path: &Path) -> io::Result<bool> {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(failure),
    };
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(true),
        Err(TryLockError::Error(failure)) => return Err(failure),
    }
    // A writer that locked between a release here and the removal would lose its file.
    match fs::remove_file(path) {
        Err(failure) if failure.kind() != io::ErrorKind::NotFound => return Err(failure),
        _removed => {}
    }
    drop(file);
    Ok(false)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File, TryLockError};
    use std::io;

    use rstest::rstest;

    use super::{
        HELD_CREATE_ATTEMPTS, create_held_file, is_named_identity_lost, remove_unless_held,
    };
    use crate::entry_identity::EntryIdentity;
    use crate::{create_new_file, entry_identity, open_file_identity};

    const HELD: EntryIdentity = EntryIdentity { volume: 1, file: 7 };

    // A sweep that removes a file in the instant between its create and its lock costs that try its
    // name: the create tries a fresh one and answers a file its name still names, held locked, or
    // fails once every try lost, leaving no file. Killed by a lost name answered as kept, by the
    // retry dropped and by the bound removed.
    #[rstest]
    #[case::lost_once(1)]
    #[case::lost_every_time(HELD_CREATE_ATTEMPTS)]
    fn a_held_create_tries_a_fresh_name_when_a_sweep_took_one(#[case] lost: usize) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let name = |call: usize| scratch.path().join(format!("held-{call}"));
        let mut calls = 0;

        let made = create_held_file(|| {
            if calls == HELD_CREATE_ATTEMPTS {
                return Err(io::Error::other("a create past the bound"));
            }
            let path = name(calls);
            calls += 1;
            let file = create_new_file(&path, 0o600)?;
            if calls <= lost {
                // The sweep wins the window: the file is not yet locked, so it goes.
                assert!(
                    !remove_unless_held(&path)?,
                    "the sweep found the file unheld"
                );
            }
            Ok((file, path))
        });

        let left: Vec<_> = fs::read_dir(scratch.path())
            .expect("the scratch folder lists")
            .map(|entry| entry.expect("an entry reads").path())
            .collect();
        if lost < HELD_CREATE_ATTEMPTS {
            let (file, path) = made.expect("a fresh name is kept");
            assert_eq!(calls, lost + 1);
            assert_eq!(path, name(lost));
            assert_eq!(left, [name(lost)]);
            assert_eq!(
                entry_identity(&path).expect("the name reads").identity,
                open_file_identity(&file).expect("the file reads")
            );
            let probe = File::open(&path).expect("the made file opens");
            assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
        } else {
            let failure = made.expect_err("every name was lost");
            assert!(failure.removal_failure.is_none(), "{failure}");
            assert_eq!(failure.failure.kind(), io::ErrorKind::Other);
            assert!(
                failure.failure.to_string().starts_with("every name"),
                "{failure}"
            );
            assert!(left.is_empty(), "{left:?}");
            assert_eq!(calls, HELD_CREATE_ATTEMPTS);
        }
    }

    // A name is lost when nothing or another entry is there, or when it is refused while the held
    // file is marked for deletion; a refusal of an unmarked file is a real one and is answered, as
    // is any other failure, and the name of the held file itself is kept. Killed by the mark's
    // test dropped, so every refusal reads as lost, and by a check that answers "still named".
    #[rstest]
    #[case::still_named(Ok(HELD), false, Some(false))]
    #[case::another_entry(Ok(EntryIdentity { volume: 1, file: 8 }), false, Some(true))]
    #[case::gone(Err(io::ErrorKind::NotFound), false, Some(true))]
    #[case::refused_while_marked(Err(io::ErrorKind::PermissionDenied), true, Some(true))]
    #[case::refused_unmarked(Err(io::ErrorKind::PermissionDenied), false, None)]
    #[case::other_failure(Err(io::ErrorKind::Interrupted), true, None)]
    fn a_name_is_lost_only_when_a_sweep_took_it(
        #[case] named: Result<EntryIdentity, io::ErrorKind>,
        #[case] is_marked: bool,
        #[case] expected: Option<bool>,
    ) {
        let named = named.map_err(io::Error::from);
        let kind = named.as_ref().err().map(io::Error::kind);

        let answer = is_named_identity_lost(named, HELD, || Ok(is_marked));

        match expected {
            Some(is_lost) => assert_eq!(answer.expect("the check answers"), is_lost),
            None => assert_eq!(
                answer.expect_err("the failure is answered").kind(),
                kind.unwrap()
            ),
        }
    }
}
