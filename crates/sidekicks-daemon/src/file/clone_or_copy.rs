//! One file copied to a new path, as a clone where the file system makes one, never over an entry
//! already there.

use std::error::Error;
use std::fs::{self, File};
use std::io;
use std::path::Path;

use sidekicks_platforms::create_new_file;

// The mode a fallback copy is made with, before it takes the source's own.
const FALLBACK_COPY_MODE: u32 = 0o600;

/// Copies `source` to `destination`, keeping its mode: a clone where the file system makes one,
/// else a byte copy, also when the clone is refused with a permission error, as some file systems
/// refuse one a plain copy is allowed. Fails with `AlreadyExists` when anything is at
/// `destination`, which is never replaced, else with the clone's or the copy's error.
pub(crate) fn clone_or_copy(source: &Path, destination: &Path) -> io::Result<()> {
    match reflink_copy::reflink_or_copy(source, destination) {
        Ok(_) => Ok(()),
        // A real permission problem fails the copy with the same error.
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            copy_into_new_file(source, destination)
        }
        Err(error) => Err(error),
    }
}

// Copies `source`'s bytes into a file made new at `destination`, then gives it `source`'s mode; a
// copy that fails partway removes the file it made, and only that file.
fn copy_into_new_file(source: &Path, destination: &Path) -> io::Result<()> {
    let mut reader = File::open(source)?;
    let permissions = reader.metadata()?.permissions();
    let mut copy = create_new_file(destination, FALLBACK_COPY_MODE)?;
    let copied = io::copy(&mut reader, &mut copy).and_then(|_| copy.set_permissions(permissions));
    if let Err(error) = copied {
        drop(copy);
        if let Err(removal) = fs::remove_file(destination) {
            tracing::warn!(
                error = &removal as &(dyn Error + 'static),
                path = %destination.display(),
                "A copy that failed partway could not be removed"
            );
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;

    use super::copy_into_new_file;

    #[test]
    fn the_fallback_copy_makes_a_new_file_and_never_writes_over_one() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source = scratch.path().join("source");
        let destination = scratch.path().join("destination");
        fs::write(&source, b"the source's bytes").expect("the source is written");

        copy_into_new_file(&source, &destination).expect("the copy is made");
        assert_eq!(
            fs::read(&destination).expect("the copy reads"),
            b"the source's bytes"
        );

        fs::write(&destination, b"written since").expect("the copy is changed");
        let refusal =
            copy_into_new_file(&source, &destination).expect_err("an entry is never replaced");
        assert_eq!(refusal.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(&destination).expect("the copy reads"),
            b"written since"
        );
    }
}
