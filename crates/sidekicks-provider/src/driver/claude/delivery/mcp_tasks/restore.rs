//! What Claude Code keeps of its tool servers' background calls, beside the conversation's file in
//! `projects/<project>/<session>/mcp-tasks/`: a call's record `mcp-task-<id>.meta.json`, written
//! when the call moves to the background, and its saved ending `mcp-task-<id>.outcome.json`,
//! written as it ends, both naming the call by `toolUseId`. Claude Code deletes the record at the
//! ending and the saved ending once the model reads it, so a call with neither is not kept.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_std::missing_entry::MissingEntry;
use tokio::io::AsyncReadExt;

use crate::driver::claude::delivery::messages::ClaudeToolCallOutcome;
use crate::driver::claude::session::conversation_file::find_claude_conversation_file;
use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::{Lenient, lenient_object, read_lenient};

/// The start of each kept file's name.
const KEPT_FILE_PREFIX: &str = "mcp-task-";

/// The end of a saved ending's file name.
const SAVED_ENDING_SUFFIX: &str = ".outcome.json";

/// The end of a record's file name.
const RECORD_SUFFIX: &str = ".meta.json";

// The members of a record or a saved ending that are read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeKeptCallFile {
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    status: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    status_message: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    server_name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_name: Option<String>,
}

lenient_object!(ClaudeKeptCallFile);

impl ClaudeKeptCallFile {
    // The ending a saved ending records: `completed` with its message, else the call's name and
    // `completed`; `failed` the same way; `cancelled` stopped, with its message or no body; none
    // for any other status.
    fn into_ending(self) -> Option<ClaudeKeptCall> {
        let message = self.status_message.filter(|message| !message.is_empty());
        let named = |ended: &str| {
            let server = self.server_name.as_deref().unwrap_or_default();
            let tool = self.tool_name.as_deref().unwrap_or_default();
            format!("{server}/{tool} {ended}")
        };
        let (outcome, text) = match self.status.as_deref()? {
            "completed" => (
                ClaudeToolCallOutcome::Completed,
                Some(message.unwrap_or_else(|| named("completed"))),
            ),
            "failed" => (
                ClaudeToolCallOutcome::Failed { end_cause: None },
                Some(message.unwrap_or_else(|| named("failed"))),
            ),
            "cancelled" => (
                ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                },
                message,
            ),
            _ => return None,
        };
        Some(ClaudeKeptCall::Ended { outcome, text })
    }
}

/// What Claude Code keeps of one held call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeKeptCall {
    /// Its saved ending: how it ended and its body.
    Ended {
        /// How it ended.
        outcome: ClaudeToolCallOutcome,
        /// Its body, none for a call cancelled with no message.
        text: Option<String>,
    },
    /// Its record alone: the call survives, still running.
    Recorded,
    /// Nothing.
    Unkept,
}

/// What Claude Code keeps of one conversation's background calls, by call.
#[derive(Default)]
pub(crate) struct ClaudeKeptCalls {
    endings: HashMap<String, ClaudeKeptCall>,
    recorded: HashSet<String>,
}

impl ClaudeKeptCalls {
    /// What is kept of the call `tool_use_id`: its saved ending first, then its record.
    pub(crate) fn call(&self, tool_use_id: &str) -> ClaudeKeptCall {
        if let Some(ending) = self.endings.get(tool_use_id) {
            return ending.clone();
        }
        if self.recorded.contains(tool_use_id) {
            return ClaudeKeptCall::Recorded;
        }
        ClaudeKeptCall::Unkept
    }
}

/// Where a session's process keeps its background calls: its config folder, where one is known,
/// and its conversation.
#[derive(Clone)]
pub(crate) struct ClaudeKeptCallsSource {
    config_folder: Option<PathBuf>,
    provider_session_id: String,
}

impl ClaudeKeptCallsSource {
    /// The calls the conversation `provider_session_id` keeps under `config_folder`.
    pub(crate) fn new(config_folder: Option<PathBuf>, provider_session_id: String) -> Self {
        Self {
            config_folder,
            provider_session_id,
        }
    }

    /// Reads what is kept now; nothing where no config folder is known. Fails as
    /// [`read_claude_kept_calls`] does.
    pub(crate) async fn read(&self) -> io::Result<ClaudeKeptCalls> {
        let Some(config_folder) = &self.config_folder else {
            return Ok(ClaudeKeptCalls::default());
        };
        read_claude_kept_calls(config_folder, &self.provider_session_id).await
    }
}

