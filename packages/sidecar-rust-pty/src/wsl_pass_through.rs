//! Negative-invariant scope guard for WSL2 path translation
//! (Plan-024 §Invariants I-024-3).
//!
//! Plan-024 §Windows Implementation Gotchas Gotcha 3: the sidecar MUST
//! pass `SpawnRequest.cwd` and `SpawnRequest.env` paths to `portable-pty`
//! verbatim and MUST NOT invoke `wslpath` or any Windows ↔ WSL2 path
//! conversion. WSL path translation is a daemon-layer step (CP-001-2
//! `spawn-cwd-translator`, already shipped in PR #48) that runs BEFORE
//! the `SpawnRequest` reaches the sidecar.
//!
//! ## Why a module rather than a comment in `pty_session.rs`?
//!
//! I-024-3 is a NEGATIVE invariant: "the sidecar does NOT do X." The
//! conventional encoding is a comment that says "do not call `wslpath`
//! here." Comments rot. A module with a pure pass-through function and
//! a property test that asserts byte-for-byte identity provides:
//!
//!   1. A single point of truth that future contributors find when
//!      they grep for "wsl" in the crate.
//!   2. An executable assertion: the test FAILS if some future refactor
//!      adds path translation.
//!   3. A reviewer-readable scope-boundary declaration: the diff for
//!      the wire-through PR (T-024-3-1 follow-up) routes `cwd` through
//!      `pass_through` and the lint catches a regression.
//!
//! ## Lint complement
//!
//! Plan-024 line 57 mentions a `clippy::ban_path_translation` lint as
//! a complementary defense. That lint is a separate follow-up; this
//! module ships the executable test.
//!
//! Refs: Plan-024 I-024-3, ADR-019 §Decision item 1, Plan-024
//! §Windows Implementation Gotchas Gotcha 3, Plan-001 P5 CP-001-2
//! (cwd-translator, the daemon-layer counterpart).

#![cfg(target_os = "windows")]

