//! Why Codex ended an MCP login without a sign-in, read from the error text of its completion
//! notice into the daemon's own fixed words, so no authorization server's text, error description
//! or address leaves the driver; the text itself goes to one log line, made safe first.

use std::fmt;

use sidekicks_ipc::redaction::sanitize_failure_reason;

use crate::driver::mcp_server::status::FAILURE_TEXT_MAX_CODE_POINTS;

/// Why Codex ended an MCP login without a sign-in, each in the daemon's own words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexLoginFailure {
    /// The browser came back carrying the authorization server's error instead of a code.
    CallbackCarriedError,
    /// The authorization server did not exchange the code for tokens.
    CodeNotRedeemed,
    /// The browser did not come back before Codex stopped waiting.
    DidNotFinishInTime,
    /// Codex gave another reason, or none.
    Unrecognized,
}

impl CodexLoginFailure {
    /// The failure Codex's completion `error` text names, by the words Codex's login writes at
    /// the start of each; the text, with credentials, queries and paths taken out, is logged.
    pub(crate) fn read(error: Option<&str>) -> Self {
        let Some(text) = error else {
            return Self::Unrecognized;
        };
        tracing::warn!(
            codex_error = %sanitize_failure_reason(text, FAILURE_TEXT_MAX_CODE_POINTS),
            "Codex ended an MCP login without a sign-in"
        );
        if text.starts_with("OAuth provider returned") || text.starts_with("OAuth error:") {
            Self::CallbackCarriedError
        } else if text.starts_with("failed to handle OAuth callback")
            || text.starts_with("failed to retrieve OAuth credentials")
            || text.starts_with("OAuth provider did not return credentials")
        {
            Self::CodeNotRedeemed
        } else if text.starts_with("timed out waiting for OAuth callback")
            || text.starts_with("OAuth callback was cancelled")
        {
            Self::DidNotFinishInTime
        } else {
            Self::Unrecognized
        }
    }
}

impl fmt::Display for CodexLoginFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CallbackCarriedError => "the authorization server sent back an error",
            Self::CodeNotRedeemed => "the authorization server did not accept the sign-in code",
            Self::DidNotFinishInTime => "the browser did not come back in time",
            Self::Unrecognized => "Codex gave no reason the daemon reads",
        })
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::CodexLoginFailure;

    // Each text Codex's login ends with reads as its fixed failure, and any other as unrecognized.
    // Killed by a misread or a dropped prefix.
    #[rstest]
    #[case::callback_error(
        "OAuth provider returned `access_denied`: see https://idp.example.test/deny?code=one",
        CodexLoginFailure::CallbackCarriedError
    )]
    #[case::callback_description("OAuth error: refused", CodexLoginFailure::CallbackCarriedError)]
    #[case::exchange("failed to handle OAuth callback", CodexLoginFailure::CodeNotRedeemed)]
    #[case::no_credentials(
        "OAuth provider did not return credentials",
        CodexLoginFailure::CodeNotRedeemed
    )]
    #[case::timeout(
        "timed out waiting for OAuth callback",
        CodexLoginFailure::DidNotFinishInTime
    )]
    #[case::canceled("OAuth callback was cancelled", CodexLoginFailure::DidNotFinishInTime)]
    #[case::other("the listener could not bind", CodexLoginFailure::Unrecognized)]
    fn codex_login_text_reads_as_its_fixed_failure(
        #[case] text: &str,
        #[case] expected: CodexLoginFailure,
    ) {
        assert_eq!(CodexLoginFailure::read(Some(text)), expected);
    }
}
