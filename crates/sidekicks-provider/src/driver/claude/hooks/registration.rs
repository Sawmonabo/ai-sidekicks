//! The hooks the daemon registers on the wire in each Claude Code process's `initialize`: each one
//! is answered over the same channel as a `hook_callback`, so nothing is written to any settings
//! file and the person's own hooks are untouched.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::driver::claude::event_normalizer::CLAUDE_QUESTION_TOOL_NAME;
use crate::driver::claude::hooks::command_capture::compose_command_capture_matcher;
use crate::driver::claude::session::transport::control::{
    ClaudeAgentDefinition, ClaudeControlRequest, ClaudeHookMatcher, ClaudeHooks,
};
use crate::driver::claude::spawn::settings::CLAUDE_SHELL_TOOL_NAME;
use crate::driver::session_control::{SubagentDefinition, SubagentPolicy};
use crate::mcp::tool_name::TOOL_SERVER_TOOL_PREFIX;
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// How long Claude Code waits on a held callback, in seconds: the largest whole second under
/// Claude Code's own cap of 2,147,483,647 ms, about 24.8 days. Without it a callback left
/// unanswered is canceled after Claude Code's own ten minutes.
const CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS: u64 = 2_147_483;

/// How long a paused helper's call is held before the daemon answers it to be made again: one day
/// short of the timeout, so a clock set back or a late wake still answers it in time.
pub(crate) const CLAUDE_HOOK_HOLD_RENEWAL_AFTER: Duration =
    Duration::from_secs(CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS - 24 * 60 * 60);

/// The helper tool's name on the wire. The process's `system/init` advertises it as `Task`, but a
/// matcher written against that name never fires.
pub(crate) const CLAUDE_HELPER_TOOL_NAME: &str = "Agent";

/// The tool a lead or a helper sends a message to a helper with, which may resume it.
pub(crate) const CLAUDE_MESSAGE_TOOL_NAME: &str = "SendMessage";

/// A hook the daemon registers, by what answers it; its callback id names it on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHookCallback {
    /// Holds a tool call while the run is paused.
    PauseBeforeTool,
    /// Holds the turn after a batch of tool calls while the run is paused.
    PauseAfterBatch,
    /// Holds a new helper's start, and a message's wake of an ended helper, past `Helpers at
    /// once`.
    HelperLimit,
    /// Answers the question tool and lets the daemon's own tools run.
    QuestionBridge,
    /// Records a tool call the provider denied.
    PermissionDenied,
    /// Refuses a shell command that starts background work.
    BackgroundWork,
    /// Hands a helper the person's waiting words after its tool call.
    HelperSteerAfterTool,
    /// Hands a helper the person's waiting words as it finishes, so it goes on.
    HelperSteerAtStop,
    /// Closes the window of a command that ran with no wrapper once its call ends.
    CaptureAfterTool,
    /// Closes the window of a command that ran with no wrapper once its call fails.
    CaptureAfterFailedTool,
    /// Forgets what a helper call asked for once the call fails, so no start will take it.
    HelperCallFailed,
}

impl ClaudeHookCallback {
    /// Every hook, so a callback id is read back against each.
    const ALL: [Self; 11] = [
        Self::PauseBeforeTool,
        Self::PauseAfterBatch,
        Self::HelperLimit,
        Self::QuestionBridge,
        Self::PermissionDenied,
        Self::BackgroundWork,
        Self::HelperSteerAfterTool,
        Self::HelperSteerAtStop,
        Self::CaptureAfterTool,
        Self::CaptureAfterFailedTool,
        Self::HelperCallFailed,
    ];

    /// The callback id the hook is registered under.
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::PauseBeforeTool => "sidekicks-pause-before-tool",
            Self::PauseAfterBatch => "sidekicks-pause-after-batch",
            Self::HelperLimit => "sidekicks-helper-limit",
            Self::QuestionBridge => "sidekicks-question-bridge",
            Self::PermissionDenied => "sidekicks-permission-denied",
            Self::BackgroundWork => "sidekicks-background-claude",
            Self::HelperSteerAfterTool => "sidekicks-helper-steer-after-tool",
            Self::HelperSteerAtStop => "sidekicks-helper-steer-at-stop",
            Self::CaptureAfterTool => "sidekicks-capture-after-tool",
            Self::CaptureAfterFailedTool => "sidekicks-capture-after-failed-tool",
            Self::HelperCallFailed => "sidekicks-helper-call-failed",
        }
    }

    /// The hook a `hook_callback`'s `callback_id` names, or `None` for an id the daemon never
    /// registered.
    pub(crate) fn of(callback_id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|hook| hook.id() == callback_id)
    }
}

/// A dialog the daemon declares it draws, by the choice it asks the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeDialogKind {
    /// Retry a refused reply on a fallback model, or not.
    Refusal,
    /// Spend usage credits past the plan's limit, or not.
    UsageCredits,
}

impl ClaudeDialogKind {
    /// Every dialog the daemon declares.
    pub(crate) const ALL: [Self; 2] = [Self::Refusal, Self::UsageCredits];

    /// The dialog kind as Claude Code's wire names it.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Refusal => "refusal_fallback_prompt",
            Self::UsageCredits => "fable_overage_consent_prompt",
        }
    }
}

