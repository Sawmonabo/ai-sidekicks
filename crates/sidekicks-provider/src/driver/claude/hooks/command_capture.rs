//! The capture windows of Claude Code's commands that run with no wrapper, opened at the pre-tool
//! hook and closed at the call's end.

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

// One command's window as the hooks follow it.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the closers at a call's result, its background task's end, its denial and the \
                  run's end read the helper, the post hook and the background mark"
    )
)]
enum ClaudeCommandWindow {
    // The open is under way; the call's post hook only follows its answer.
    Opening,
    Open {
        window: CommandWindowId,
        agent_id: Option<String>,
        has_post_hook: bool,
        is_background: bool,
    },
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

    /// Puts `target`'s window in as opening; called on the hook's own path, before the open.
    pub(crate) fn begin_open(
        &self,
        session_id: SessionId,
        target: ClaudeCommandTarget,
    ) -> ClaudeCommandOpening {
        lock(&self.windows).insert(
            (session_id, target.tool_use_id.clone()),
            ClaudeCommandWindow::Opening,
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
                *entry = ClaudeCommandWindow::Open {
                    window,
                    agent_id: target.agent_id,
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
        let ClaudeCommandWindow::Open {
            window,
            has_post_hook,
            is_background,
            ..
        } = entry.get_mut()
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
pub(crate) mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_std::mutex_lock::lock;
    use tokio::sync::{mpsc, watch};

    use super::{
        ClaudeCommandEnd, ClaudeCommandTarget, ClaudeCommandWindow, ClaudeCommandWindows,
        ClaudeHookAnswer,
    };
    use crate::driver::claude::hooks::edit_checkpoint::tests::is_answered;
    use crate::driver::claude::session::scripted::channel::ScriptedChannel;
    use crate::driver::test_registry::fixed_session_id;
    use crate::port::command_capture::{
        CaptureCall, CommandWindowStart, held_capture, held_capture_with_starts, next_call,
        no_call, unregistered_capture,
    };

    // The account every test answers as.
    fn account() -> ProviderAccountId {
        ProviderAccountId::new("account-1".to_owned()).expect("an account id")
    }

    // A `PowerShell` call `tool_use_id` by the lead.
    fn powershell_target(tool_use_id: &str) -> ClaudeCommandTarget {
        ClaudeCommandTarget {
            tool_use_id: tool_use_id.to_owned(),
            command: "Get-ChildItem".to_owned(),
            agent_id: None,
        }
    }

    /// Opens the window of the lead's `PowerShell` call `tool_use_id` in the fixed session through
    /// `windows`, whose capture already lets opens through, taking its open and its covered start
    /// from `called`.
    pub(crate) async fn open_one_window(
        windows: &ClaudeCommandWindows,
        called: &mut mpsc::UnboundedReceiver<CaptureCall>,
        tool_use_id: &str,
    ) {
        let opening = windows.begin_open(fixed_session_id(), powershell_target(tool_use_id));
        let channel = ScriptedChannel::default();
        windows
            .open_then_answer(opening, &channel, &account(), "r-open".to_owned())
            .await;
        assert!(matches!(next_call(called).await, CaptureCall::Open(_)));
        assert!(matches!(
            next_call(called).await,
            CaptureCall::Began(_, true)
        ));
    }

    // Killed by the answer written before the open, by `command_began` never told, and by the
    // command or the tool call altered on the way.
    #[tokio::test]
    async fn a_command_is_answered_only_after_its_window_opens() {
        let (opens, held) = watch::channel(None);
        let (capture, mut called, starts) = held_capture_with_starts(held);
        let windows = Arc::new(ClaudeCommandWindows::new(capture));
        let channel = Arc::new(ScriptedChannel::default());
        let opening = windows.begin_open(fixed_session_id(), powershell_target("toolu_1"));
        let answering = tokio::spawn({
            let windows = Arc::clone(&windows);
            let channel = Arc::clone(&channel);
            async move {
                windows
                    .open_then_answer(opening, &*channel, &account(), "r1".to_owned())
                    .await;
            }
        });

        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        assert_eq!(
            *lock(&starts),
            [CommandWindowStart {
                session_id: fixed_session_id(),
                apart_run: None,
                command: "Get-ChildItem".to_owned(),
                tool_call_id: Some(ToolCallId::new("toolu_1".to_owned()).expect("a call id")),
            }]
        );
        no_call(&mut called, "a start told while the open is held").await;
        assert!(!is_answered(&channel, "r1"));

        opens.send(Some(true)).expect("the open waits on the test");
        assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
        answering.await.expect("the answer's task ends");
        assert_eq!(channel.answer_to("r1").await, json!({}));
    }

    // Killed by a background window closed at its post hook, and by a `Monitor`'s `taskId` left
    // unread.
    #[rstest]
    #[case::shell_in_the_background(Some("bash_1"), None)]
    #[case::monitor(None, Some("task_1"))]
    #[tokio::test]
    async fn a_background_call_stays_open_past_its_post_hook(
        #[case] background_task_id: Option<&str>,
        #[case] task_id: Option<&str>,
    ) {
        let (_opens, held) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(held);
        let windows = ClaudeCommandWindows::new(capture);
        open_one_window(&windows, &mut called, "toolu_1").await;

        let end = ClaudeCommandEnd::read_after_tool(background_task_id, task_id);
        assert_eq!(end, ClaudeCommandEnd::Background);
        assert_eq!(
            windows.take_post_hook(fixed_session_id(), "toolu_1", end),
            None
        );

        no_call(&mut called, "a background window closed").await;
        let kept = lock(&windows.windows);
        assert!(
            matches!(
                kept.get(&(fixed_session_id(), "toolu_1".to_owned())),
                Some(ClaudeCommandWindow::Open {
                    agent_id: None,
                    has_post_hook: true,
                    is_background: true,
                    ..
                })
            ),
            "kept {kept:?}"
        );
    }

    /// How a case's open fails.
    #[derive(Clone, Copy, Debug)]
    enum FailedOpen {
        Failed,
        Unregistered,
    }

    // Killed by a hook left unanswered on a failed capture, and by an entry kept with no window.
    #[rstest]
    #[case::failed(FailedOpen::Failed)]
    #[case::unregistered(FailedOpen::Unregistered)]
    #[tokio::test]
    async fn an_open_that_fails_answers_the_hook_with_no_window(#[case] failed: FailedOpen) {
        let (_opens, held) = watch::channel(Some(false));
        let (capture, called) = match failed {
            FailedOpen::Failed => {
                let (capture, called) = held_capture(held);
                (capture, Some(called))
            }
            FailedOpen::Unregistered => (unregistered_capture(), None),
        };
        let windows = ClaudeCommandWindows::new(capture);
        let channel = ScriptedChannel::default();

        let opening = windows.begin_open(fixed_session_id(), powershell_target("toolu_1"));
        windows
            .open_then_answer(opening, &channel, &account(), "r1".to_owned())
            .await;

        assert_eq!(
            channel.answer_to("r1").await,
            serde_json::to_value(ClaudeHookAnswer::Pass).expect("an answer serializes")
        );
        if let Some(mut called) = called {
            assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
            no_call(&mut called, "a start told with no window").await;
        }
        assert!(lock(&windows.windows).is_empty());
    }
}
