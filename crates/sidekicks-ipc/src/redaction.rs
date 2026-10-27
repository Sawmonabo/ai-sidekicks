//! What the daemon removes from text that leaves it or outlives the moment: the credential scrub
//! and the patterns of absolute paths, shared by a workspace's `lastError`, the error responses
//! and the crash reports.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use sidekicks_contracts::wire::text::ECMASCRIPT_WHITESPACE_CLASS;

/// What stands in for each credential the scrub removes.
const CREDENTIAL_REDACTION: &str = "***";

// The scrub's word boundaries are ASCII, `(?-u:\b)`, as JavaScript's `\b` is: under Unicode's `\b`
// a token right after a letter such as `é` would have no boundary before it and escape redaction.
// Every `\s` is ECMAScript's set spelled out. The `(?i)` patterns fold `ſ` and the Kelvin sign as
// JavaScript's non-Unicode `/i` does not, which only redacts more.

// URL userinfo (`scheme://user:password@host`): the one credential shape with no recognizable
// token prefix, so no other pattern catches it.
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u:\b)([A-Za-z][A-Za-z0-9+.-]*://)[^{ECMASCRIPT_WHITESPACE_CLASS}/@]+@"
    ))
    .expect("the userinfo pattern is a valid regex")
});

// Header-style credentials, git's `x-access-token` form for app tokens among them.
static HEADER_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    let space = ECMASCRIPT_WHITESPACE_CLASS;
    Regex::new(&format!(
        "(?i)((?:authorization|proxy-authorization|private-token|x-auth-token|x-access-token)\
         [{space}]*[:=][{space}]*)(?:bearer[{space}]+|basic[{space}]+|token[{space}]+)?\
         [^{space},;]+"
    ))
    .expect("the header credential pattern is a valid regex")
});

// A bearer token with no header name before it, as a panic or a library's message may quote one.
static BARE_BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?i)(?-u:\\b)(bearer[{ECMASCRIPT_WHITESPACE_CLASS}]+)[A-Za-z0-9._~+/=-]{{8,}}"
    ))
    .expect("the bearer pattern is a valid regex")
});

// `name: value` and `name=value` credentials, the value optionally quoted.
static KEY_VALUE_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    let space = ECMASCRIPT_WHITESPACE_CLASS;
    Regex::new(&format!(
        "(?i)((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\
         [{space}]*[:=][{space}]*)([\"']?)[^{space}\"'&,;]+"
    ))
    .expect("the key-value credential pattern is a valid regex")
});

// Tokens known by their prefix.
static KNOWN_TOKEN_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]{8,}")
        .expect("the token prefix pattern is a valid regex")
});

/// A Unix path at a token boundary, with an optional `:line:col`; the leading group stands for
/// the boundary (`regex` has no look-behind) and is written back, so `feature/login` stays. A
/// folder's name may hold spaces and the last segment may not, so `/Users/a/My Project/x.rs` is
/// matched whole and the prose after a path is kept; prose between two paths can be matched with
/// them, the safe direction.
pub(crate) static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(^|[^A-Za-z0-9_.-])(?:/[A-Za-z0-9_.-]+(?: +[A-Za-z0-9_.-]+)*)*/[A-Za-z0-9_.-]+",
        r"(?::[0-9]+(?::[0-9]+)?)?",
    ))
    .expect("the pattern is a valid regex")
});

/// A UNC path, in its plain or verbatim `\\?\UNC\` form: the host has no spaces and may hold `$`
/// (`\\wsl$\`), the share and path segments may hold spaces.
pub(crate) static UNC_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\\\(?:\?\\UNC\\)?[A-Za-z0-9_.$-]+(?:\\[A-Za-z0-9_. -]+)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// A Windows drive path, plain or with its verbatim `\\?\` prefix, whose segments may hold spaces.
pub(crate) static DRIVE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\\\\\?\\)?[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// `raw_detail` with its credential material replaced by `***`. Redacting too much is the
/// accepted direction (`token: not found` becomes `token: ***`); redacting too little would put a
/// live credential on the wire.
pub(crate) fn scrub_credentials(raw_detail: &str) -> String {
    let scrubbed = URL_USERINFO.replace_all(raw_detail, |captures: &Captures<'_>| {
        format!("{}{CREDENTIAL_REDACTION}@", &captures[1])
    });
    let scrubbed = HEADER_CREDENTIAL.replace_all(&scrubbed, |captures: &Captures<'_>| {
        format!("{}{CREDENTIAL_REDACTION}", &captures[1])
    });
    let scrubbed = BARE_BEARER.replace_all(&scrubbed, |captures: &Captures<'_>| {
        format!("{}{CREDENTIAL_REDACTION}", &captures[1])
    });
    let scrubbed = KEY_VALUE_CREDENTIAL.replace_all(&scrubbed, |captures: &Captures<'_>| {
        format!("{}{}{CREDENTIAL_REDACTION}", &captures[1], &captures[2])
    });
    KNOWN_TOKEN_PREFIX
        .replace_all(&scrubbed, CREDENTIAL_REDACTION)
        .into_owned()
}