/// The `initialize` request a session's process is brought up with: the daemon's hooks (a failed
/// helper call's among them, which forgets what the call asked for), the session's helper
/// definitions, the two dialogs the console draws, and the per-task stop the console offers, and
/// the tool servers the daemon hosts in-process, by name. The helper hold, on the helper and
/// message tools, is registered only where the policy limits helpers at once.
pub(crate) fn compose_claude_initialize_request(
    subagent_policy: Option<&SubagentPolicy>,
    in_process_servers: Vec<String>,
) -> ClaudeControlRequest {
    let held = |matcher: Option<String>, hook: ClaudeHookCallback| ClaudeHookMatcher {
        matcher,
        hook_callback_ids: vec![hook.id()],
        timeout: Some(CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS),
    };
    let unheld = |matcher: Option<String>, hook: ClaudeHookCallback| ClaudeHookMatcher {
        matcher,
        hook_callback_ids: vec![hook.id()],
        timeout: None,
    };
    // The question tool and every daemon tool, which at Sandboxed run only through this hook.
    let question_bridge_matcher = format!(
        "^({CLAUDE_QUESTION_TOOL_NAME}|{TOOL_SERVER_TOOL_PREFIX}{DAEMON_TOOL_SERVER_NAME}__.*)$"
    );
    let mut pre_tool_use = vec![
        held(None, ClaudeHookCallback::PauseBeforeTool),
        held(
            Some(question_bridge_matcher),
            ClaudeHookCallback::QuestionBridge,
        ),
        unheld(
            Some(format!("^{CLAUDE_SHELL_TOOL_NAME}$")),
            ClaudeHookCallback::BackgroundWork,
        ),
    ];
    let mut agents = None;
    if let Some(SubagentPolicy::Enabled {
        helpers_at_once,
        definitions,
    }) = subagent_policy
    {
        if helpers_at_once.is_some() {
            pre_tool_use.push(held(
                Some(format!(
                    "^({CLAUDE_HELPER_TOOL_NAME}|{CLAUDE_MESSAGE_TOOL_NAME})$"
                )),
                ClaudeHookCallback::HelperLimit,
            ));
        }
        if !definitions.is_empty() {
            agents = Some(compose_claude_agents(definitions));
        }
    }
    ClaudeControlRequest::Initialize {
        hooks: Some(ClaudeHooks {
            pre_tool_use,
            post_tool_use: vec![
                unheld(None, ClaudeHookCallback::HelperSteerAfterTool),
                unheld(
                    Some(compose_command_capture_matcher()),
                    ClaudeHookCallback::CaptureAfterTool,
                ),
            ],
            post_tool_use_failure: vec![
                unheld(
                    Some(compose_command_capture_matcher()),
                    ClaudeHookCallback::CaptureAfterFailedTool,
                ),
                unheld(
                    Some(format!("^{CLAUDE_HELPER_TOOL_NAME}$")),
                    ClaudeHookCallback::HelperCallFailed,
                ),
            ],
            post_tool_batch: vec![unheld(None, ClaudeHookCallback::PauseAfterBatch)],
            permission_denied: vec![unheld(None, ClaudeHookCallback::PermissionDenied)],
            subagent_stop: vec![unheld(None, ClaudeHookCallback::HelperSteerAtStop)],
        }),
        agents,
        supported_dialog_kinds: Some(
            ClaudeDialogKind::ALL
                .into_iter()
                .map(ClaudeDialogKind::as_str)
                .collect(),
        ),
        per_task_stop_affordance: Some(true),
        sdk_mcp_servers: (!in_process_servers.is_empty()).then_some(in_process_servers),
    }
}

// The helpers as Claude Code's `initialize` takes them, by name; it refuses one with no
// description or prompt.
fn compose_claude_agents(
    definitions: &[SubagentDefinition],
) -> BTreeMap<String, ClaudeAgentDefinition> {
    definitions
        .iter()
        .map(|definition| {
            (
                definition.name.clone(),
                ClaudeAgentDefinition {
                    description: definition.description.clone(),
                    prompt: definition.prompt.clone(),
                    model: definition
                        .model
                        .as_ref()
                        .map(|model| model.as_str().to_owned()),
                    tools: definition.tools.clone(),
                    effort: definition
                        .effort
                        .as_ref()
                        .map(|effort| effort.as_str().to_owned()),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{ClaudeHookCallback, compose_claude_initialize_request};
    use crate::driver::claude::session::transport::control::ClaudeControlRequest;
    use crate::driver::session_control::SubagentPolicy;

    // Killed by the matcher left on the helper tool alone, so a message waking an ended helper
    // never reaches the limit, and by the hook registered with no limit set.
    #[rstest]
    #[case::with_a_limit(Some(1), &[Some("^(Agent|SendMessage)$")])]
    #[case::with_no_limit(None, &[])]
    fn the_helper_limit_hook_matches_the_helper_and_message_tools_only_under_a_limit(
        #[case] helpers_at_once: Option<u64>,
        #[case] expected_matchers: &[Option<&str>],
    ) {
        let policy = SubagentPolicy::Enabled {
            helpers_at_once: helpers_at_once
                .map(|limit| SafeInt::new(limit).expect("a positive safe integer")),
            definitions: Vec::new(),
        };

        let ClaudeControlRequest::Initialize {
            hooks: Some(hooks), ..
        } = compose_claude_initialize_request(Some(&policy), Vec::new())
        else {
            panic!("a first initialize carries the hooks");
        };

        let matchers: Vec<Option<&str>> = hooks
            .pre_tool_use
            .iter()
            .filter(|hook| hook.hook_callback_ids == [ClaudeHookCallback::HelperLimit.id()])
            .map(|hook| hook.matcher.as_deref())
            .collect();
        assert_eq!(matchers, expected_matchers);
    }
}