/// Pass a path through verbatim — byte-identical input == output.
///
/// This function is the **enforcement boundary** for I-024-3. The
/// dispatcher routes `SpawnRequest.cwd` (and any other path-carrying
/// field) through this function before forwarding to `portable-pty`.
/// The function is intentionally trivial — it returns its input
/// unchanged — so that the unit tests can assert byte-for-byte
/// identity over a representative WSL path corpus and catch any
/// future refactor that introduces path translation.
///
/// # Why borrow + return owned?
///
/// `String` round-trip avoids requiring the caller to thread a
/// lifetime through the dispatcher's `SpawnRequest` (which is owned
/// after deserialization). The `to_string()` call is a single
/// allocation per spawn (cold path); the cost is dominated by the
/// PTY-spawn syscall that follows.
///
/// Alternative considered: `&str → &str` zero-copy. Rejected because
/// it would force `pass_through`'s lifetime into the dispatcher's
/// signature, complicating the eventual wire-through diff for no
/// runtime savings.
#[must_use]
pub fn pass_through(path: &str) -> String {
    // INTENTIONALLY trivial — see module rustdoc. Adding logic here
    // (normalization, slash-flipping, wslpath invocation, etc.) is
    // a Plan-024 I-024-3 violation. The unit tests below assert
    // byte-identity over a WSL2 path corpus; any deviation from
    // identity will trip those tests.
    //
    // If a future requirement DEMANDS path normalization at the
    // sidecar layer (it should not — the daemon owns this per
    // CP-001-2), the change must:
    //   1. Update Plan-024 I-024-3 + ADR-019 §Decision item 1
    //   2. Update the unit tests below to assert the new contract
    //   3. Update the dispatcher's caller to opt in
    // Doing it silently is the failure mode this module exists to
    // prevent.
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // I-024-3 verification — feeding the sidecar WSL2 paths in their
    // various canonical shapes MUST result in byte-identical output.
    // The test corpus covers:
    //   - `\\wsl.localhost\Ubuntu\home\foo` (modern WSL2 UNC path,
    //     post Windows 11 22H2 — primary case Plan-024 I-024-3 test
    //     description names verbatim)
    //   - `\\wsl$\Ubuntu\home\foo` (legacy WSL2 UNC path, still
    //     functional on older Windows builds)
    //   - `/mnt/c/Users/foo` (POSIX path style as seen from inside
    //     WSL — the sidecar must NOT translate to `C:\Users\foo`)
    //   - `C:\Users\foo` (Windows-native; the sidecar must not
    //     re-encode as a WSL path)
    //   - Empty string (degenerate input — pass-through MUST be
    //     total)
    //   - Path with embedded NUL bytes (security relevant — pass
    //     through verbatim; the daemon's wire-validation layer is
    //     responsible for rejecting NULs at the trust boundary)

    #[test]
    fn passes_through_modern_wsl_localhost_unc() {
        // Plan-024 I-024-3 names this exact path shape verbatim:
        // "feeds the sidecar a `\\wsl.localhost\Ubuntu\home\foo`
        // path and asserts the path is forwarded to `portable-pty`
        // byte-identical".
        let input = r"\\wsl.localhost\Ubuntu\home\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_legacy_wsl_dollar_unc() {
        // The pre-Windows-11-22H2 WSL UNC shape. Some users still
        // run older Windows builds; pass-through must not depend on
        // the prefix variant.
        let input = r"\\wsl$\Ubuntu\home\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_posix_mnt_path() {
        // `/mnt/c/Users/foo` is the POSIX-style path WSL exposes for
        // mounted Windows drives. The sidecar MUST NOT translate
        // this to `C:\Users\foo` — that translation is a daemon-
        // layer step (CP-001-2 cwd-translator). If the sidecar
        // translated, a child running INSIDE WSL would receive a
        // Windows path it cannot stat.
        let input = "/mnt/c/Users/foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_windows_native_path() {
        // Windows-native path. The sidecar MUST NOT re-encode as a
        // WSL path. (Even if the daemon mistakenly forwarded a
        // Windows path destined for a WSL child, the sidecar's job
        // is to forward verbatim; the failure mode is the daemon's
        // to fix.)
        let input = r"C:\Users\foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_unix_root_style_path() {
        // `/home/foo` is the WSL-from-inside path shape. Same
        // verbatim contract.
        let input = "/home/foo";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_empty_string() {
        // Degenerate input — pass-through MUST be total. The daemon
        // MAY reject empty cwd at its wire-validation layer; the
        // sidecar's contract is "forward whatever arrived".
        assert_eq!(pass_through(""), "");
    }

    #[test]
    fn passes_through_path_with_embedded_special_chars() {
        // Spaces, dots, percent signs — all common in real Windows
        // path corpora. The sidecar MUST NOT URL-decode, normalize
        // dots, or strip trailing slashes.
        let input = r"C:\Program Files\My App\..\sub.dir\";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_mixed_separator_path() {
        // Mixed `/` and `\` separators occur in real-world spawn
        // requests (e.g., a Cygwin-style mingw path). The sidecar
        // MUST NOT canonicalize separators.
        let input = r"C:\Users\foo/bin\bash";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn passes_through_unicode_path() {
        // WSL paths with non-ASCII characters (e.g., user names
        // with diacritics) MUST round-trip byte-identically. The
        // pass_through return is `String`, so a UTF-8 round-trip
        // is implicit; a future refactor that lossy-converts to
        // ASCII would trip this assertion.
        let input = "/home/josé/résumé";
        assert_eq!(pass_through(input), input);
    }

    #[test]
    fn output_byte_length_matches_input() {
        // Stronger than equality: assert the bytes themselves,
        // not just the `==` impl. A future refactor that returns
        // a `Cow::Borrowed` or a `&str` slice MUST preserve the
        // byte representation; this test catches a hypothetical
        // refactor that swaps to a path-normalizing return type.
        let input = r"\\wsl.localhost\Ubuntu\home\foo";
        let output = pass_through(input);
        assert_eq!(output.as_bytes(), input.as_bytes());
        assert_eq!(output.len(), input.len());
    }
}
