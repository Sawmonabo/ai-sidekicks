//! Reads Codex's version out of its `initialize` reply's `userAgent`, which also carries the
//! caller's own name and version.

use serde_json::Value;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;

use crate::provider::driver::ReportedVersionReading;

/// The version in the reply's `userAgent`: only the word right after `<client_name>/` counts, and
/// only in its canonical form, since the agent text names other versions too. `client_name` is the
/// name the daemon sent at the handshake, holding no `/` and no whitespace.
pub(super) fn read_reported_version(reply: &Value, client_name: &str) -> ReportedVersionReading {
    let Some(user_agent) = reply.get("userAgent").and_then(Value::as_str) else {
        return ReportedVersionReading::UnreadableReply(String::new());
    };
    match user_agent.split_once('/') {
        Some((name, rest)) if name == client_name => {
            let token = rest
                .find(is_ecmascript_whitespace)
                .map_or(rest, |end| &rest[..end]);
            ReportedVersionReading::from_token(token, user_agent)
        }
        Some(_) | None => ReportedVersionReading::UnreadableReply(user_agent.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;

    use super::read_reported_version;
    use crate::provider::driver::ReportedVersionReading;

    #[rstest]
    #[case::own_version_not_the_callers(
        "sidekicks/0.163.0 (Mac OS 27.0.1; arm64) Apple_Terminal/488 (sidekicks; 9.9.9)",
        Some("0.163.0")
    )]
    #[case::another_clients_name("other/0.163.0 (Mac OS 27.0.1; arm64)", None)]
    #[case::two_parts("sidekicks/1.2 (Mac OS 27.0.1; arm64)", None)]
    #[case::build_metadata("sidekicks/1.2.3+b (Mac OS 27.0.1; arm64)", None)]
    fn the_version_is_the_canonical_word_after_the_client_name(
        #[case] user_agent: &str,
        #[case] version: Option<&str>,
    ) {
        let expected = version.map_or_else(
            || ReportedVersionReading::UnreadableReply(user_agent.to_owned()),
            |version| ReportedVersionReading::Version(version.to_owned()),
        );
        assert_eq!(
            read_reported_version(&json!({ "userAgent": user_agent }), "sidekicks"),
            expected
        );
    }
}
