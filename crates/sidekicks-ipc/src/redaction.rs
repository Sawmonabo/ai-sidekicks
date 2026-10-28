//! What the daemon removes from text that leaves it or outlives the moment: the credential scrub,
//! URL queries, absolute paths and the cap on length, shared by a workspace's `lastError`, the
//! error responses, the crash reports and a provider's failure text.

use std::sync::LazyLock;

use regex::{Captures, NoExpand, Regex};
use sidekicks_contracts::wire::text::ECMASCRIPT_WHITESPACE_CLASS;
use sidekicks_std::text_cut::cut_to_code_points;

/// What stands in for each credential the scrub removes.
const CREDENTIAL_REDACTION: &str = "***";

/// What replaces an absolute path in a message or a field.
const REDACTED_PATH: &str = "<redacted-path>";

/// What a capped message or field value ends with.
const TRUNCATION_MARKER: &str = "…[truncated]";

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

// A URL's query, up to whitespace or its fragment: the scheme, host and path are kept in the first
// group, and the query, whose names and values can each carry a credential, is dropped whole.
static URL_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    let space = ECMASCRIPT_WHITESPACE_CLASS;
    Regex::new(&format!(
        r"(?-u:\b)([A-Za-z][A-Za-z0-9+.-]*://[^{space}?#]*)\?[^{space}#]*"
    ))
    .expect("the URL query pattern is a valid regex")
});

// A web address (`http`, `https`, `ws`, `wss`) up to whitespace, a character an address cannot
// hold unescaped, such as the quote closing a JSON string, or a `,`, `;`, `)` or `]` that can
// close it in prose: its host and path name a server, not a file on this machine, so the path
// redaction passes over it. An address path holding one of those is cut there and the rest is read
// as prose, which can redact more than the path, the safe direction.
static WEB_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    let space = ECMASCRIPT_WHITESPACE_CLASS;
    Regex::new(&format!(
        r#"(?-u:\b)(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?)://[^{space}"'<>`{{}}|\\^,;)\]]+"#
    ))
    .expect("the web address pattern is a valid regex")
});

/// A Unix path at a token boundary, with an optional `:line:col`; the leading group stands for
/// the boundary (`regex` has no look-behind) and is written back, so `feature/login` stays. A
/// folder's name may hold spaces and the last segment may not, so `/Users/a/My Project/x.rs` is
/// matched whole and the prose after a path is kept; prose between two paths can be matched with
/// them, the safe direction.
pub static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(^|[^A-Za-z0-9_.-])(?:/[A-Za-z0-9_.-]+(?: +[A-Za-z0-9_.-]+)*)*/[A-Za-z0-9_.-]+",
        r"(?::[0-9]+(?::[0-9]+)?)?",
    ))
    .expect("the pattern is a valid regex")
});

/// A UNC path, in its plain or verbatim `\\?\UNC\` form: the host has no spaces and may hold `$`
/// (`\\wsl$\`), the share and path segments may hold spaces.
pub static UNC_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\\\(?:\?\\UNC\\)?[A-Za-z0-9_.$-]+(?:\\[A-Za-z0-9_. -]+)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// A Windows drive path, plain or with its verbatim `\\?\` prefix, whose segments may hold spaces.
pub static DRIVE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\\\\\?\\)?[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// `raw_detail` with its credential material replaced by `***`. Redacting too much is the
/// accepted direction (`token: not found` becomes `token: ***`); redacting too little would put a
/// live credential on the wire.
pub fn scrub_credentials(raw_detail: &str) -> String {
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

/// `text` with the query of every `scheme://` URL in it replaced by `?***`, keeping the scheme,
/// host, path and fragment: a query's names and values are treated as credentials.
pub fn strip_url_queries(text: &str) -> String {
    URL_QUERY
        .replace_all(text, |captures: &Captures<'_>| {
            format!("{}?{CREDENTIAL_REDACTION}", &captures[1])
        })
        .into_owned()
}

/// `text` with each Unix, UNC and Windows-drive path, and its `:line:col`, replaced by
/// `<redacted-path>`. A Windows segment may hold spaces, so prose right after such a path can be
/// redacted with it, the safe direction.
pub fn redact_paths(text: &str) -> String {
    let text = UNIX_PATH.replace_all(text, |captures: &Captures<'_>| {
        format!("{}{REDACTED_PATH}", &captures[1])
    });
    let text = UNC_PATH.replace_all(&text, NoExpand(REDACTED_PATH));
    DRIVE_PATH
        .replace_all(&text, NoExpand(REDACTED_PATH))
        .into_owned()
}

