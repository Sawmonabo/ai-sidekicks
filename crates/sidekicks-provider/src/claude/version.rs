//! Reads Claude Code's version out of its `get_binary_version` reply, `{version, buildTime}`.

use serde_json::Value;

use crate::driver::ReportedVersionReading;

/// The version the reply reports, kept only in its canonical form; a reply with no version text
/// reads as unreadable with no text.
pub(super) fn read_reported_version(reply: &Value) -> ReportedVersionReading {
    match reply.get("version").and_then(Value::as_str) {
        Some(version) => ReportedVersionReading::from_token(version, version),
        None => ReportedVersionReading::UnreadableReply(String::new()),
    }
}
