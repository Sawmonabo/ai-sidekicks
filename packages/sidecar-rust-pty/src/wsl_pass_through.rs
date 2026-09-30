//! Guard that the sidecar does not translate paths.
//!
//! `SpawnRequest.cwd` and `SpawnRequest.env` paths go to `portable-pty` verbatim; the sidecar never
//! runs `wslpath` or any Windows/WSL2 path conversion. WSL path translation is a daemon step
//! (`spawn-cwd-translator`) that runs before the request reaches the sidecar. [`pass_through`] is
//! the identity function and its tests assert byte-for-byte identity, so a change that adds
//! translation fails a test. The dispatcher does not call it yet.

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

    // WSL2 path shapes must come out byte-identical: modern and older UNC forms, `/mnt/c/...`,
    // Windows-native, empty, and embedded NUL (the daemon's wire validation is responsible for
    // rejecting NULs).

    #[test]
    fn passes_through_modern_wsl_localhost_unc() {
        let input = r"\\wsl.localhost\Ubuntu\home\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_legacy_wsl_dollar_unc() {
        // Older WSL UNC prefix.
        let input = r"\\wsl$\Ubuntu\home\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_posix_mnt_path() {
        // The sidecar must not translate this to `C:\Users\foo`; a child inside WSL could not stat
        // a Windows path.
        let input = "/mnt/c/Users/foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_windows_native_path() {
        // The sidecar must not re-encode a Windows path as a WSL path.
        let input = r"C:\Users\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_unix_root_style_path() {
        let input = "/home/foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_empty_string() {
        // The sidecar forwards whatever arrived, even an empty string.
        assert_eq!(pass_through(""), "");
    }

    #[test]
    fn passes_through_path_with_embedded_special_chars() {
        // The sidecar must not URL-decode, normalize dots, or strip trailing slashes.
        let input = r"C:\Program Files\My App\..\sub.dir\";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_mixed_separator_path() {
        // The sidecar must not canonicalize mixed separators.
        let input = r"C:\Users\foo/bin\bash";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_unicode_path() {
        // Non-ASCII paths must round-trip byte for byte.
        let input = "/home/josé/résumé";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_path_with_embedded_nul() {
        // The daemon's wire validation rejects NULs; the sidecar forwards them, so a change to
        // strip them must update this test.
        let input = "\0before\0after";
        assert_eq!(pass_through(input), input);
        assert_eq!(pass_through(input).as_bytes(), input.as_bytes());
    }

    #[test]
    fn output_byte_length_matches_input() {
        // Compares the bytes, not just the `==` impl.
        let input = r"\\wsl.localhost\Ubuntu\home\foo";
        let output = pass_through(input);
        assert_eq!(output.as_bytes(), input.as_bytes());
        assert_eq!(output.len(), input.len());
    }
}
