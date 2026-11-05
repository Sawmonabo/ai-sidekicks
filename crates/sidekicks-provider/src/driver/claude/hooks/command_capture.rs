//! The capture windows of Claude Code's commands that run with no wrapper, opened at the pre-tool
//! hook and closed at the call's end: its post-tool hook, else its tool result, its background
//! task's end or its refusal, else the backstop at its caller's or its process's end. A shell call
//! the wrapper runs is noted at its pre-tool hook instead; a wrapper's start pairs with the
//! session's oldest note of its line, and a note still unpaired at its call's end is recorded as
//! run uncovered. A call the daemon's own hook refused takes no note or window: a refusal ahead
//! of its pre-tool hook leaves a mark the hook takes.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::command::channel::records::NotedWrapperCalls;
use crate::driver::claude::command_shape::bash_line_text;
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

/// A command a pre-tool hook's call runs, followed by its tool-use id from the hook on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeCommandTarget {
    /// The call's tool-use id, which its post-tool hooks name.
    pub(crate) tool_use_id: String,
    /// The command line the call runs.
    pub(crate) command: String,
    /// The calling helper's id, `None` on the lead.
    pub(crate) agent_id: Option<String>,
    /// Where the command's window opens.
    pub(crate) leg: ClaudeCommandLeg,
}

/// Where a command call's window opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeCommandLeg {
    /// At the pre-tool hook, before it is answered: a command that runs with no wrapper.
    Hook,
    /// At its wrapper's start: a shell call the wrapper runs, noted at the hook until a wrapper's
    /// start pairs with it.
    Wrapper {
        /// Whether the call runs its command in the background.
        is_background: bool,
    },
}

