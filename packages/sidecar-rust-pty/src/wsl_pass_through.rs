//! Guard that the sidecar does not translate paths.
//!
//! `SpawnRequest.cwd` and `SpawnRequest.env` paths go to `portable-pty` verbatim; the sidecar never
//! runs `wslpath` or any Windows/WSL2 path conversion. Where the providers live in WSL 2 the
//! service runs inside the distribution, its shells start through the Linux daemon's own PTY, and
//! that daemon translates paths with `wslpath`, so a WSL path never reaches this native-Windows
//! sidecar. [`pass_through`] is the identity function and its tests assert byte-for-byte identity,
//! so a change that adds translation fails a test. Only its tests call it.

#![cfg(target_os = "windows")]

/// Returns `path` unchanged, byte for byte. It returns an owned `String` so the caller need not
/// carry a lifetime through the owned `SpawnRequest`.
#[must_use]
pub fn pass_through(path: &str) -> String {
    // Deliberately the identity: normalization, slash-flipping or `wslpath` here would break the
    // forward-verbatim contract, and the daemon owns translation.
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_every_path_shape_byte_for_byte() {
        // Shapes a translation, normalization or decoding step would alter: the WSL UNC share, a
        // `/mnt/c` path, dots and a trailing separator, mixed separators, non-ASCII, and NUL (the
        // daemon's wire validation refuses NULs; the sidecar forwards what arrived).
        for input in [
            r"\\wsl.localhost\Ubuntu\home\foo",
            "/mnt/c/Users/foo",
            r"C:\Program Files\My App\..\sub.dir\",
            r"C:\Users\foo/bin\bash",
            "/home/josé/résumé",
            "\0before\0after",
        ] {
            assert_eq!(
                pass_through(input).as_bytes(),
                input.as_bytes(),
                "{input:?}"
            );
        }
    }
}
