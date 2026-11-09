//! How a call on a spawn's `sidekicks_hooks` entry is answered, the first matching row deciding: a
//! call naming a conversation the entry's session does not hold is refused as unreadable, and any
//! other goes to the dispatch point, whose first answerer refuses a model's own call to one of the
//! entry's tools, since those tools run only as hooks.

use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::sync::CancellationToken;

use crate::driver::codex::hooks::server::{
    CODEX_HOOK_TOOLS, CodexHookAnswer, CodexHookAnswerer, CodexHookCall, CodexHookDispatch,
    CodexHookEvent, CodexHookInput, HOOK_INPUT_UNREADABLE_REASON, failure_answer,
    read_hook_thread_id,
};
use crate::driver::codex::lifecycle::views::CodexSessionViews;
use crate::driver::codex::session::errors::CodexError;
use crate::mcp::tool_name::compose_tool_server_tool_name;
use crate::port::hook_tool_server::{HookTool, HookToolAnswer, HookToolCall, HookToolServer};
use crate::tool_server_name::DAEMON_HOOKS_TOOL_SERVER_NAME;

/// The name Codex's pre-tool hook gives a model's call to one of the hooks entry's tools, less the
/// tool: `mcp__sidekicks_hooks__`.
static HOOK_TOOL_CALL_PREFIX: LazyLock<String> =
    LazyLock::new(|| compose_tool_server_tool_name(DAEMON_HOOKS_TOOL_SERVER_NAME, ""));

/// What answers the calls on every hooks entry one driver's spawns open: the dispatch point, and
/// the live sessions' views, which name the service whose conversations each session holds.
pub(crate) struct CodexHookTools {
    dispatch: CodexHookDispatch,
    views: Arc<CodexSessionViews>,
}

impl CodexHookTools {
    /// Answers through a dispatch point asking `answerers` in order, each call first checked
    /// against the conversations its entry's session holds on the service `views` names.
    pub(crate) fn new(
        answerers: Vec<Arc<dyn CodexHookAnswerer>>,
        views: Arc<CodexSessionViews>,
    ) -> Self {
        Self {
            dispatch: CodexHookDispatch::new(answerers),
            views,
        }
    }

    /// The hooks entry a spawn of `session_id` opens.
    pub(crate) fn for_session(self: &Arc<Self>, session_id: SessionId) -> Arc<dyn HookToolServer> {
        Arc::new(CodexSessionHookTools {
            session_id,
            tools: Arc::clone(self),
        })
    }

    // Whether `thread_id` is a conversation `session_id` holds on its service: its own or a
    // helper's.
    fn holds(&self, session_id: SessionId, thread_id: &str) -> bool {
        self.views
            .service(session_id)
            .is_some_and(|service| service.session_of_thread(thread_id) == Some(session_id))
    }
}

/// One spawn's hooks entry, answering for the conversations of its session alone.
struct CodexSessionHookTools {
    session_id: SessionId,
    tools: Arc<CodexHookTools>,
}

impl HookToolServer for CodexSessionHookTools {
    fn tools(&self) -> &'static [HookTool] {
        &CODEX_HOOK_TOOLS
    }

    /// Answers the call of the event whose tool it names. A call whose `_meta.threadId` names a
    /// conversation the session does not hold is refused as unreadable before a tool and passes
    /// after one; any other gets the dispatch point's answer as Codex's hook output.
    fn answer<'a>(
        &'a self,
        call: HookToolCall,
        token: &'a CancellationToken,
    ) -> BoxFuture<'a, HookToolAnswer> {
        let Some(event) = CodexHookEvent::of_hook_tool(&call.tool_name) else {
            return std::future::ready(HookToolAnswer::NoSuchTool).boxed();
        };
        // A `_meta` naming no conversation is left to the dispatch point, which refuses it alike.
        if let Ok(thread_id) = read_hook_thread_id(call.meta.clone())
            && !self.tools.holds(self.session_id, &thread_id)
        {
            tracing::warn!(
                session_id = %self.session_id,
                thread_id,
                "a Codex hook call named a conversation its session does not hold"
            );
            let answer = failure_answer(event, HOOK_INPUT_UNREADABLE_REASON.to_owned());
            return std::future::ready(HookToolAnswer::Answered(answer.to_hook_output(event)))
                .boxed();
        }
        let call = CodexHookCall {
            arguments: call.arguments,
            meta: call.meta,
        };
        async move {
            match self.tools.dispatch.answer(event, call, token).await {
                Some(answer) => HookToolAnswer::Answered(answer.to_hook_output(event)),
                None => HookToolAnswer::Canceled,
            }
        }
        .boxed()
    }
}

