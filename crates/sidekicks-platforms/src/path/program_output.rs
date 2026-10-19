//! A path a program printed, read back as the path it names: on macOS and Linux its bytes as they
//! are, so a name that is not UTF-8 still opens; on Windows its UTF-8 text, the form git for
//! Windows prints a path in.

use std::io;
use std::path::PathBuf;

/// The path whose bytes a program printed, unquoted, as git's `-z` output and its `--git-path` and
/// `--show-toplevel` answers print one: every byte kept on macOS and Linux, and the UTF-8 text on
/// Windows. Fails with `InvalidData` on Windows for bytes that are not UTF-8; never fails on macOS
/// and Linux.
pub fn path_from_program_output(bytes: Vec<u8>) -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt as _;

        Ok(PathBuf::from(OsString::from_vec(bytes)))
    }
    #[cfg(windows)]
    {
        String::from_utf8(bytes)
            .map(PathBuf::from)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::path_from_program_output;

    // Fails when the bytes are read lossily, which names a path that does not exist.
    #[test]
    fn path_from_program_output_keeps_bytes_that_are_not_utf8() {
        use std::os::unix::ffi::OsStrExt as _;

        let bytes = b"repos/caf\xe9/inner".to_vec();

        let path = path_from_program_output(bytes.clone()).expect("every byte reads on Unix");

        assert_eq!(path.as_os_str().as_bytes(), bytes.as_slice());
    }
}
