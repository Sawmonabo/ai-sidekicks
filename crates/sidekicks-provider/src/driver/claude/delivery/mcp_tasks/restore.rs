//! What Claude Code keeps of its tool servers' background calls, beside the conversation's file in
//! `projects/<project>/<session>/mcp-tasks/`: a call's record `mcp-task-<id>.meta.json`, written
//! when the call moves to the background, and its saved ending `mcp-task-<id>.outcome.json`,
//! written as it ends, both naming the call by `toolUseId`. Claude Code deletes the record at the
//! ending and the saved ending once the model reads it, so a call with neither is not kept. Also
//! the store's entries a resume rebuilds the held calls through, from the session's log and these
//! files.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_platforms::PathRules;
use sidekicks_std::missing_entry::MissingEntry;
use tokio::io::AsyncReadExt;

use super::{ClaudeHeldCall, ClaudeHeldCallEnd, ClaudeToolServerTasks};
use crate::driver::claude::delivery::messages::{ClaudeOpenToolCall, ClaudeToolCallOutcome};
use crate::driver::claude::session::conversation_file::find_claude_conversation_file;
use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::driver::claude::session::restart::ended_process::ClaudeEndedConversation;
use crate::driver::claude::spawn::environment::claude_config_folder;
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
    // The ending a saved ending, `saved_ending` as written, records: `completed` with its message,
    // else the call's name and `completed`; `failed` the same way; `cancelled` stopped, with its
    // message or no body; none for any other status.
    fn into_ending(self, saved_ending: Arc<str>) -> Option<ClaudeKeptCall> {
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
        Some(ClaudeKeptCall::Ended {
            outcome,
            text,
            saved_ending,
        })
    }
}

/// What Claude Code keeps of one held call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeKeptCall {
    /// Its saved ending: how it ended, its body and the file's JSON as Claude Code wrote it.
    Ended {
        /// How it ended.
        outcome: ClaudeToolCallOutcome,
        /// Its body, none for a call cancelled with no message.
        text: Option<String>,
        /// The saved ending's JSON as Claude Code wrote it, which the call's trace carries.
        saved_ending: Arc<str>,
    },
    /// Its record alone: the call survives, still running.
    Recorded,
    /// Nothing.
    Unkept,
}

/// Why the daemon settles a held call with no process to follow it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHeldCallSettle {
    /// The process ended while the daemon runs on, at an exit or before a resume, so a call its
    /// record keeps may still be restored.
    ProcessExit,
    /// The session closed, so no process restores a call again: one read as recorded, a kept
    /// file not yet readable among them, ends with the process too.
    SessionClose,
    /// The daemon restarted with no process of the session running, so a call its record keeps
    /// may still be restored, and one kept nowhere ended with the restart.
    Restart,
    /// The person stopped the service with no process of the session running, so a call its
    /// record keeps waits for the next resume, and one kept nowhere ended with the Stop.
    Stop,
}

impl ClaudeKeptCall {
    /// The saved ending's JSON as Claude Code wrote it, where one is kept.
    pub(crate) fn saved_ending(&self) -> Option<&str> {
        match self {
            Self::Ended { saved_ending, .. } => Some(saved_ending),
            Self::Recorded | Self::Unkept => None,
        }
    }

    /// How the call ends once the process that held it is gone, settled for `settle`: as its saved
    /// ending says, else failed as ended with the process, or with the restart or the Stop after
    /// one, with no body; `None` when a process ended or the daemon restarted or stopped for a call
    /// read as recorded, which a later process may restore.
    pub(crate) fn into_end(
        self,
        settle: ClaudeHeldCallSettle,
    ) -> Option<(ClaudeToolCallOutcome, Option<String>)> {
        let ended_with_the_process = (
            ClaudeToolCallOutcome::Failed {
                end_cause: Some(ToolCallEndCause::ProcessExit),
            },
            None,
        );
        match self {
            Self::Ended { outcome, text, .. } => Some((outcome, text)),
            Self::Recorded => match settle {
                ClaudeHeldCallSettle::ProcessExit
                | ClaudeHeldCallSettle::Restart
                | ClaudeHeldCallSettle::Stop => None,
                ClaudeHeldCallSettle::SessionClose => Some(ended_with_the_process),
            },
            Self::Unkept => match settle {
                ClaudeHeldCallSettle::ProcessExit | ClaudeHeldCallSettle::SessionClose => {
                    Some(ended_with_the_process)
                }
                ClaudeHeldCallSettle::Restart => Some((
                    ClaudeToolCallOutcome::Failed {
                        end_cause: Some(ToolCallEndCause::DaemonRestart),
                    },
                    None,
                )),
                ClaudeHeldCallSettle::Stop => Some((
                    ClaudeToolCallOutcome::Failed {
                        end_cause: Some(ToolCallEndCause::DaemonStop),
                    },
                    None,
                )),
            },
        }
    }
}

