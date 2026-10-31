//! Turns a failure into the bounded, credential-free `lastError` a `rootLost` workspace carries.

use sidekicks_contracts::repo::workspace::WORKSPACE_LAST_ERROR_MAX_LEN;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_ipc::redaction::{scrub_credentials, strip_url_queries};
use sidekicks_std::text_cut::cut_to_code_points;

/// The marker that ends a cut `lastError`; it counts inside the cap, which is the wire's cap too.
const WORKSPACE_LAST_ERROR_TRUNCATION_MARKER: &str = "...[truncated]";

/// `raw_detail` made safe to store and legal on the wire: NULs dropped, credentials and URL
/// queries scrubbed, then cut to the cap with the marker; `None` when nothing but whitespace is
/// left. Scrubbing comes before the cut, which could otherwise split a credential past its pattern.
pub(crate) fn normalize_workspace_last_error(
    raw_detail: &str,
) -> Option<FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>> {
    // NULs first: one could split a token past its pattern, and the wire refuses them.
    let scrubbed = strip_url_queries(&scrub_credentials(&raw_detail.replace('\0', "")));
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
    // Killed by the bare bearer pattern dropped.
    #[case::bare_bearer(
        "retry with Bearer abcd.efgh-ijkl failed".to_owned(),
        Some("retry with Bearer *** failed".to_owned())
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
    // Killed by the query strip dropped.
    #[case::url_query(
        "fatal: unable to access https://host.example/repo.git?access=abc123 (403)".to_owned(),
        Some("fatal: unable to access https://host.example/repo.git?*** (403)".to_owned())
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
