//! Each write a Claude Code agent's own file tool makes, the lead's or a helper's, as the chat
//! versions' intake takes it: a `Write`, `Edit` or `NotebookEdit` call opens at its `tool_use` once
//! it names a path, and settles at its result with the text the result says the file now holds,
//! with no write, or unread. A call still open when its turn ends, an interrupt is answered or the
//! process ends settles unread, so no call holds its path's watch reports for good. An open is
//! handed to the intake on the session's task, ahead of the frames after it; a settle is recorded
//! on a task of the session's own, so no frame waits on a version's disk read or writes.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::mpsc;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::lenient_json::read_lenient;
use crate::port::file_tool_write::{
    FileToolWriteClaim, FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort,
    FileToolWriteSettled,
};

/// A Claude Code tool that writes one file and says in its result what the file then holds, and
/// whose result is read for that file's patch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeFileTool {
    /// Writes a whole file.
    Write,
    /// Replaces a string in a file.
    Edit,
    /// Changes one cell of a notebook.
    NotebookEdit,
}

impl ClaudeFileTool {
    /// The file tool Claude Code names `tool_name`; `None` for any other tool.
    pub(crate) fn of(tool_name: &str) -> Option<Self> {
        match tool_name {
            "Write" => Some(Self::Write),
            "Edit" => Some(Self::Edit),
            "NotebookEdit" => Some(Self::NotebookEdit),
            _ => None,
        }
    }

    // The file the call's input names: a notebook's own path, any other tool's `file_path`. The
    // input is untrusted provider output; every other member, a written file's text among them,
    // is skipped unread.
    fn read_path(self, input: &RawValue) -> Option<PathBuf> {
        let input = serde_json::from_str::<ClaudeFileToolInput>(input.get()).ok()?;
        let path = match self {
            Self::Write | Self::Edit => input.file_path,
            Self::NotebookEdit => input.notebook_path,
        }?;
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    // What the call's lone, unfailed result says it left, `None` for a shape none of these reads.
    fn read_outcome(self, result: &Map<String, Value>) -> Option<FileToolWriteOutcome> {
        let text = |member: &str| result.get(member).and_then(Value::as_str);
        // A write held for the machine owner's review left the file unchanged.
        if result.get("staged").and_then(Value::as_bool) == Some(true) {
            return Some(FileToolWriteOutcome::NotWritten);
        }
        let claimed = |text: String| FileToolWriteOutcome::Claimed(FileToolWriteClaim::Text(text));
        match self {
            Self::Write => {
                let content = text("content")?;
                // A result passed on from another process, or cut for its size, empties an
                // update's content beside no original, so it does not say what was written.
                let is_cut = content.is_empty()
                    && text("type") == Some("update")
                    && result.get("originalFile").is_some_and(Value::is_null);
                Some(if is_cut {
                    FileToolWriteOutcome::Unread
                } else {
                    claimed(content.to_owned())
                })
            }
            Self::Edit => {
                // No original when the file was too large to include.
                if result.get("originalFile").is_some_and(Value::is_null) {
                    return Some(FileToolWriteOutcome::Unread);
                }
                let original = text("originalFile")?;
                let (old, new) = (text("oldString")?, text("newString")?);
                // An empty old string creates the file with the new text.
                if old.is_empty() {
                    return Some(claimed(new.to_owned()));
                }
                let is_replace_all =
                    result.get("replaceAll").and_then(Value::as_bool) == Some(true);
                Some(claimed(if is_replace_all {
                    original.replace(old, new)
                } else {
                    original.replacen(old, new, 1)
                }))
            }
            Self::NotebookEdit => {
                // A failed edit leaves both files empty.
                if is_failed_notebook_edit(result) {
                    return Some(FileToolWriteOutcome::NotWritten);
                }
                // A result passed on from another process empties the updated file.
                Some(match text("updated_file")? {
                    "" => FileToolWriteOutcome::Unread,
                    updated => claimed(updated.to_owned()),
                })
            }
        }
    }
}

/// Whether a `NotebookEdit` result says the edit failed: a successful edit carries an empty
/// `error`, a failed one names it.
pub(crate) fn is_failed_notebook_edit(result: &Map<String, Value>) -> bool {
    result
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|error| !error.is_empty())
}