/// What Claude Code keeps of one conversation's background calls, by call, and the tasks whose
/// kept file could not be read as one, as while Claude Code still writes it.
#[derive(Default)]
pub(crate) struct ClaudeKeptCalls {
    endings: HashMap<String, ClaudeKeptCall>,
    recorded: HashSet<String>,
    unreadable_task_ids: HashSet<String>,
}

impl ClaudeKeptCalls {
    /// What is kept of the call `tool_use_id` of the task `task_id`: its saved ending first, then
    /// its record; a task with a kept file that could not be read reads as recorded, so its call
    /// stays open until a later read.
    pub(crate) fn call(&self, tool_use_id: &str, task_id: &str) -> ClaudeKeptCall {
        if let Some(ending) = self.endings.get(tool_use_id) {
            return ending.clone();
        }
        if self.recorded.contains(tool_use_id) || self.unreadable_task_ids.contains(task_id) {
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

    /// The calls `conversation` keeps, in the config folder its process's environment names.
    pub(crate) fn of_conversation(conversation: &ClaudeEndedConversation) -> Self {
        Self::new(
            claude_config_folder(&conversation.spawn_environment, PathRules::NATIVE),
            conversation.provider_session_id.clone(),
        )
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

impl ClaudeToolServerTasks {
    /// Holds the call `tool_use_id` of the task `task_id`, rebuilt from the session's log, as a
    /// resumed process's record says it still runs, until its task's restored start or ending.
    pub(crate) fn hold_restored(
        &mut self,
        task_id: String,
        tool_use_id: String,
        opened: ClaudeOpenToolCall,
    ) {
        self.held.insert(
            task_id,
            ClaudeHeldCall {
                tool_use_id,
                opened,
                newest_run_id: None,
            },
        );
    }

    /// Keeps the call `tool_use_id` of the task `task_id` settled, as the daemon settled it with no
    /// process, so a restored task's ending still closes it; kept oldest first, so past the cap the
    /// newest stay.
    pub(crate) fn keep_settled(
        &mut self,
        task_id: String,
        tool_use_id: String,
        opened: ClaudeOpenToolCall,
    ) {
        self.settled.push(
            task_id,
            ClaudeHeldCall {
                tool_use_id,
                opened,
                newest_run_id: None,
            },
        );
    }

    /// The ends of the held calls of `task_ids` the resumed process did not restore, each failed
    /// as ended with the process, with no body, and settled; a task no longer held is passed over.
    pub(crate) fn end_unrestored<'a>(
        &mut self,
        task_ids: impl Iterator<Item = &'a str>,
    ) -> Vec<ClaudeHeldCallEnd> {
        task_ids
            .filter_map(|task_id| {
                let call = self.held.remove(task_id)?;
                let outcome = ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::ProcessExit),
                };
                Some(self.settle(task_id.to_owned(), call, outcome, None))
            })
            .collect()
    }
}

/// Reads what Claude Code keeps of the conversation `provider_session_id`'s background calls
/// under `config_folder`; nothing for a conversation or folder that is missing. A file gone
/// before its read is passed over; one that is no JSON object naming its call is logged and its
/// task, named in the file's name, read as recorded. Fails with `InvalidData` for a file past the
/// output line ceiling, and with any other read failure.
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
            .and_then(|name| name.strip_prefix(KEPT_FILE_PREFIX))
        else {
            continue;
        };
        let (task_id, is_saved_ending) = match (
            name.strip_suffix(SAVED_ENDING_SUFFIX),
            name.strip_suffix(RECORD_SUFFIX),
        ) {
            (Some(task_id), _) => (task_id, true),
            (None, Some(task_id)) => (task_id, false),
            (None, None) => continue,
        };
        if task_id.is_empty() {
            continue;
        }
        let path = entry.path();
        let Some((text, file)) = read_kept_file(&path).await? else {
            continue;
        };
        let Some((tool_use_id, file)) = file.and_then(|mut file| {
            let tool_use_id = file.tool_use_id.take().filter(|id| !id.is_empty())?;
            Some((tool_use_id, file))
        }) else {
            tracing::warn!(
                path = %path.display(),
                "a kept file of a Claude Code background call could not be read as a call's \
                 record or ending, so its task reads as still running"
            );
            kept.unreadable_task_ids.insert(task_id.to_owned());
            continue;
        };
        if !is_saved_ending {
            kept.recorded.insert(tool_use_id);
        } else if let Some(ending) = file.into_ending(text) {
            kept.endings.insert(tool_use_id, ending);
        }
    }
    Ok(kept)
}