/// `text` cut to at most `max_code_points` code points, its end replaced by `…[truncated]` when
/// cut; a cap shorter than the marker is cut bare, so the result never passes the cap.
pub fn cap_text(text: String, max_code_points: usize) -> String {
    if cut_to_code_points(&text, max_code_points).len() == text.len() {
        return text;
    }
    let Some(kept_code_points) = max_code_points.checked_sub(TRUNCATION_MARKER.chars().count())
    else {
        return cut_to_code_points(&text, max_code_points).to_owned();
    };
    let kept = cut_to_code_points(&text, kept_code_points);
    format!("{kept}{TRUNCATION_MARKER}")
}

/// A provider's failure text made safe to leave the daemon: credentials scrubbed, URL queries
/// stripped, absolute paths outside web addresses redacted, then capped at `max_code_points`. The
/// result never quotes a credential, a URL's userinfo or query, or an absolute path, and keeps a
/// web address's host and path.
pub fn sanitize_failure_reason(raw: &str, max_code_points: usize) -> String {
    let scrubbed = strip_url_queries(&scrub_credentials(raw));
    let mut sanitized = String::with_capacity(scrubbed.len());
    let mut after_address = 0;
    for address in WEB_ADDRESS.find_iter(&scrubbed) {
        sanitized.push_str(&redact_paths(&scrubbed[after_address..address.start()]));
        sanitized.push_str(address.as_str());
        after_address = address.end();
    }
    sanitized.push_str(&redact_paths(&scrubbed[after_address..]));
    cap_text(sanitized, max_code_points)
}

#[cfg(test)]
mod tests {
    use super::sanitize_failure_reason;

    // Without the query strip, the scrub leaves the query's name and its other members in place.
    #[test]
    fn a_failure_reason_quotes_no_credential_query_or_path_and_keeps_the_host() {
        let raw = "connect to https://user:pw@host.example/mcp?api_key=abc123&x=1#tools failed \
                   reading /Users/someone/.config/tool/secret.json";
        let sanitized = sanitize_failure_reason(raw, 512);
        for quoted in [
            "user",
            "pw",
            "api_key",
            "abc123",
            "x=1",
            "/Users/someone",
            "secret.json",
        ] {
            assert!(!sanitized.contains(quoted), "{quoted} in {sanitized}");
        }
        assert!(
            sanitized.contains("host.example/mcp?***#tools"),
            "{sanitized}"
        );
        let plain = sanitize_failure_reason("https://host.example/mcp?token=abc123 refused", 512);
        assert_eq!(plain, "https://host.example/mcp?*** refused");
        // An address ends at the quote closing its JSON string, so a path right after it is
        // still redacted.
        let json = sanitize_failure_reason(
            r#"{"url":"https://host.example/mcp","cwd":"/Users/someone/project"}"#,
            512,
        );
        assert_eq!(
            json,
            r#"{"url":"https://host.example/mcp","cwd":"<redacted-path>"}"#
        );
        // An address ends at a comma, a parenthesis or a bracket too, so a path glued after it by
        // one of them is still redacted.
        for (raw, expected) in [
            (
                "url=https://host.example/mcp,cwd=/Users/someone/project",
                "url=https://host.example/mcp,cwd=<redacted-path>",
            ),
            (
                "(https://host.example/mcp)/Users/someone/project",
                "(https://host.example/mcp)<redacted-path>",
            ),
            (
                "[https://a.example/x,/Users/someone/secret.json]",
                "[https://a.example/x,<redacted-path>]",
            ),
        ] {
            assert_eq!(sanitize_failure_reason(raw, 512), expected);
        }
    }
}