/// Reads what Claude Code keeps of the conversation `provider_session_id`'s background calls
/// under `config_folder`; nothing for a conversation or folder that is missing. A file gone
/// before its read, or that is no JSON object, is passed over. Fails with `InvalidData` for a file
/// past the output line ceiling, and with any other read failure.
pub(crate) async fn read_claude_kept_calls(
    config_folder: &Path,
    provider_session_id: &str,
) -> io::Result<ClaudeKeptCalls> {
    let mut kept = ClaudeKeptCalls::default();
    let Some(conversation_file) =
        find_claude_conversation_file(config_folder, provider_session_id).await?
    else {
        return Ok(kept);
    };
    let folder = conversation_file
        .with_file_name(provider_session_id)
        .join("mcp-tasks");
    let Some(mut entries) = tokio::fs::read_dir(&folder).await.none_if_missing()? else {
        return Ok(kept);
    };
    while let Some(entry) = entries.next_entry().await? {
        let file_name = entry.file_name();
        let Some(name) = file_name
            .to_str()
            .filter(|name| name.starts_with(KEPT_FILE_PREFIX))
        else {
            continue;
        };
        let is_saved_ending = name.ends_with(SAVED_ENDING_SUFFIX);
        if !is_saved_ending && !name.ends_with(RECORD_SUFFIX) {
            continue;
        }
        let Some(mut file) = read_kept_file(&entry.path()).await? else {
            continue;
        };
        let Some(tool_use_id) = file.tool_use_id.take().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !is_saved_ending {
            kept.recorded.insert(tool_use_id);
        } else if let Some(ending) = file.into_ending() {
            kept.endings.insert(tool_use_id, ending);
        }
    }
    Ok(kept)
}

// One kept file, read whole; `None` for one gone before its read or that is no JSON object.
async fn read_kept_file(path: &Path) -> io::Result<Option<ClaudeKeptCallFile>> {
    let Some(file) = tokio::fs::File::open(path).await.none_if_missing()? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(CLAUDE_OUTPUT_LINE_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > CLAUDE_OUTPUT_LINE_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "a kept file of a Claude Code background call passed {} bytes: {}",
                CLAUDE_OUTPUT_LINE_MAX_BYTES,
                path.display()
            ),
        ));
    }
    let text = decode_inbound_json(&bytes);
    Ok(
        <ClaudeKeptCallFile as Lenient>::read(&mut serde_json::Deserializer::from_str(&text))
            .ok()
            .flatten(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

    use super::{ClaudeKeptCall, ClaudeKeptCallsSource};
    use crate::driver::claude::delivery::messages::ClaudeToolCallOutcome;

    // Fails when the record is read before the saved ending, when a cancelled call reads as
    // plainly failed, or when a saved ending with no message loses its call's name. Mutations:
    // `call` checking `recorded` first; the `cancelled` arm's end cause dropped; `into_ending`
    // dropping the call's name.
    #[tokio::test]
    async fn the_saved_ending_is_read_before_the_record() {
        let config_folder = tempfile::tempdir().expect("a scratch config folder");
        let session_id = "6f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b";
        let project = config_folder.path().join("projects").join("p");
        let kept = project.join(session_id).join("mcp-tasks");
        std::fs::create_dir_all(&kept).expect("the kept folder is made");
        std::fs::write(project.join(format!("{session_id}.jsonl")), "")
            .expect("the conversation file is written");
        let files = [
            (
                "mcp-task-task-1.outcome.json",
                json!({
                    "toolUseId": "call-1",
                    "status": "cancelled",
                    "statusMessage": "server cancelled the export",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
            (
                "mcp-task-task-1.meta.json",
                json!({"toolUseId": "call-1", "serverName": "files", "toolName": "export"}),
            ),
            (
                "mcp-task-task-2.meta.json",
                json!({"toolUseId": "call-2", "serverName": "files", "toolName": "export"}),
            ),
            (
                "mcp-task-task-4.outcome.json",
                json!({
                    "toolUseId": "call-4",
                    "status": "completed",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
        ];
        for (name, contents) in files {
            std::fs::write(kept.join(name), contents.to_string()).expect("a kept file is written");
        }

        let source = ClaudeKeptCallsSource::new(
            Some(config_folder.path().to_owned()),
            session_id.to_owned(),
        );
        let calls = source.read().await.expect("the kept files are read");

        assert_eq!(
            calls.call("call-1"),
            ClaudeKeptCall::Ended {
                outcome: ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                },
                text: Some("server cancelled the export".to_owned()),
            }
        );
        assert_eq!(calls.call("call-2"), ClaudeKeptCall::Recorded);
        assert_eq!(calls.call("call-3"), ClaudeKeptCall::Unkept);
        assert_eq!(
            calls.call("call-4"),
            ClaudeKeptCall::Ended {
                outcome: ClaudeToolCallOutcome::Completed,
                text: Some("files/export completed".to_owned()),
            }
        );
    }
}
