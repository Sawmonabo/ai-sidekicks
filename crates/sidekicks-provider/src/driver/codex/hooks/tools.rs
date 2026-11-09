//! How a call on a spawn's `sidekicks_hooks` entry is answered, the first matching row deciding: a
//! call naming a conversation its service records as another session's is refused as unreadable,
//! one naming a conversation no session holds yet waits for its registration, and any other goes
//! to the dispatch point, whose first answerer refuses a model's own call to one of the entry's
//! tools, since those tools run only as hooks.

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
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::mcp::tool_name::compose_tool_server_tool_name;
use crate::port::hook_tool_server::{HookTool, HookToolAnswer, HookToolCall, HookToolServer};
use crate::tool_server_name::DAEMON_HOOKS_TOOL_SERVER_NAME;

/// The name Codex's pre-tool hook gives a model's call to one of the hooks entry's tools, less the
/// tool: `mcp__sidekicks_hooks__`.
static HOOK_TOOL_CALL_PREFIX: LazyLock<String> =
    LazyLock::new(|| compose_tool_server_tool_name(DAEMON_HOOKS_TOOL_SERVER_NAME, ""));

/// The dispatch point every hooks entry one driver's spawns open answers its calls through.
pub(crate) struct CodexHookTools {
    dispatch: CodexHookDispatch,
}

impl CodexHookTools {
    /// Answers through a dispatch point asking `answerers` in order.
    pub(crate) fn new(answerers: Vec<Arc<dyn CodexHookAnswerer>>) -> Self {
        Self {
            dispatch: CodexHookDispatch::new(answerers),
        }
    }

    /// The hooks entry a spawn of `session_id` on `service` opens, which reads the owner of each
    /// call's conversation from that service's own table.
    pub(crate) fn for_session(
        self: &Arc<Self>,
        session_id: SessionId,
        service: &Arc<CodexService>,
    ) -> Arc<dyn HookToolServer> {
        Arc::new(CodexSessionHookTools {
            session_id,
            service: Arc::clone(service),
            tools: Arc::clone(self),
        })
    }
}

/// One spawn's hooks entry, answering for the conversations of its session alone.
struct CodexSessionHookTools {
    session_id: SessionId,
    /// The service the spawn's conversation is loaded on.
    service: Arc<CodexService>,
    tools: Arc<CodexHookTools>,
}

