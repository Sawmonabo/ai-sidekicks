//! A refused clone's error read on macOS and Linux, from its system code alone: both answer a clone
//! across volumes with `EXDEV`, Linux cloning only within one file system and macOS refusing a
//! clone across mounts, so neither end needs reading.

use std::fs::File;
use std::io;
use std::path::Path;

use crate::clone_refusal::CloneRefusal;

/// What `error`, from cloning `source` into a new file at `destination`, tells: `EXDEV` a copy on
/// another volume, `ENOTSUP` or `EOPNOTSUPP` a volume that makes no clones; the code alone tells,
/// so neither end is read. Fails with `error` itself, unchanged, for any other code or an error
/// with none, so the caller keeps its cause.
pub fn read_clone_refusal(
    _source: &File,
    _destination: &Path,
    error: io::Error,
) -> Result<CloneRefusal, io::Error> {
    match error.raw_os_error() {
        Some(code) if code == libc::EXDEV => Ok(CloneRefusal::AcrossVolumes),
        // Linux gives both names one value; each is compared, never matched, so neither goes
        // unread.
        Some(code) if code == libc::ENOTSUP || code == libc::EOPNOTSUPP => {
            Ok(CloneRefusal::Unsupported)
        }
        Some(_) | None => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::Path;

    use rstest::rstest;

    use super::read_clone_refusal;
    use crate::clone_refusal::CloneRefusal;

    // Fails on a swapped arm, on a catch-all arm that reads an unlisted code as a refusal, and on
    // `ENOTSUP` or `EOPNOTSUPP` left uncompared, which are two values on macOS.
    #[rstest]
    #[case::across_volumes(Some(libc::EXDEV), Some(CloneRefusal::AcrossVolumes))]
    #[case::not_supported(Some(libc::ENOTSUP), Some(CloneRefusal::Unsupported))]
    #[case::operation_not_supported(Some(libc::EOPNOTSUPP), Some(CloneRefusal::Unsupported))]
    #[case::access_denied(Some(libc::EACCES), None)]
    #[case::invalid_argument(Some(libc::EINVAL), None)]
    #[case::already_there(Some(libc::EEXIST), None)]
    #[case::no_code(None, None)]
    fn a_clone_error_reads_as_its_refusal_or_comes_back_unchanged(
        #[case] code: Option<i32>,
        #[case] expected: Option<CloneRefusal>,
    ) {
        let source = tempfile::tempfile().expect("a source file is made");
        // reflink-copy's answer for a source that is not a regular file carries no code.
        let error = code.map_or_else(
            || {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the source is not a regular file",
                )
            },
            io::Error::from_raw_os_error,
        );
        let (kind, text) = (error.kind(), error.to_string());

        match read_clone_refusal(&source, Path::new("copy"), error) {
            Ok(refusal) => assert_eq!(Some(refusal), expected),
            Err(back) => {
                assert_eq!(expected, None, "a listed code reads as its refusal");
                assert_eq!(
                    (back.kind(), back.raw_os_error(), back.to_string()),
                    (kind, code, text),
                    "an unlisted error comes back unchanged"
                );
            }
        }
    }
}
