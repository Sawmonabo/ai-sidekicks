//! The hooks the daemon registers on the wire in each Claude Code process's `initialize`: each one
//! is answered over the same channel as a `hook_callback`, so nothing is written to any settings
//! file and the person's own hooks are untouched.

use std::collections::BTreeMap;

use sidekicks_contracts::wire::integer::SafeInt;

use crate::mcp::tool_name::TOOL_SERVER_TOOL_PREFIX;
use crate::provider::driver::claude::event_normalizer::CLAUDE_QUESTION_TOOL_NAME;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeAgentDefinition, ClaudeControlRequest, ClaudeHookMatcher, ClaudeHooks,
    ClaudeSdkServerConfig,
};
use crate::provider::driver::contract::{SubagentDefinition, SubagentPolicy};
use crate::provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// How long Claude Code waits on a held callback, in seconds: one day. Without it a callback left
/// unanswered is canceled after Claude Code's own ten minutes.
const CLAUDE_HOOK_HOLD_TIMEOUT_SECONDS: u64 = 86_400;

/// The helper tool's name on the wire. The process's `system/init` advertises it as `Task`, but a
/// matcher written against that name never fires.
const CLAUDE_HELPER_TOOL_NAME: &str = "Agent";

/// The shell tool, whose commands the background-work refusal reads.
const CLAUDE_SHELL_TOOL_MATCHER: &str = "^Bash$";

/// A hook the daemon registers, by what answers it; its callback id names it on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHookCallback {
    /// Holds a tool call while the run is paused.
    PauseBeforeTool,
    /// Holds the turn after a batch of tool calls while the run is paused.
    PauseAfterBatch,
    /// Holds a new helper's start past `Helpers at once`.
    HelperLimit,
    /// Answers the question tool and lets the daemon's own tools run.
    QuestionBridge,
    /// Records a tool call the provider denied.
    PermissionDenied,
    /// Refuses a shell command that starts background work.
    BackgroundWork,
}

impl ClaudeHookCallback {
    /// Every hook, so a callback id is read back against each.
    const ALL: [Self; 6] = [
        Self::PauseBeforeTool,
        Self::PauseAfterBatch,
        Self::HelperLimit,
        Self::QuestionBridge,
        Self::PermissionDenied,
        Self::BackgroundWork,
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
        }
    }

    /// The hook a `hook_callback`'s `callback_id` names, or `None` for an id the daemon never
    /// registered.
    #[expect(
        dead_code,
        reason = "the Claude driver's hook-callback router reads each callback through it"
    )]
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

/// The `initialize` request a session's process is brought up with: the daemon's hooks, the
/// session's helper definitions, the two dialogs the console draws, and the per-task stop the
/// console offers, and the tool servers the daemon hosts in-process, by name. The helper hold is
/// registered only where the policy limits helpers at once.
#[expect(
    dead_code,
    reason = "the Claude driver's launch sends it first on each session process"
)]
pub(crate) fn compose_claude_initialize_request(
    subagent_policy: Option<&SubagentPolicy>,
    in_process_servers: BTreeMap<String, ClaudeSdkServerConfig>,
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
            Some(CLAUDE_SHELL_TOOL_MATCHER.to_owned()),
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
                Some(format!("^{CLAUDE_HELPER_TOOL_NAME}$")),
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
            post_tool_batch: vec![unheld(None, ClaudeHookCallback::PauseAfterBatch)],
            permission_denied: vec![unheld(None, ClaudeHookCallback::PermissionDenied)],
        }),
        agents,
        supported_dialog_kinds: Some(
            ClaudeDialogKind::ALL
                .into_iter()
                .map(ClaudeDialogKind::as_str)
                .collect(),
        ),
        per_task_stop_affordance: Some(true),
        sdk_mcp_servers: (!in_process_servers.is_empty())
            .then(|| in_process_servers.keys().cloned().collect()),
        sdk_mcp_server_configs: (!in_process_servers.is_empty()).then_some(in_process_servers),
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
                    max_turns: definition.max_turns.map(SafeInt::get),
                },
            )
        })
        .collect()
}