impl HookToolServer for CodexSessionHookTools {
    fn tools(&self) -> &'static [HookTool] {
        &CODEX_HOOK_TOOLS
    }

    /// Answers the call of the event whose tool it names. A call whose `_meta.threadId` names a
    /// conversation the service records as another session's, or one it released, is refused as
    /// unreadable before a tool and passes after one; one naming a conversation no session holds
    /// yet waits until it is registered, the call's `token` bounding the wait; any other gets the
    /// dispatch point's answer as Codex's hook output.
    fn answer<'a>(
        &'a self,
        call: HookToolCall,
        token: &'a CancellationToken,
    ) -> BoxFuture<'a, HookToolAnswer> {
        let Some(event) = CodexHookEvent::of_hook_tool(&call.tool_name) else {
            return std::future::ready(HookToolAnswer::NoSuchTool).boxed();
        };
        async move {
            // A `_meta` naming no conversation is left to the dispatch point, which refuses it.
            if let Ok(thread_id) = read_hook_thread_id(call.meta.clone()) {
                // A conversation the service released holds no session, and no registration
                // ends a wait on it. A helper's call can come ahead of its spawn item, and a
                // restarted daemon's first calls ahead of the adoption's registration.
                let owner = if self.service.former_session_of_thread(&thread_id).is_some() {
                    None
                } else {
                    let Some(owner) = self
                        .service
                        .await_session_of_thread(&thread_id, token)
                        .await
                    else {
                        return HookToolAnswer::Canceled;
                    };
                    Some(owner)
                };
                if owner != Some(self.session_id) {
                    tracing::warn!(
                        session_id = %self.session_id,
                        thread_id,
                        "a Codex hook call named another session's or a released conversation"
                    );
                    let answer = failure_answer(event, HOOK_INPUT_UNREADABLE_REASON.to_owned());
                    return HookToolAnswer::Answered(answer.to_hook_output(event));
                }
            }
            let call = CodexHookCall {
                arguments: call.arguments,
                meta: call.meta,
            };
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
    use crate::driver::codex::hooks::server::{
        CodexHookAnswer, CodexHookEvent, CodexHookInput, HOOK_INPUT_UNREADABLE_REASON,
    };
    use crate::driver::codex::lifecycle::compose_hook_answerers;
    use crate::driver::codex::run::stopped_helpers::CodexStoppedHelpers;
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
        Arc::new(CodexHookTools::new(vec![Arc::new(CodexHookOnlyTools)]))
            .for_session(session.task.record.session_id, &session.task.record.service)
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

    // Killed by answering an unregistered conversation at once (it no longer waits), by dropping
    // the owner check (another session's call passes), and by a released conversation's call
    // waiting on a registration instead of being refused at once.
    #[tokio::test]
    async fn a_hook_call_on_another_sessions_conversation_is_refused_and_an_unregistered_one_waits()
    {
        let session = TestCodexSession::start().await;
        let service = &session.scripted.service;
        service.register_thread("thread-of-another-session".to_owned(), new_session_id());
        let entry = entry_of(&session);
        let token = CancellationToken::new();

        let another_sessions = entry
            .answer(
                hook_call("PreToolUse", "Bash", "thread-of-another-session"),
                &token,
            )
            .await;
        let after_a_tool = entry
            .answer(
                hook_call("PostToolUse", "Bash", "thread-of-another-session"),
                &token,
            )
            .await;
        let its_own = entry
            .answer(hook_call("PreToolUse", "Bash", TEST_THREAD), &token)
            .await;
        let early = entry.answer(
            hook_call("PreToolUse", "Bash", "thread-of-a-helper"),
            &token,
        );
        tokio::pin!(early);
        let is_waiting = futures::poll!(&mut early).is_pending();
        service.register_thread(
            "thread-of-a-helper".to_owned(),
            session.task.record.session_id,
        );
        let registered_late = early.await;
        service.register_thread(
            "thread-of-a-stopped-helper".to_owned(),
            session.task.record.session_id,
        );
        service.release_thread("thread-of-a-stopped-helper");
        let released = futures::poll!(entry.answer(
            hook_call("PreToolUse", "Bash", "thread-of-a-stopped-helper"),
            &token,
        ));
        let abandoned = CancellationToken::new();
        let never_registered = entry.answer(
            hook_call("PreToolUse", "Bash", "thread-nobody-holds"),
            &abandoned,
        );
        abandoned.cancel();

        assert_eq!(another_sessions, denied(HOOK_INPUT_UNREADABLE_REASON));
        assert_eq!(after_a_tool, passed());
        assert_eq!(its_own, passed());
        assert!(
            is_waiting,
            "a call on an unregistered conversation waits for it"
        );
        assert_eq!(registered_late, passed());
        assert_eq!(
            released,
            std::task::Poll::Ready(denied(HOOK_INPUT_UNREADABLE_REASON)),
            "a released conversation's call is refused at once"
        );
        assert_eq!(never_registered.await, HookToolAnswer::Canceled);
    }

    // Killed by putting any answerer ahead of the hook-only refusal in the driver's list: the
    // list's first answerer alone must refuse a model's call to a hook tool by name.
    #[tokio::test]
    async fn the_drivers_hook_answerers_ask_the_hook_only_refusal_first() {
        let answerers = compose_hook_answerers(&Arc::new(CodexStoppedHelpers::new(
            tokio_util::task::TaskTracker::new(),
        )));
        let input = CodexHookInput {
            event: CodexHookEvent::PreToolUse,
            thread_id: TEST_THREAD.to_owned(),
            session_id: None,
            turn_id: None,
            tool_name: Some("mcp__sidekicks_hooks__post_tool_use".to_owned()),
            tool_use_id: None,
            tool_input: None,
            tool_response: None,
            cwd: None,
        };

        let first = answerers
            .first()
            .expect("the driver asks at least one answerer")
            .answer(&input, &CancellationToken::new())
            .await
            .expect("the hook-only refusal never fails");

        assert_eq!(
            first,
            Some(CodexHookAnswer::Deny {
                reason: "post_tool_use runs only as a hook and cannot be called.".to_owned(),
            })
        );
    }
}