// The members of a file tool's input a call opens on.
#[derive(Deserialize)]
struct ClaudeFileToolInput {
    #[serde(default, deserialize_with = "read_lenient")]
    file_path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    notebook_path: Option<String>,
}

// A call opened on its path, awaiting its result.
struct ClaudeOpenFileToolWrite {
    tool: ClaudeFileTool,
    path: PathBuf,
}

/// The file-tool calls of one session's process, the lead's and its helpers', opened and not yet
/// settled, by `tool_use_id`.
#[derive(Default)]
pub(crate) struct ClaudeFileToolWrites {
    open: HashMap<String, ClaudeOpenFileToolWrite>,
}

impl ClaudeFileToolWrites {
    /// Opens each file-tool call `frame`, an `assistant` frame, starts on `session_id` whose input
    /// names a path, read before the rows move the input off the frame; a call already open is
    /// not opened again.
    pub(crate) fn open_calls(
        &mut self,
        frame: &ClaudeMessageFrame,
        session_id: SessionId,
    ) -> Vec<FileToolWriteOpened> {
        let mut opened = Vec::new();
        for (call_id, tool_name, input) in frame.tool_uses() {
            let Some(tool) = ClaudeFileTool::of(tool_name) else {
                continue;
            };
            if self.open.contains_key(call_id) {
                continue;
            }
            let Some(path) = input.and_then(|input| tool.read_path(input)) else {
                continue;
            };
            self.open.insert(
                call_id.to_owned(),
                ClaudeOpenFileToolWrite {
                    tool,
                    path: path.clone(),
                },
            );
            opened.push(FileToolWriteOpened {
                session_id,
                call_id: call_id.to_owned(),
                path,
            });
        }
        opened
    }

    /// Whether the call `call_id` is open, so its result is read for its write.
    pub(crate) fn is_open(&self, call_id: &str) -> bool {
        self.open.contains_key(call_id)
    }

    /// Settles the open call `call_id` on `session_id` by its result: `NotWritten` for one Claude
    /// Code marked an error, `Unread` for one not alone in its frame, else what `tool_use_result`,
    /// the frame's structured result, says; one whose shape is not read is `Unread`, logged.
    /// `None` for a call not open.
    pub(crate) fn settle_result(
        &mut self,
        session_id: SessionId,
        call_id: &str,
        is_error: bool,
        is_lone_result: bool,
        tool_use_result: Option<&Value>,
    ) -> Option<FileToolWriteSettled> {
        let ClaudeOpenFileToolWrite { tool, path } = self.open.remove(call_id)?;
        let outcome = if is_error {
            FileToolWriteOutcome::NotWritten
        } else if !is_lone_result {
            // Claude Code carries a structured result only beside a lone tool result.
            FileToolWriteOutcome::Unread
        } else {
            tool_use_result
                .and_then(Value::as_object)
                .and_then(|result| tool.read_outcome(result))
                .unwrap_or_else(|| {
                    tracing::warn!(
                        %session_id,
                        tool_use_id = call_id,
                        tool = ?tool,
                        "a Claude Code file tool's result has no shape the driver reads, so its \
                         write is left to the workspace's watch"
                    );
                    FileToolWriteOutcome::Unread
                })
        };
        Some(FileToolWriteSettled {
            session_id,
            call_id: call_id.to_owned(),
            path,
            outcome,
        })
    }

