//! Each write a Claude Code agent's own file tool makes, the lead's or a helper's, as the chat
//! versions' intake takes it: a `Write`, `Edit` or `NotebookEdit` call opens at its `tool_use` once
//! it names a path, and settles at its result with the text the result says the file now holds,
//! with no write, or unread. A call still open when its turn ends, an interrupt is answered or the
//! process ends settles unread, so no call holds its path's watch reports for good. An open is
//! handed to the intake on the session's task, ahead of the frames after it; a settle is recorded
//! on a task of the session's own, so no frame waits on a version's disk read or writes, and the
//! call stays open until it is recorded. A claim that would take the queue's held text past its
//! budget is handed on unread, so the intake reads that file from the disk instead.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::mpsc;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::lenient_json::read_lenient;
use crate::port::file_tool_write::{
    FileToolWriteClaim, FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort,
    FileToolWriteSettled,
};
use crate::record_readers::filter_non_empty;

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

    /// The file a call of this tool names, from its input's `file_path` and `notebook_path`: a
    /// notebook's own `notebook_path`, any other tool's `file_path`, only when it has at least one
    /// character.
    pub(crate) fn select_path<'path>(
        self,
        file_path: Option<&'path str>,
        notebook_path: Option<&'path str>,
    ) -> Option<&'path str> {
        filter_non_empty(match self {
            Self::Write | Self::Edit => file_path,
            Self::NotebookEdit => notebook_path,
        })
    }

    // The file the call's raw input names. The input is untrusted provider output; every other
    // member, a written file's text among them, is skipped unread.
    fn read_path(self, input: &RawValue) -> Option<PathBuf> {
        let input = serde_json::from_str::<ClaudeFileToolInput>(input.get()).ok()?;
        self.select_path(input.file_path.as_deref(), input.notebook_path.as_deref())
            .map(PathBuf::from)
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

// A call the session opened, from its `tool_use` until the intake has recorded its settle.
enum ClaudeOpenFileToolWrite {
    // Opened on its path, awaiting its result.
    AwaitingResult { tool: ClaudeFileTool, path: PathBuf },
    // Settled and handed to the intake, which has not yet recorded it.
    Recording,
}

/// The bytes of claimed file text one session's settle queue holds at most, sized for an agent
/// writing files faster than the chat versions' intake records them: the longest output line
/// Claude Code's reader takes, so a claim one frame carries is never refused for its size alone.
pub(crate) const SETTLE_QUEUE_CLAIM_BYTES_BUDGET: usize = CLAUDE_OUTPUT_LINE_MAX_BYTES;

/// The file-tool calls of one session's process by `tool_use_id`, each open until the chat
/// versions' intake has recorded its settle on a task of the session's own, in the order handed.
/// The settles queued hold at most [`SETTLE_QUEUE_CLAIM_BYTES_BUDGET`] of claimed text, or one
/// larger claim alone, and the task ends once this is dropped with the session's stream.
pub(crate) struct ClaudeFileToolWrites {
    open: Arc<Mutex<HashMap<String, ClaudeOpenFileToolWrite>>>,
    // The bytes of claimed text the settles handed and not yet recorded hold.
    held_claim_bytes: Arc<AtomicUsize>,
    settles: mpsc::UnboundedSender<FileToolWriteSettled>,
}

impl ClaudeFileToolWrites {
    /// Starts the task handing each settle to the intake `file_tool_writes`, with no call open:
    /// a settle is dropped while the intake is unregistered, one it could not record is logged,
    /// and the task's early end is logged with its cause.
    pub(crate) fn start(
        file_tool_writes: Arc<PortRegistration<Arc<dyn FileToolWritePort>>>,
    ) -> Self {
        let open = Arc::new(Mutex::new(HashMap::new()));
        let held_claim_bytes = Arc::new(AtomicUsize::new(0));
        let (settles, mut receiver) = mpsc::unbounded_channel::<FileToolWriteSettled>();
        let (recorded_open, recorded_bytes) = (Arc::clone(&open), Arc::clone(&held_claim_bytes));
        let drain = tokio::spawn(async move {
            while let Some(settled) = receiver.recv().await {
                let call_id = settled.call_id.clone();
                let claim_bytes = claim_text_bytes(&settled.outcome);
                if let Some(port) = file_tool_writes.port() {
                    let session_id = settled.session_id;
                    if let Err(error) = port.settle_file_tool_write(settled).await {
                        report_intake_failure(session_id, &call_id, "settle", &*error);
                    }
                }
                recorded_bytes.fetch_sub(claim_bytes, Ordering::Relaxed);
                lock(&recorded_open).remove(&call_id);
            }
        });
        tokio::spawn(async move {
            if let Err(error) = drain.await {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "the task recording a Claude Code session's file-tool writes ended early, so \
                     the session's later writes are left to the workspace's watch"
                );
            }
        });
        Self {
            open,
            held_claim_bytes,
            settles,
        }
    }

    /// Opens each file-tool call `frame`, an `assistant` frame, starts on `session_id` whose input
    /// names a path, read before the rows move the input off the frame; a call already open is
    /// not opened again.
    pub(crate) fn open_calls(
        &self,
        frame: &ClaudeMessageFrame,
        session_id: SessionId,
    ) -> Vec<FileToolWriteOpened> {
        let mut open = lock(&self.open);
        let mut opened = Vec::new();
        for (call_id, tool_name, input) in frame.tool_uses() {
            let Some(tool) = ClaudeFileTool::of(tool_name) else {
                continue;
            };
            if open.contains_key(call_id) {
                continue;
            }
            let Some(path) = input.and_then(|input| tool.read_path(input)) else {
                continue;
            };
            open.insert(
                call_id.to_owned(),
                ClaudeOpenFileToolWrite::AwaitingResult {
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

    /// Whether the call `call_id` is open and awaiting its result, so its result is read for its
    /// write.
    pub(crate) fn is_open(&self, call_id: &str) -> bool {
        matches!(
            lock(&self.open).get(call_id),
            Some(ClaudeOpenFileToolWrite::AwaitingResult { .. })
        )
    }

    // The call `call_id`'s tool and path, the call now awaiting its record; `None` for a call
    // not awaiting its result.
    fn take_awaiting(&self, call_id: &str) -> Option<(ClaudeFileTool, PathBuf)> {
        let mut open = lock(&self.open);
        let entry = open.get_mut(call_id)?;
        match std::mem::replace(entry, ClaudeOpenFileToolWrite::Recording) {
            ClaudeOpenFileToolWrite::AwaitingResult { tool, path } => Some((tool, path)),
            ClaudeOpenFileToolWrite::Recording => None,
        }
    }

    /// Settles the open call `call_id` on `session_id` by its result and hands it to the intake's
    /// task: `NotWritten` for one Claude Code marked an error, `Unread` for one not alone in its
    /// frame, else what `tool_use_result`, the frame's structured result, says; one whose shape is
    /// not read is `Unread`, logged. A call not open settles nothing.
    pub(crate) fn settle_result(
        &self,
        session_id: SessionId,
        call_id: &str,
        is_error: bool,
        is_lone_result: bool,
        tool_use_result: Option<&Value>,
    ) {
        let Some((tool, path)) = self.take_awaiting(call_id) else {
            return;
        };
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
        self.hand(FileToolWriteSettled {
            session_id,
            call_id: call_id.to_owned(),
            path,
            outcome,
        });
    }

    /// Settles each open call `frame`, a `user` frame of a helper's, answers, as
    /// [`Self::settle_result`] reads it.
    pub(crate) fn settle_results(&self, frame: &ClaudeMessageFrame, session_id: SessionId) {
        let results: Vec<(&str, bool)> = frame.tool_results().collect();
        let is_lone_result = results.len() == 1;
        for (call_id, is_error) in results {
            if !self.is_open(call_id) {
                continue;
            }
            let tool_use_result = (!is_error)
                .then(|| frame.tool_use_result())
                .flatten()
                .and_then(|result| serde_json::from_str::<Value>(result.get()).ok());
            self.settle_result(
                session_id,
                call_id,
                is_error,
                is_lone_result,
                tool_use_result.as_ref(),
            );
        }
    }

    /// Settles every call on `session_id` still awaiting its result `Unread`, as no result will
    /// come for it.
    pub(crate) fn settle_all_unread(&self, session_id: SessionId) {
        let awaiting: Vec<(String, PathBuf)> = {
            let mut open = lock(&self.open);
            open.iter_mut()
                .filter_map(|(call_id, entry)| {
                    match std::mem::replace(entry, ClaudeOpenFileToolWrite::Recording) {
                        ClaudeOpenFileToolWrite::AwaitingResult { path, .. } => {
                            Some((call_id.clone(), path))
                        }
                        ClaudeOpenFileToolWrite::Recording => None,
                    }
                })
                .collect()
        };
        for (call_id, path) in awaiting {
            self.hand(FileToolWriteSettled {
                session_id,
                call_id,
                path,
                outcome: FileToolWriteOutcome::Unread,
            });
        }
    }

    // Hands `settled` to the intake's task, which never makes the frame wait. A claim that would
    // take the held text past the budget goes unread, holding no text, so the intake reads the
    // disk; a hand-off the ended task cannot take gives back its call and its bytes.
    fn hand(&self, mut settled: FileToolWriteSettled) {
        let claim_bytes = claim_text_bytes(&settled.outcome);
        if claim_bytes > 0 && !self.hold_claim_bytes(claim_bytes) {
            tracing::debug!(
                session_id = %settled.session_id,
                tool_use_id = settled.call_id.as_str(),
                claim_bytes,
                "a Claude Code file tool's claimed text would pass the settle queue's budget, so \
                 the intake reads its file from the disk"
            );
            settled.outcome = FileToolWriteOutcome::Unread;
        }
        if let Err(error) = self.settles.send(settled) {
            let settled = &error.0;
            self.held_claim_bytes
                .fetch_sub(claim_text_bytes(&settled.outcome), Ordering::Relaxed);
            lock(&self.open).remove(&settled.call_id);
            report_intake_failure(settled.session_id, &settled.call_id, "settle", &error);
        }
    }

    // Counts `claim_bytes` more as held, when they fit the budget or nothing is held yet.
    fn hold_claim_bytes(&self, claim_bytes: usize) -> bool {
        self.held_claim_bytes
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |held| {
                held.checked_add(claim_bytes)
                    .filter(|&total| held == 0 || total <= SETTLE_QUEUE_CLAIM_BYTES_BUDGET)
            })
            .is_ok()
    }

    /// How many calls are open: awaiting their result, or settled and not yet recorded.
    #[cfg(test)]
    pub(crate) fn open_count(&self) -> usize {
        lock(&self.open).len()
    }

    /// The bytes of claimed text the settles handed and not yet recorded hold.
    #[cfg(test)]
    pub(crate) fn held_claim_bytes(&self) -> usize {
        self.held_claim_bytes.load(Ordering::Relaxed)
    }
}

// The bytes of file text `outcome` holds.
fn claim_text_bytes(outcome: &FileToolWriteOutcome) -> usize {
    match outcome {
        FileToolWriteOutcome::Claimed(FileToolWriteClaim::Text(text)) => text.len(),
        FileToolWriteOutcome::Claimed(FileToolWriteClaim::Patch { unified_diff, .. }) => {
            unified_diff.len()
        }
        FileToolWriteOutcome::NotWritten | FileToolWriteOutcome::Unread => 0,
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
