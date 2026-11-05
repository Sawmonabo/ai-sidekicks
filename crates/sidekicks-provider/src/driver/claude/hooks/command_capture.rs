//! The capture windows of Claude Code's commands that run with no wrapper, opened at the pre-tool
//! hook and closed at the call's end: its post-tool hook, else its tool result, its background
//! task's end or its refusal, else the backstop at its caller's or its process's end.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::error::Error;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::spawn::settings::CLAUDE_SHELL_TOOL_NAME;
use crate::port::command_capture::{
    CommandCapture, CommandWindowEnd, CommandWindowId, CommandWindowOpenError, CommandWindowStart,
};
use crate::process_identity::ProviderProcessIdentity;
use crate::record_readers::filter_non_empty;

/// The tool that runs a PowerShell command.
pub(crate) const CLAUDE_POWERSHELL_TOOL_NAME: &str = "PowerShell";

/// The tool that runs its `command` as a background watch, or opens a WebSocket with none.
pub(crate) const CLAUDE_MONITOR_TOOL_NAME: &str = "Monitor";

// The tools whose commands run with no wrapper here: the shell tool only where the wrapper does not
// run.
const CLAUDE_UNWRAPPED_COMMAND_TOOLS: &[&str] = if RUNS_COMMAND_WRAPPER {
    &[CLAUDE_POWERSHELL_TOOL_NAME, CLAUDE_MONITOR_TOOL_NAME]
} else {
    &[
        CLAUDE_SHELL_TOOL_NAME,
        CLAUDE_POWERSHELL_TOOL_NAME,
        CLAUDE_MONITOR_TOOL_NAME,
    ]
};

// Whether a call of `tool_name` runs its command with no wrapper here.
fn runs_with_no_wrapper(tool_name: &str) -> bool {
    CLAUDE_UNWRAPPED_COMMAND_TOOLS.contains(&tool_name)
}

/// The post-tool hooks' matcher: every tool whose command runs with no wrapper here.
pub(crate) fn compose_command_capture_matcher() -> String {
    format!("^({})$", CLAUDE_UNWRAPPED_COMMAND_TOOLS.join("|"))
}

/// A command a pre-tool hook's call runs with no wrapper, whose window opens before the hook is
/// answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeCommandTarget {
    /// The call's tool-use id, which its post-tool hooks name.
    pub(crate) tool_use_id: String,
    /// The command line the call runs.
    pub(crate) command: String,
    /// The calling helper's id, `None` on the lead.
    pub(crate) agent_id: Option<String>,
}

/// The command a pre-tool hook's call of `tool_name` runs with no wrapper, by the call
/// `tool_use_id` of the helper `agent_id` or the lead: `None` for a tool with a wrapper, a call
/// with no `command` (a `Monitor` watching a WebSocket runs nothing), and a call with no tool-use
/// id, which is logged, since its command runs with no window.
pub(crate) fn read_claude_command_target(
    session_id: &SessionId,
    tool_name: &str,
    command: Option<&str>,
    tool_use_id: Option<&str>,
    agent_id: Option<&str>,
) -> Option<ClaudeCommandTarget> {
    if !runs_with_no_wrapper(tool_name) {
        return None;
    }
    let command = filter_non_empty(command)?;
    let Some(tool_use_id) = tool_use_id else {
        tracing::warn!(
            %session_id,
            tool_name,
            "a command call names no tool call, so its command runs with no window"
        );
        return None;
    };
    Some(ClaudeCommandTarget {
        tool_use_id: tool_use_id.to_owned(),
        command: command.to_owned(),
        agent_id: agent_id.map(str::to_owned),
    })
}

/// How a command call ended, as its post-tool hook tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeCommandEnd {
    /// The call left its command running in the background, so its window stays open.
    Background,
    /// The call's command ended so.
    Ended(CommandWindowEnd),
}

impl ClaudeCommandEnd {
    /// The end a `PostToolUse` hook tells from its tool response: `Background` where it names a
    /// background task (a shell's `backgroundTaskId`, a `Monitor`'s `taskId`), otherwise an exit
    /// of zero, since a non-zero exit reaches the failure hook.
    pub(crate) fn read_after_tool(background_task_id: Option<&str>, task_id: Option<&str>) -> Self {
        if filter_non_empty(background_task_id).is_some() || filter_non_empty(task_id).is_some() {
            return Self::Background;
        }
        Self::Ended(CommandWindowEnd::Exited {
            exit_code: Some(0),
            signal: None,
        })
    }

    /// The end a `PostToolUseFailure` hook tells from its `error`: the exit code its `Exit code N`
    /// first line names, otherwise `Untold`, since a bare message leaves unknown whether anything
    /// ran.
    pub(crate) fn read_after_failed_tool(error: Option<&str>) -> Self {
        let exit_code = error
            .and_then(|error| error.lines().next())
            .and_then(|line| line.strip_prefix("Exit code "))
            .and_then(|code| code.trim().parse().ok());
        Self::Ended(match exit_code {
            Some(exit_code) => CommandWindowEnd::Exited {
                exit_code: Some(exit_code),
                signal: None,
            },
            None => CommandWindowEnd::Untold,
        })
    }
}