    /// Settles each open call `frame`, a `user` frame of a helper's, answers, as
    /// [`Self::settle_result`] reads it.
    pub(crate) fn settle_results(
        &mut self,
        frame: &ClaudeMessageFrame,
        session_id: SessionId,
    ) -> Vec<FileToolWriteSettled> {
        let results: Vec<(&str, bool)> = frame.tool_results().collect();
        let is_lone_result = results.len() == 1;
        let mut settled = Vec::new();
        for (call_id, is_error) in results {
            if !self.is_open(call_id) {
                continue;
            }
            let tool_use_result = (!is_error)
                .then(|| frame.tool_use_result())
                .flatten()
                .and_then(|result| serde_json::from_str::<Value>(result.get()).ok());
            settled.extend(self.settle_result(
                session_id,
                call_id,
                is_error,
                is_lone_result,
                tool_use_result.as_ref(),
            ));
        }
        settled
    }

    /// Settles every open call on `session_id` `Unread`, as no result will come for it.
    pub(crate) fn settle_all_unread(&mut self, session_id: SessionId) -> Vec<FileToolWriteSettled> {
        self.open
            .drain()
            .map(|(call_id, open)| FileToolWriteSettled {
                session_id,
                call_id,
                path: open.path,
                outcome: FileToolWriteOutcome::Unread,
            })
            .collect()
    }
}

/// Hands each of `opened` to the intake `file_tool_writes`, in order; dropped while it is
/// unregistered, and a call it could not hold logged.
pub(crate) async fn open_file_tool_writes(
    file_tool_writes: &PortRegistration<Arc<dyn FileToolWritePort>>,
    opened: Vec<FileToolWriteOpened>,
) {
    let Some(port) = file_tool_writes.port() else {
        return;
    };
    for opened in opened {
        let (session_id, call_id) = (opened.session_id, opened.call_id.clone());
        if let Err(error) = port.open_file_tool_write(opened).await {
            report_intake_failure(session_id, &call_id, "open", &*error);
        }
    }
}

/// How many settles one session's sender holds before a further hand-off waits for the intake.
const FILE_TOOL_SETTLE_CAPACITY: usize = 64;

/// One session's settled file-tool calls on their way to the chat versions' intake, recorded in
/// the order they were handed on a task of their own, which ends once the sender is dropped with
/// the session's stream.
pub(crate) struct ClaudeFileToolSettles {
    sender: mpsc::Sender<FileToolWriteSettled>,
}

impl ClaudeFileToolSettles {
    /// Starts the task handing each settle to the intake `file_tool_writes`: dropped while it is
    /// unregistered, and a settle it could not record logged.
    pub(crate) fn start(
        file_tool_writes: Arc<PortRegistration<Arc<dyn FileToolWritePort>>>,
    ) -> Self {
        let (sender, mut receiver) =
            mpsc::channel::<FileToolWriteSettled>(FILE_TOOL_SETTLE_CAPACITY);
        tokio::spawn(async move {
            while let Some(settled) = receiver.recv().await {
                let Some(port) = file_tool_writes.port() else {
                    continue;
                };
                let (session_id, call_id) = (settled.session_id, settled.call_id.clone());
                if let Err(error) = port.settle_file_tool_write(settled).await {
                    report_intake_failure(session_id, &call_id, "settle", &*error);
                }
            }
        });
        Self { sender }
    }

    /// Hands each of `settled` to the task, in order; waits only while the task's queue is full.
    pub(crate) async fn hand(&self, settled: Vec<FileToolWriteSettled>) {
        for settled in settled {
            if let Err(error) = self.sender.send(settled).await {
                let settled = &error.0;
                report_intake_failure(settled.session_id, &settled.call_id, "settle", &error);
            }
        }
    }
}

fn report_intake_failure(
    session_id: SessionId,
    call_id: &str,
    step: &'static str,
    error: &(dyn Error + 'static),
) {
    tracing::warn!(
        %session_id,
        tool_use_id = call_id,
        step,
        error,
        "the chat versions could not take a Claude Code file tool's call"
    );
}
