//! Why Codex ended an MCP login without a sign-in, read from the error text of its completion
//! notice into the driver contract's fixed kinds, so no authorization server's text, error
//! description or address leaves the driver; the text itself goes to one log line, made safe first.

use sidekicks_ipc::redaction::sanitize_failure_reason;

use crate::driver::contract::sign_in::ProviderSignInFailure;
use crate::driver::mcp_server::status::FAILURE_TEXT_MAX_CODE_POINTS;

/// The failure Codex's completion `error` text names, by the words Codex's login writes at the
/// start of each, and `ReplyUnreadable` for any other text or none; the text, with credentials,
/// queries and paths taken out, is logged.
pub(crate) fn read_codex_login_failure(error: Option<&str>) -> ProviderSignInFailure {
    let Some(text) = error else {
        return ProviderSignInFailure::ReplyUnreadable;
    };
    tracing::warn!(
        codex_error = %sanitize_failure_reason(text, FAILURE_TEXT_MAX_CODE_POINTS),
        "Codex ended an MCP login without a sign-in"
    );
    if text.starts_with("OAuth provider returned") || text.starts_with("OAuth error:") {
        ProviderSignInFailure::CallbackCarriedError
    } else if text.starts_with("failed to handle OAuth callback")
        || text.starts_with("failed to retrieve OAuth credentials")
        || text.starts_with("OAuth provider did not return credentials")
    {
        ProviderSignInFailure::CodeNotRedeemed
    } else if text.starts_with("timed out waiting for OAuth callback")
        || text.starts_with("OAuth callback was cancelled")
    {
        ProviderSignInFailure::DidNotFinishInTime
    } else {
        ProviderSignInFailure::ReplyUnreadable
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::read_codex_login_failure;
    use crate::driver::contract::sign_in::ProviderSignInFailure;

    // Each text Codex's login ends with reads as its kind, and any other text, or none, as the
    // unread kind. Killed by a misread, a dropped prefix or two kinds swapped.
    #[rstest]
    #[case::callback_error(
        Some(
            "OAuth provider returned `access_denied`: see https://idp.example.test/deny?code=one"
        ),
        ProviderSignInFailure::CallbackCarriedError
    )]
    #[case::callback_description(
        Some("OAuth error: refused"),
        ProviderSignInFailure::CallbackCarriedError
    )]
    #[case::exchange(
        Some("failed to handle OAuth callback"),
        ProviderSignInFailure::CodeNotRedeemed
    )]
    #[case::credentials(
        Some("failed to retrieve OAuth credentials"),
        ProviderSignInFailure::CodeNotRedeemed
    )]
    #[case::no_credentials(
        Some("OAuth provider did not return credentials"),
        ProviderSignInFailure::CodeNotRedeemed
    )]
    #[case::timeout(
        Some("timed out waiting for OAuth callback"),
        ProviderSignInFailure::DidNotFinishInTime
    )]
    #[case::canceled(
        Some("OAuth callback was cancelled"),
        ProviderSignInFailure::DidNotFinishInTime
    )]
    #[case::other(
        Some("the listener could not bind"),
        ProviderSignInFailure::ReplyUnreadable
    )]
    #[case::none(None, ProviderSignInFailure::ReplyUnreadable)]
    fn codex_login_text_reads_as_its_kind(
        #[case] text: Option<&str>,
        #[case] expected: ProviderSignInFailure,
    ) {
        assert_eq!(read_codex_login_failure(text), expected);
    }
}