// One command's window as the hooks follow it, with the process whose hook opened it and the
// helper that called it, `None` on the lead.
#[derive(Debug)]
struct ClaudeCommandWindow {
    process: ProviderProcessIdentity,
    agent_id: Option<String>,
    state: ClaudeCommandWindowState,
}

#[derive(Debug)]
enum ClaudeCommandWindowState {
    // The open is under way; the call's post hook only follows its answer.
    Opening,
    Open {
        window: CommandWindowId,
        has_post_hook: bool,
        is_background: bool,
    },
}

impl ClaudeCommandWindowState {
    // Whether the call still runs in the foreground: still opening, or open short of a post hook
    // that left it in the background.
    fn is_foreground(&self) -> bool {
        match self {
            Self::Opening => true,
            Self::Open { is_background, .. } => !is_background,
        }
    }
}

/// Whose commands a backstop closes, all of one process's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeCommandOwner {
    /// The lead's foreground commands, as its turn ends.
    Lead,
    /// The foreground commands of the helper this `agent_id` names, as it ends.
    Helper(String),
    /// Every command, background ones too, as the process ends.
    Process,
}

impl ClaudeCommandOwner {
    // Whether a backstop for this owner closes `entry`.
    fn owns(&self, entry: &ClaudeCommandWindow) -> bool {
        match self {
            Self::Lead => entry.agent_id.is_none() && entry.state.is_foreground(),
            Self::Helper(agent_id) => {
                entry.agent_id.as_deref() == Some(agent_id.as_str()) && entry.state.is_foreground()
            }
            Self::Process => true,
        }
    }
}

/// A command whose window entry went in as opening before its open is spawned or awaited, so a
/// closer on the session's task always finds it; [`ClaudeCommandWindows::open_then_answer`] opens
/// it.
#[must_use]
pub(crate) struct ClaudeCommandOpening {
    session_id: SessionId,
    target: ClaudeCommandTarget,
}

/// The windows of every session's commands that run with no wrapper, each by its session and
/// tool-use id from its open to its close.
pub(crate) struct ClaudeCommandWindows {
    capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    windows: Mutex<HashMap<(SessionId, String), ClaudeCommandWindow>>,
}

impl ClaudeCommandWindows {
    /// The windows, opened through `capture` once it is registered.
    pub(crate) fn new(capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>) -> Self {
        Self {
            capture,
            windows: Mutex::default(),
        }
    }

    /// Puts `target`'s window in as opening, kept as the window of `process`, whose hook opens
    /// it; called on the hook's own path, before the open.
    pub(crate) fn begin_open(
        &self,
        session_id: SessionId,
        process: ProviderProcessIdentity,
        target: ClaudeCommandTarget,
    ) -> ClaudeCommandOpening {
        lock(&self.windows).insert(
            (session_id, target.tool_use_id.clone()),
            ClaudeCommandWindow {
                process,
                agent_id: target.agent_id.clone(),
                state: ClaudeCommandWindowState::Opening,
            },
        );
        ClaudeCommandOpening { session_id, target }
    }

    /// Opens `opening`'s window, tells it its command began covered, then answers the hook
    /// `request_id` through `channel` with no decision, so the command runs only once its window
    /// is open. An open that fails, or no capture registered, answers with no window; an answer
    /// that cannot be written stops the process, as every answer's.
    pub(crate) async fn open_then_answer(
        &self,
        opening: ClaudeCommandOpening,
        channel: &dyn ClaudeProcessChannel,
        provider_account_id: &ProviderAccountId,
        request_id: String,
    ) {
        let session_id = opening.session_id;
        self.open(opening).await;
        answer_claude_request(
            channel,
            &session_id,
            provider_account_id,
            request_id,
            &ClaudeHookAnswer::Pass,
        )
        .await;
    }