// One kept file, read whole: its text as decoded and its members, none for one that is no JSON
// object; `None` for one gone before its read.
async fn read_kept_file(path: &Path) -> io::Result<Option<(Arc<str>, Option<ClaudeKeptCallFile>)>> {
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
    let text: Arc<str> = Arc::from(decode_inbound_json(&bytes));
    let file =
        <ClaudeKeptCallFile as Lenient>::read(&mut serde_json::Deserializer::from_str(&text))
            .ok()
            .flatten();
    Ok(Some((text, file)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

    use super::{ClaudeKeptCall, ClaudeKeptCallsSource};
    use crate::driver::claude::delivery::messages::ClaudeToolCallOutcome;

    // Fails when the record is read before the saved ending, when a cancelled call reads as
    // plainly failed, when a saved ending with no message loses its call's name, or when a record
    // still being written closes its call. Mutations: `call` checking `recorded` first; the
    // `cancelled` arm's end cause dropped; `into_ending` dropping the call's name; an unreadable
    // file passed over (call-5 reads `Unkept`) or read as recorded under another task (call-6
    // reads `Recorded`).
    #[tokio::test]
    async fn the_saved_ending_is_read_before_the_record() {
        let config_folder = tempfile::tempdir().expect("a scratch config folder");
        let session_id = "6f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b";
        let project = config_folder.path().join("projects").join("p");
        let kept = project.join(session_id).join("mcp-tasks");
        std::fs::create_dir_all(&kept).expect("the kept folder is made");
        std::fs::write(project.join(format!("{session_id}.jsonl")), "")
            .expect("the conversation file is written");
        let cancelled = json!({
            "toolUseId": "call-1",
            "status": "cancelled",
            "statusMessage": "server cancelled the export",
            "serverName": "files",
            "toolName": "export",
        });
        let completed = json!({
            "toolUseId": "call-4",
            "status": "completed",
            "serverName": "files",
            "toolName": "export",
        });
        let files = [
            ("mcp-task-task-1.outcome.json", cancelled.clone()),
            (
                "mcp-task-task-1.meta.json",
                json!({"toolUseId": "call-1", "serverName": "files", "toolName": "export"}),
            ),
            (
                "mcp-task-task-2.meta.json",
                json!({"toolUseId": "call-2", "serverName": "files", "toolName": "export"}),
            ),
            ("mcp-task-task-4.outcome.json", completed.clone()),
        ];
        for (name, contents) in files {
            std::fs::write(kept.join(name), contents.to_string()).expect("a kept file is written");
        }
        std::fs::write(
            kept.join("mcp-task-task-5.meta.json"),
            r#"{"toolUseId": "ca"#,
        )
        .expect("a record cut off mid-write is written");

        let source = ClaudeKeptCallsSource::new(
            Some(config_folder.path().to_owned()),
            session_id.to_owned(),
        );
        let calls = source.read().await.expect("the kept files are read");

        assert_eq!(
            calls.call("call-1", "task-1"),
            ClaudeKeptCall::Ended {
                outcome: ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                },
                text: Some("server cancelled the export".to_owned()),
                saved_ending: Arc::from(cancelled.to_string()),
            }
        );
        assert_eq!(calls.call("call-2", "task-2"), ClaudeKeptCall::Recorded);
        assert_eq!(calls.call("call-3", "task-3"), ClaudeKeptCall::Unkept);
        assert_eq!(calls.call("call-5", "task-5"), ClaudeKeptCall::Recorded);
        assert_eq!(calls.call("call-6", "task-6"), ClaudeKeptCall::Unkept);
        assert_eq!(
            calls.call("call-4", "task-4"),
            ClaudeKeptCall::Ended {
                outcome: ClaudeToolCallOutcome::Completed,
                text: Some("files/export completed".to_owned()),
                saved_ending: Arc::from(completed.to_string()),
            }
        );
    }
}