/// Refuses a model's own call to one of the hooks entry's tools, which Codex reports as the
/// pre-tool hook firing for `mcp__sidekicks_hooks__<tool>`; any other call is left to the next
/// answerer. Never fails.
pub(crate) struct CodexHookOnlyTools;

impl CodexHookAnswerer for CodexHookOnlyTools {
    fn answer<'a>(
        &'a self,
        input: &'a CodexHookInput,
        _token: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
        let answer = match input.event {
            CodexHookEvent::PreToolUse => input
                .tool_name
                .as_deref()
                .and_then(|tool_name| tool_name.strip_prefix(HOOK_TOOL_CALL_PREFIX.as_str()))
                .map(|tool| CodexHookAnswer::Deny {
                    reason: format!("{tool} runs only as a hook and cannot be called."),
                }),
            CodexHookEvent::PostToolUse => None,
        };
        std::future::ready(Ok(answer)).boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Map, Value, json};
    use tokio_util::sync::CancellationToken;

    use super::{CodexHookOnlyTools, CodexHookTools};
    use crate::driver::codex::hooks::server::HOOK_INPUT_UNREADABLE_REASON;
    use crate::driver::codex::lifecycle::views::CodexSessionViews;
    use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
    use crate::driver::test_registry::new_session_id;
    use crate::port::hook_tool_server::{HookToolAnswer, HookToolCall, HookToolServer};

    // One call of the pre-tool row's tool or the post-tool row's, for `tool_name` on `thread_id`.
    fn hook_call(event_name: &str, tool_name: &str, thread_id: &str) -> HookToolCall {
        let row_tool = match event_name {
            "PreToolUse" => "pre_tool_use",
            _ => "post_tool_use",
        };
        HookToolCall {
            tool_name: row_tool.to_owned(),
            arguments: Map::from_iter([
                ("hook_event_name".to_owned(), Value::from(event_name)),
                ("session_id".to_owned(), Value::from(TEST_THREAD)),
                ("tool_name".to_owned(), Value::from(tool_name)),
            ]),
            meta: Map::from_iter([("threadId".to_owned(), Value::from(thread_id))]),
        }
    }

    fn denied(reason: &str) -> HookToolAnswer {
        HookToolAnswer::Answered(
            json!({ "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }})
            .to_string(),
        )
    }

    fn passed() -> HookToolAnswer {
        HookToolAnswer::Answered(String::new())
    }

    // The hooks entry of `session`'s spawn, its dispatch point asking the hook-only refusal alone.
    fn entry_of(session: &TestCodexSession) -> Arc<dyn HookToolServer> {
        let views = Arc::new(CodexSessionViews::default());
        views.show(&session.task.record);
        Arc::new(CodexHookTools::new(
            vec![Arc::new(CodexHookOnlyTools)],
            views,
        ))
        .for_session(session.task.record.session_id)
    }

    #[tokio::test]
    async fn a_models_call_to_a_hook_tool_is_refused_by_name() {
        let session = TestCodexSession::start().await;
        let entry = entry_of(&session);
        let token = CancellationToken::new();

        let models_call = entry
            .answer(
                hook_call(
                    "PreToolUse",
                    "mcp__sidekicks_hooks__pre_tool_use",
                    TEST_THREAD,
                ),
                &token,
            )
            .await;
        let other_tool = entry
            .answer(
                hook_call("PreToolUse", "mcp__docs__search", TEST_THREAD),
                &token,
            )
            .await;

        assert_eq!(
            models_call,
            denied("pre_tool_use runs only as a hook and cannot be called.")
        );
        assert_eq!(other_tool, passed());
    }

    #[tokio::test]
    async fn a_hook_call_naming_a_conversation_its_session_does_not_hold_is_refused_as_unreadable()
    {
        let session = TestCodexSession::start().await;
        session
            .scripted
            .service
            .register_thread("thread-of-another-session".to_owned(), new_session_id());
        let entry = entry_of(&session);
        let token = CancellationToken::new();

        let another_sessions = entry
            .answer(
                hook_call("PreToolUse", "Bash", "thread-of-another-session"),
                &token,
            )
            .await;
        let unknown = entry
            .answer(
                hook_call("PreToolUse", "Bash", "thread-nobody-holds"),
                &token,
            )
            .await;
        let after_a_tool = entry
            .answer(
                hook_call("PostToolUse", "Bash", "thread-nobody-holds"),
                &token,
            )
            .await;
        let its_own = entry
            .answer(hook_call("PreToolUse", "Bash", TEST_THREAD), &token)
            .await;

        assert_eq!(another_sessions, denied(HOOK_INPUT_UNREADABLE_REASON));
        assert_eq!(unknown, denied(HOOK_INPUT_UNREADABLE_REASON));
        assert_eq!(after_a_tool, passed());
        assert_eq!(its_own, passed());
    }
}