    // The open: told covered before the entry turns open, since once the hook is answered a close
    // can come, and a close ahead of `command_began` records the window uncovered. An entry
    // removed meanwhile closes its window untold.
    async fn open(&self, opening: ClaudeCommandOpening) {
        let ClaudeCommandOpening { session_id, target } = opening;
        let key = (session_id, target.tool_use_id);
        let Some(capture) = self.capture.port().cloned() else {
            lock(&self.windows).remove(&key);
            return;
        };
        let start = CommandWindowStart {
            session_id,
            apart_run: None,
            command: target.command,
            tool_call_id: ToolCallId::new(key.1.clone()).ok(),
        };
        let window = match capture.open_window(start).await {
            Ok(window) => window,
            Err(error) => {
                lock(&self.windows).remove(&key);
                let tool_use_id = key.1.as_str();
                match &error {
                    CommandWindowOpenError::Refused(_) => tracing::debug!(
                        %session_id,
                        tool_use_id,
                        error = &error as &(dyn Error + 'static),
                        "a command's window was refused, so it runs with no window"
                    ),
                    CommandWindowOpenError::CaptureFailed(_) => tracing::warn!(
                        %session_id,
                        tool_use_id,
                        error = &error as &(dyn Error + 'static),
                        "a command's window failed to open, so it runs with no window"
                    ),
                }
                return;
            }
        };
        capture.command_began(&window, true).await;
        let removed = match lock(&self.windows).get_mut(&key) {
            Some(entry) => {
                entry.state = ClaudeCommandWindowState::Open {
                    window,
                    has_post_hook: false,
                    is_background: false,
                };
                None
            }
            None => Some(window),
        };
        if let Some(window) = removed {
            self.close(window, CommandWindowEnd::Untold);
        }
    }

    /// Takes the post-tool hook of the call `tool_use_id`, which ended as `end`: an open window is
    /// marked as past its post hook; a background call's stays open and answers `None`, and any
    /// other is removed and answers its window and end, for [`Self::close`]. A call with no window,
    /// or one still opening, answers `None`.
    pub(crate) fn take_post_hook(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
        end: ClaudeCommandEnd,
    ) -> Option<(CommandWindowId, CommandWindowEnd)> {
        let mut windows = lock(&self.windows);
        let Entry::Occupied(mut entry) = windows.entry((session_id, tool_use_id.to_owned())) else {
            return None;
        };
        let ClaudeCommandWindowState::Open {
            window,
            has_post_hook,
            is_background,
        } = &mut entry.get_mut().state
        else {
            return None;
        };
        *has_post_hook = true;
        match end {
            ClaudeCommandEnd::Background => {
                *is_background = true;
                None
            }
            ClaudeCommandEnd::Ended(end) => {
                let window = window.clone();
                entry.remove();
                Some((window, end))
            }
        }
    }

    /// Takes the tool result of the call `tool_use_id`: a window no post hook reached closes
    /// `Untold`, whether the result is an error or not, since an interrupted call's result comes so
    /// too; a background call's, past its post hook, stays open for its task's end. Answers the
    /// window and end for [`Self::close`]; an entry still opening is removed, and its open closes
    /// it.
    pub(crate) fn take_tool_result(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<(CommandWindowId, CommandWindowEnd)> {
        self.take_one(
            session_id,
            tool_use_id,
            CommandWindowEnd::Untold,
            |has_post_hook, _| !has_post_hook,
        )
    }

    /// Takes the end of the task the call `tool_use_id` started: a background call's window
    /// closes `Untold`; a foreground call's stays for its post hook, which tells its exit code.
    /// Answers as [`Self::take_tool_result`] does.
    pub(crate) fn take_task_end(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<(CommandWindowId, CommandWindowEnd)> {
        self.take_one(
            session_id,
            tool_use_id,
            CommandWindowEnd::Untold,
            |_, is_background| is_background,
        )
    }

    /// Takes the refusal of the call `tool_use_id` before it ran: its window closes `Unrun`, with
    /// no after-capture. Answers as [`Self::take_tool_result`] does.
    pub(crate) fn take_unrun(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<(CommandWindowId, CommandWindowEnd)> {
        self.take_one(session_id, tool_use_id, CommandWindowEnd::Unrun, |_, _| {
            true
        })
    }

    /// The backstop for what no closer read: removes the windows of the session's process
    /// `process` that `owner` names, and answers each open one's window, closing `Untold`, for
    /// [`Self::close`]; an entry still opening is removed, and its open closes it.
    pub(crate) fn take_remaining(
        &self,
        session_id: SessionId,
        process: ProviderProcessIdentity,
        owner: &ClaudeCommandOwner,
    ) -> Vec<(CommandWindowId, CommandWindowEnd)> {
        lock(&self.windows)
            .extract_if(|(entry_session_id, _), entry| {
                *entry_session_id == session_id && entry.process == process && owner.owns(entry)
            })
            .filter_map(|(_, entry)| match entry.state {
                ClaudeCommandWindowState::Opening => None,
                ClaudeCommandWindowState::Open { window, .. } => {
                    Some((window, CommandWindowEnd::Untold))
                }
            })
            .collect()
    }

    // Removes the call `tool_use_id`'s entry where it is still opening, or open and `closes` it
    // by its post-hook and background marks, answering an open one's window with `end`.
    fn take_one(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
        end: CommandWindowEnd,
        closes: impl FnOnce(bool, bool) -> bool,
    ) -> Option<(CommandWindowId, CommandWindowEnd)> {
        let mut windows = lock(&self.windows);
        let Entry::Occupied(entry) = windows.entry((session_id, tool_use_id.to_owned())) else {
            return None;
        };
        if let ClaudeCommandWindowState::Open {
            has_post_hook,
            is_background,
            ..
        } = entry.get().state
            && !closes(has_post_hook, is_background)
        {
            return None;
        }
        match entry.remove().state {
            ClaudeCommandWindowState::Opening => None,
            ClaudeCommandWindowState::Open { window, .. } => Some((window, end)),
        }
    }

    /// Closes `window` as `end` says, off the caller's path, so no caller waits on its
    /// after-capture.
    pub(crate) fn close(&self, window: CommandWindowId, end: CommandWindowEnd) {
        let Some(capture) = self.capture.port().cloned() else {
            return;
        };
        tokio::spawn(async move { capture.close_window(window, end).await });
    }
}

#[cfg(test)]
pub(crate) mod tests;
