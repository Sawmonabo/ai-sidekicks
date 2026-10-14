//! Turns a failure into the bounded, credential-free `lastError` a stale workspace carries.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use sidekicks_contracts::repo::workspace::WORKSPACE_LAST_ERROR_MAX_LEN;
use sidekicks_contracts::wire::text::{
    ECMASCRIPT_WHITESPACE_CLASS, FreeFormText, is_ecmascript_whitespace,
};

use crate::text_cut::cut_to_code_points;

/// The marker that ends a cut `lastError`; it counts inside the cap, which is the wire's cap too.
const WORKSPACE_LAST_ERROR_TRUNCATION_MARKER: &str = "...[truncated]";

/// What stands in for each credential the scrub removes.
const CREDENTIAL_REDACTION: &str = "***";

// The scrub's word boundaries are ASCII, `(?-u:\b)`, as JavaScript's `\b` is: under Unicode's `\b`
// a token right after a letter such as `é` would have no boundary before it and escape redaction.
// Every `\s` is ECMAScript's set spelled out. The two `(?i)` patterns fold `ſ` and the Kelvin sign
// as JavaScript's non-Unicode `/i` does not, which only redacts more.

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
    let scrubbed = KEY_VALUE_CREDENTIAL.replace_all(&scrubbed, |captures: &Captures<'_>| {
        format!("{}{}{CREDENTIAL_REDACTION}", &captures[1], &captures[2])
    });
    KNOWN_TOKEN_PREFIX
        .replace_all(&scrubbed, CREDENTIAL_REDACTION)
        .into_owned()
}

/// `raw_detail` made safe to store and legal on the wire: NULs dropped, credentials scrubbed,
/// then cut to the cap with the marker; `None` when nothing but whitespace is left. Scrubbing
/// comes before the cut, which could otherwise split a credential past its pattern.
pub(crate) fn normalize_workspace_last_error(
    raw_detail: &str,
) -> Option<FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>> {
    // NULs first: one could split a token past its pattern, and the wire refuses them.
    let scrubbed = scrub_credentials(&raw_detail.replace('\0', ""));
    // Checked before the cut: the marker would let an over-cap blank detail pass.
    if scrubbed.chars().all(is_ecmascript_whitespace) {
        return None;
    }
    let capped = if scrubbed.chars().count() <= WORKSPACE_LAST_ERROR_MAX_LEN {
        scrubbed
    } else {
        let kept =
            WORKSPACE_LAST_ERROR_MAX_LEN - WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.chars().count();
        format!(
            "{}{WORKSPACE_LAST_ERROR_TRUNCATION_MARKER}",
            cut_to_code_points(&scrubbed, kept)
        )
    };
    Some(
        FreeFormText::new(capped)
            .expect("NULs are dropped, a blank detail is refused and the cut keeps the cap"),
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{FreeFormText, WORKSPACE_LAST_ERROR_MAX_LEN, normalize_workspace_last_error};

    #[rstest]
    #[case::url_userinfo(
        "fatal: unable to access 'https://alice:s3cret@github.com/org/repo.git/'".to_owned(),
        Some("fatal: unable to access 'https://***@github.com/org/repo.git/'".to_owned())
    )]
    #[case::header(
        "> Authorization: Bearer abc.def.ghi\n> Accept: */*".to_owned(),
        Some("> Authorization: ***\n> Accept: */*".to_owned())
    )]
    #[case::key_value_quoted(
        "config: password=\"hunter2\" retries=3".to_owned(),
        Some("config: password=\"***\" retries=3".to_owned())
    )]
    #[case::known_prefixes(
        "used ghp_abcdefghijklmnop, glpat-ABCDEFGH12 and AKIAIOSFODNN7EXAMPLE".to_owned(),
        Some("used ***, *** and ***".to_owned())
    )]
    #[case::token_after_a_letter_outside_ascii(
        "éghp_abcdefghijklmnop".to_owned(),
        Some("é***".to_owned())
    )]
    #[case::nul_inside_a_token("gh\0p_abcdefghijklmnop".to_owned(), Some("***".to_owned()))]
    #[case::scrubbed_before_the_cut(
        format!("{} ghp_{}", "a".repeat(8170), "Z".repeat(40)),
        Some(format!("{} ***", "a".repeat(8170)))
    )]
    #[case::blank_after_nuls("\0 \u{feff}\n\0".to_owned(), None)]
    #[case::cut_counts_code_points(
        "é".repeat(WORKSPACE_LAST_ERROR_MAX_LEN + 1),
        Some(format!("{}...[truncated]", "é".repeat(WORKSPACE_LAST_ERROR_MAX_LEN - 14)))
    )]
    fn a_failure_detail_is_scrubbed_then_cut_within_the_cap(
        #[case] raw_detail: String,
        #[case] expected: Option<String>,
    ) {
        let normalized = normalize_workspace_last_error(&raw_detail);
        assert_eq!(normalized.map(FreeFormText::into_string), expected);
    }
}
