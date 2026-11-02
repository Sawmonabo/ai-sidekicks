//! The home that holds a Claude Code conversation, kept in its binding's recovery data: Claude Code
//! writes a conversation into the configuration home its process runs on, and a switch moves only
//! the sign-in, so after one the conversation stays in a home that is not the account's own, and
//! every later start resumes it there.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

// The key of a binding's recovery data that names the home holding its conversation.
const CONVERSATION_HOME_KEY: &str = "conversationHome";

/// The configuration home `runtime_metadata` names for its conversation, an absolute path; `None`
/// where it names none, so the conversation lives in the home of the account the binding names.
pub(crate) fn read_claude_conversation_home(
    runtime_metadata: &Map<String, Value>,
) -> Option<PathBuf> {
    runtime_metadata
        .get(CONVERSATION_HOME_KEY)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
}

/// Recovery data naming `home` as the configuration home that holds the conversation.
pub(crate) fn claude_conversation_home_metadata(home: &Path) -> Map<String, Value> {
    Map::from_iter([(
        CONVERSATION_HOME_KEY.to_owned(),
        Value::from(home.to_string_lossy().into_owned()),
    )])
}