/// The command a pre-tool hook's call of `tool_name` runs, by the call `tool_use_id` of the helper
/// `agent_id` or the lead, in the background where `run_in_background` says so: a `Wrapper` target
/// for a shell call where the wrapper runs, a `Hook` target for a tool whose command runs with no
/// wrapper here. `None` for any other tool, a call with no `command` (a `Monitor` watching a
/// WebSocket runs nothing), and a call with no tool-use id, which is logged, since no hook can
/// follow its command.
pub(crate) fn read_claude_command_target(
    session_id: &SessionId,
    tool_name: &str,
    command: Option<&str>,
    tool_use_id: Option<&str>,
    agent_id: Option<&str>,
    run_in_background: Option<bool>,
) -> Option<ClaudeCommandTarget> {
    let leg = if runs_with_no_wrapper(tool_name) {
        ClaudeCommandLeg::Hook
    } else if RUNS_COMMAND_WRAPPER && tool_name == CLAUDE_SHELL_TOOL_NAME {
        ClaudeCommandLeg::Wrapper {
            is_background: run_in_background == Some(true),
        }
    } else {
        return None;
    };
    let command = filter_non_empty(command)?;
    let Some(tool_use_id) = tool_use_id else {
        tracing::warn!(
            %session_id,
            tool_name,
            "a command call names no tool call, so no hook can follow its command"
        );
        return None;
    };
    Some(ClaudeCommandTarget {
        tool_use_id: tool_use_id.to_owned(),
        command: command.to_owned(),
        agent_id: agent_id.map(str::to_owned),
        leg,
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
    // A shell call the wrapper runs, until a wrapper's start of `line`, the text the wrapper names
    // for `command`, pairs with it; `order` tells the session's notes of one line apart by age.
    Noted {
        line: String,
        command: String,
        is_background: bool,
        order: u64,
    },
    // A call the daemon's own hook refused before its pre-tool hook came.
    Refused,
}

impl ClaudeCommandWindowState {
    // Whether the call still runs in the foreground: still opening, refused, noted in the
    // foreground, or open short of a post hook that left it in the background.
    fn is_foreground(&self) -> bool {
        match self {
            Self::Opening | Self::Refused => true,
            Self::Open { is_background, .. } | Self::Noted { is_background, .. } => !is_background,
        }
    }

    // What closes for this state's entry, removed from the session's call `tool_use_id` as `end`
    // says: an open window closes, and a noted call that ran is recorded as run uncovered.
    fn into_closing(
        self,
        session_id: SessionId,
        tool_use_id: String,
        end: CommandWindowEnd,
    ) -> Option<ClaudeCommandClosing> {
        match self {
            Self::Opening | Self::Refused => None,
            Self::Open { window, .. } => Some(ClaudeCommandClosing::Window(window, end)),
            // A call that never ran has nothing to name.
            Self::Noted { .. } if end == CommandWindowEnd::Unrun => None,
            Self::Noted { command, .. } => {
                Some(ClaudeCommandClosing::Uncovered(CommandWindowStart {
                    session_id,
                    apart_run: None,
                    command,
                    tool_call_id: ToolCallId::new(tool_use_id).ok(),
                }))
            }
        }
    }
}

/// What a closer answers for [`ClaudeCommandWindows::close`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClaudeCommandClosing {
    /// An open window, closed as its end says.
    Window(CommandWindowId, CommandWindowEnd),
    /// A shell call no wrapper paired, recorded as run uncovered.
    Uncovered(CommandWindowStart),
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

/// A command whose entry went in, as an opening window or a note, before its open is spawned or
/// awaited, so a closer on the session's task always finds it;
/// [`ClaudeCommandWindows::open_then_answer`] opens it.
#[must_use]
pub(crate) struct ClaudeCommandOpening {
    session_id: SessionId,
    // The target whose window opens; `None` for a noted or a refused call, which opens none.
    target: Option<ClaudeCommandTarget>,
}

/// The windows of every session's commands that run with no wrapper, each by its session and
/// tool-use id from its open to its close, with the notes of the shell calls the wrapper runs.
pub(crate) struct ClaudeCommandWindows {
    capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    windows: Mutex<HashMap<(SessionId, String), ClaudeCommandWindow>>,
    // The next note's order, taken under the windows' lock.
    next_note: AtomicU64,
}

impl ClaudeCommandWindows {
    /// The windows, opened through `capture` once it is registered.
    pub(crate) fn new(capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>) -> Self {
        Self {
            capture,
            windows: Mutex::default(),
            next_note: AtomicU64::new(0),
        }
    }

    /// Puts `target`'s entry in, kept as the call of `process`, whose hook took it: a window as
    /// opening on the hook's leg, a note on the wrapper's; a call already marked refused takes
    /// neither and its mark is removed. Called on the hook's own path, before the open.
    pub(crate) fn begin_open(
        &self,
        session_id: SessionId,
        process: ProviderProcessIdentity,
        target: ClaudeCommandTarget,
    ) -> ClaudeCommandOpening {
        let mut windows = lock(&self.windows);
        let key = (session_id, target.tool_use_id.clone());
        if let Entry::Occupied(entry) = windows.entry(key.clone())
            && matches!(entry.get().state, ClaudeCommandWindowState::Refused)
        {
            entry.remove();
            return ClaudeCommandOpening {
                session_id,
                target: None,
            };
        }
        let (state, opens) = match target.leg {
            ClaudeCommandLeg::Hook => (ClaudeCommandWindowState::Opening, true),
            ClaudeCommandLeg::Wrapper { is_background } => (
                ClaudeCommandWindowState::Noted {
                    line: bash_line_text(&target.command),
                    command: target.command.clone(),
                    is_background,
                    order: self.next_note.fetch_add(1, Ordering::Relaxed),
                },
                false,
            ),
        };
        windows.insert(
            key,
            ClaudeCommandWindow {
                process,
                agent_id: target.agent_id.clone(),
                state,
            },
        );
        ClaudeCommandOpening {
            session_id,
            target: opens.then_some(target),
        }
    }

    /// Opens `opening`'s window, tells it its command began covered, then answers the hook
    /// `request_id` through `channel` with no decision, so the command runs only once its window
    /// is open; a noted or a refused call is answered at once. An open that fails, or no capture
    /// registered, answers with no window; an answer that cannot be written stops the process, as
    /// every answer's.
    pub(crate) async fn open_then_answer(
        &self,
        opening: ClaudeCommandOpening,
        channel: &dyn ClaudeProcessChannel,
        provider_account_id: &ProviderAccountId,
        request_id: String,
    ) {
        let ClaudeCommandOpening { session_id, target } = opening;
        if let Some(target) = target {
            self.open(session_id, target).await;
        }
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
    async fn open(&self, session_id: SessionId, target: ClaudeCommandTarget) {
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
            self.close(ClaudeCommandClosing::Window(
                window,
                CommandWindowEnd::Untold,
            ));
        }
    }

    /// Takes the post-tool hook of the call `tool_use_id`, which ended as `end`: an open window is
    /// marked as past its post hook; a background call's stays open and answers `None`, and any
    /// other is removed and answers its window and end, for [`Self::close`]. A call with no window,
    /// one still opening, a note or a refusal mark answers `None`.
    pub(crate) fn take_post_hook(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
        end: ClaudeCommandEnd,
    ) -> Option<ClaudeCommandClosing> {
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
                Some(ClaudeCommandClosing::Window(window, end))
            }
        }
    }

    /// Takes the tool result of the call `tool_use_id`: a window no post hook reached closes
    /// `Untold`, whether the result is an error or not, since an interrupted call's result comes so
    /// too; a background call's, past its post hook, stays open for its task's end. A foreground
    /// note no wrapper paired is recorded as run uncovered, and a background one stays for its
    /// task's end; a refusal mark is removed. Answers what closes for [`Self::close`]; an entry
    /// still opening is removed, and its open closes it.
    pub(crate) fn take_tool_result(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<ClaudeCommandClosing> {
        self.take_one(
            session_id,
            tool_use_id,
            CommandWindowEnd::Untold,
            |state| match state {
                ClaudeCommandWindowState::Open { has_post_hook, .. } => !has_post_hook,
                ClaudeCommandWindowState::Noted { is_background, .. } => !is_background,
                ClaudeCommandWindowState::Opening | ClaudeCommandWindowState::Refused => true,
            },
        )
    }

    /// Takes the end of the task the call `tool_use_id` started: a background call's window
    /// closes `Untold` and its note no wrapper paired is recorded as run uncovered; a foreground
    /// call's window stays for its post hook, which tells its exit code, and its note for its tool
    /// result. Answers as [`Self::take_tool_result`] does.
    pub(crate) fn take_task_end(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<ClaudeCommandClosing> {
        self.take_one(
            session_id,
            tool_use_id,
            CommandWindowEnd::Untold,
            |state| match state {
                ClaudeCommandWindowState::Open { is_background, .. }
                | ClaudeCommandWindowState::Noted { is_background, .. } => *is_background,
                ClaudeCommandWindowState::Opening => true,
                ClaudeCommandWindowState::Refused => false,
            },
        )
    }

    /// Takes the refusal of the call `tool_use_id` before it ran: its window closes `Unrun`, with
    /// no after-capture, and its note or refusal mark is removed, recording nothing. Answers as
    /// [`Self::take_tool_result`] does.
    pub(crate) fn take_unrun(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
    ) -> Option<ClaudeCommandClosing> {
        self.take_one(session_id, tool_use_id, CommandWindowEnd::Unrun, |_| true)
    }

    /// Takes the daemon's own hook's refusal of the call `tool_use_id` by the helper `agent_id` or
    /// the lead on `process`, which no stream frame names: as [`Self::take_unrun`] does where the
    /// call has an entry; otherwise marks the call refused, so its pre-tool hook takes no note or
    /// window, until that hook, its tool result or the backstop for its caller removes the mark.
    pub(crate) fn take_refused(
        &self,
        session_id: SessionId,
        process: ProviderProcessIdentity,
        agent_id: Option<String>,
        tool_use_id: &str,
    ) -> Option<ClaudeCommandClosing> {
        let mut windows = lock(&self.windows);
        match windows.entry((session_id, tool_use_id.to_owned())) {
            Entry::Occupied(entry) => {
                let (key, entry) = entry.remove_entry();
                entry
                    .state
                    .into_closing(session_id, key.1, CommandWindowEnd::Unrun)
            }
            Entry::Vacant(entry) => {
                entry.insert(ClaudeCommandWindow {
                    process,
                    agent_id,
                    state: ClaudeCommandWindowState::Refused,
                });
                None
            }
        }
    }

    /// The backstop for what no closer read: removes the entries of the session's process
    /// `process` that `owner` names, and answers what closes for [`Self::close`]: each open
    /// window, closing `Untold`, and each note no wrapper paired, recorded as run uncovered; an
    /// entry still opening is removed, and its open closes it.
    pub(crate) fn take_remaining(
        &self,
        session_id: SessionId,
        process: ProviderProcessIdentity,
        owner: &ClaudeCommandOwner,
    ) -> Vec<ClaudeCommandClosing> {
        lock(&self.windows)
            .extract_if(|(entry_session_id, _), entry| {
                *entry_session_id == session_id && entry.process == process && owner.owns(entry)
            })
            .filter_map(|((_, tool_use_id), entry)| {
                entry
                    .state
                    .into_closing(session_id, tool_use_id, CommandWindowEnd::Untold)
            })
            .collect()
    }

    // Removes the call `tool_use_id`'s entry where `takes` its state, answering what closes for it
    // as `end` says.
    fn take_one(
        &self,
        session_id: SessionId,
        tool_use_id: &str,
        end: CommandWindowEnd,
        takes: impl FnOnce(&ClaudeCommandWindowState) -> bool,
    ) -> Option<ClaudeCommandClosing> {
        let mut windows = lock(&self.windows);
        let Entry::Occupied(entry) = windows.entry((session_id, tool_use_id.to_owned())) else {
            return None;
        };
        if !takes(&entry.get().state) {
            return None;
        }
        let (key, entry) = entry.remove_entry();
        entry.state.into_closing(session_id, key.1, end)
    }

    /// Carries out `closing` off the caller's path, so no caller waits on a window's
    /// after-capture or a record's write: a window closes as its end says, and an uncovered call
    /// is recorded.
    pub(crate) fn close(&self, closing: ClaudeCommandClosing) {
        let Some(capture) = self.capture.port().cloned() else {
            return;
        };
        tokio::spawn(async move {
            match closing {
                ClaudeCommandClosing::Window(window, end) => {
                    capture.close_window(window, end).await;
                }
                ClaudeCommandClosing::Uncovered(start) => {
                    capture.record_uncovered_command(start).await;
                }
            }
        });
    }
}

impl NotedWrapperCalls for ClaudeCommandWindows {
    fn pair_started_wrapper(&self, session_id: SessionId, line: &str) -> Option<ToolCallId> {
        let mut windows = lock(&self.windows);
        let (_, tool_use_id) = windows
            .iter()
            .filter_map(|((entry_session_id, tool_use_id), entry)| {
                let ClaudeCommandWindowState::Noted {
                    line: noted, order, ..
                } = &entry.state
                else {
                    return None;
                };
                (*entry_session_id == session_id && noted == line).then_some((*order, tool_use_id))
            })
            .min_by_key(|(order, _)| *order)?;
        let key = (session_id, tool_use_id.clone());
        windows.remove(&key);
        ToolCallId::new(key.1).ok()
    }
}

#[cfg(test)]
pub(crate) mod tests;
