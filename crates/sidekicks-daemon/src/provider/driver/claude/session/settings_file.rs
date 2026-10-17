//! Reading one of Claude Code's settings files the way the daemon can: a file that is absent, not
//! the daemon's to read, or not a settings object sets nothing the daemon can name.

use std::io::{self, ErrorKind};
use std::path::Path;

use serde_json::{Map, Value};

use crate::provider::inbound_json::decode_inbound_json;

/// Whether a file-system failure means the daemon cannot read the path, rather than a fault: the
/// path is absent, runs through a file, or is not the daemon's to read.
pub(crate) fn is_unreadable_path(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::PermissionDenied
    )
}

/// One settings file as its JSON object, or `None` when the daemon cannot read it or it holds no
/// settings object. Returns any other read failure.
pub(crate) async fn read_claude_settings_file(
    file_path: &Path,
) -> io::Result<Option<Map<String, Value>>> {
    let bytes = match tokio::fs::read(file_path).await {
        Ok(bytes) => bytes,
        Err(error) if is_unreadable_path(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    // A file that is not JSON sets nothing, as one holding some other JSON value does.
    let parsed = serde_json::from_str::<Value>(&decode_inbound_json(&bytes));
    if let Ok(Value::Object(settings)) = parsed {
        return Ok(Some(settings));
    }
    Ok(None)
}
