//! The daemon's answers to Codex's tool hooks, whatever carries the call: the hook input read from
//! the tool call Codex makes for a hook row, and one dispatch point where each answerer in turn
//! may answer or let the next one. A held call ends by an answer or by its cancellation, never by
//! a timer.

use std::error::Error;
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::sync::CancellationToken;

use crate::error_description::describe_error;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::bound_failure_detail;
use crate::provider::inbound_json::decode_inbound_json;

/// The sentence a pre-tool call is denied with when its input cannot be read; the model reads it.
/// It never quotes the input, which holds the tool's arguments.
const HOOK_INPUT_UNREADABLE_REASON: &str =
    "The daemon could not read this tool call's hook input, so the call was not run.";

/// Stands in for an answerer's failure that carries no usable words.
static ANSWERER_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("A hook answer failed with no words of its own.".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// The tool hook events the daemon answers.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex hook tools name the event each one answers"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexHookEvent {
    /// Before a tool call runs; an answer may deny it.
    PreToolUse,
    /// After a tool call ran; an answer may add words to the model's context.
    PostToolUse,
}

/// One tool hook input as Codex sends it, read at the dispatch point.
#[expect(
    dead_code,
    reason = "the pre-tool checks read the call's tool, input and folder"
)]
#[derive(Debug)]
pub(crate) struct CodexHookInput {
    /// The event the input is for.
    pub(crate) event: CodexHookEvent,
    /// The conversation the call runs in: the session's own thread or a helper's.
    pub(crate) thread_id: String,
    /// The session's root conversation, which a helper's call names too.
    pub(crate) session_id: Option<String>,
    /// The turn the call runs in.
    pub(crate) turn_id: Option<String>,
    /// The tool called.
    pub(crate) tool_name: Option<String>,
    /// Codex's id for the call.
    pub(crate) tool_use_id: Option<String>,
    /// The tool's arguments, as Codex sent them.
    pub(crate) tool_input: Option<Box<RawValue>>,
    /// What the tool answered, on a post-tool call.
    pub(crate) tool_response: Option<Box<RawValue>>,
    /// The folder the call runs in, which a patch's relative file paths are read against.
    pub(crate) cwd: Option<String>,
}

/// The daemon's answer to one hook call: nothing, a pre-tool denial whose reason the model reads,
/// or words a post-tool hook adds to the model's context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexHookAnswer {
    /// No decision: the call runs, or its result stands.
    Pass,
    /// Denies the pre-tool call.
    Deny {
        /// What the model reads as why.
        reason: String,
    },
    /// Adds words to the model's context after the call.
    Context {
        /// The words added.
        additional_context: String,
    },
}

/// One answerer at the dispatch point. `Ok(None)` lets the next one answer; an error denies a
/// pre-tool call and passes a post-tool one. `token` cancels when the call no longer waits.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex hook tools dispatch each call to the answerers"
    )
)]
pub(crate) trait CodexHookAnswerer: Send + Sync {
    /// Answers `input`, or lets the next answerer; fails when it could not decide.
    fn answer<'a>(
        &'a self,
        input: &'a CodexHookInput,
        token: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>>;
}

/// The one dispatch point every Codex hook call is answered at: the answerers in order, the
/// first answer winning and a call none answers passing.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the Codex hook tools answer each call through it")
)]
pub(crate) struct CodexHookDispatch {
    /// Asked in order.
    answerers: Vec<Arc<dyn CodexHookAnswerer>>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the Codex hook tools answer each call through it")
)]
impl CodexHookDispatch {
    /// A dispatch point asking `answerers` in order.
    pub(crate) fn new(answerers: Vec<Arc<dyn CodexHookAnswerer>>) -> Self {
        Self { answerers }
    }

    /// Answers one call of `event`'s hook: `call` is the tool call Codex made for the hook row.
    /// `token` is the call's own, cancelled when Codex ended the call or its connection went; a
    /// cancelled call gets `None`, so an answer that arrives after it is dropped. An input that
    /// cannot be read, or an answerer's failure, denies a pre-tool call and passes a post-tool one.
    pub(crate) async fn answer(
        &self,
        event: CodexHookEvent,
        call: CodexHookCall<'_>,
        token: &CancellationToken,
    ) -> Option<CodexHookAnswer> {
        // Cancellation is polled first, so an answer ready on the same poll is dropped too.
        tokio::select! {
            biased;
            () = token.cancelled() => None,
            answer = self.answer_call(event, call, token) => Some(answer),
        }
    }

    async fn answer_call(
        &self,
        event: CodexHookEvent,
        call: CodexHookCall<'_>,
        token: &CancellationToken,
    ) -> CodexHookAnswer {
        let input = match read_hook_input(event, call) {
            Ok(input) => input,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a Codex hook input could not be read"
                );
                return failure_answer(event, HOOK_INPUT_UNREADABLE_REASON.to_owned());
            }
        };
        match self.ask_answerers(&input, token).await {
            Ok(answer) => answer,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    thread_id = input.thread_id.as_str(),
                    "a Codex hook answerer failed"
                );
                let detail = bound_failure_detail(
                    &describe_error(&error),
                    ANSWERER_FAILURE_FALLBACK.clone(),
                );
                failure_answer(event, detail.into_string())
            }
        }
    }

    async fn ask_answerers(
        &self,
        input: &CodexHookInput,
        token: &CancellationToken,
    ) -> Result<CodexHookAnswer, CodexError> {
        for answerer in &self.answerers {
            if let Some(answer) = answerer.answer(input, token).await? {
                return Ok(answer);
            }
        }
        Ok(CodexHookAnswer::Pass)
    }
}

// What a call gets when it could not be answered: a pre-tool call is denied with `reason`, since
// a call let through unchecked could run what a check would refuse; a post-tool call passes.
fn failure_answer(event: CodexHookEvent, reason: String) -> CodexHookAnswer {
    match event {
        CodexHookEvent::PreToolUse => CodexHookAnswer::Deny { reason },
        CodexHookEvent::PostToolUse => CodexHookAnswer::Pass,
    }
}

/// One tool call Codex makes for a hook row, as its JSON: the call's arguments, which Codex fills
/// from the row's `input` template, and the call's `_meta`, to which Codex adds the owning
/// conversation's id.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex hook tools hand each call to the dispatch point"
    )
)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct CodexHookCall<'call> {
    /// The call's `arguments` object.
    pub(crate) arguments: &'call [u8],
    /// The call's `_meta` object.
    pub(crate) meta: &'call [u8],
}

/// Why a hook call could not be read as a tool hook input.
#[derive(Debug, thiserror::Error)]
enum HookInputError {
    /// The call's arguments are not a JSON object of the template's members.
    #[error("the Codex hook call's arguments are not a hook input")]
    Malformed(#[source] serde_json::Error),
    /// The call's `_meta` is not a JSON object.
    #[error("the Codex hook call's metadata is not an object")]
    MalformedMeta(#[source] serde_json::Error),
    /// The call names an event other than the hook called.
    #[error("the Codex hook call names the event \"{named}\", not the hook called")]
    OtherEvent {
        /// The event the call names.
        named: String,
    },
    /// The call's `_meta` names no conversation.
    #[error("the Codex hook call names no conversation")]
    NoConversation,
}

/// The arguments of a hook row's tool call, as the row's `input` template fills them. Codex fills
/// each `${name}` from the hook event and fails the hook on a name the event lacks, so the
/// template names only members both tool events always carry: every row's template maps
/// `hook_event_name`, `session_id`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input` and `cwd`
/// each to the event member of the same name (`"tool_input": "${tool_input}"`), and the post-tool
/// row's adds `tool_response`. The conversation is never a template member: the lead's event
/// carries no `agent_id`, so it is read from the call's `_meta.threadId`.
#[derive(Deserialize)]
struct HookCallArguments {
    hook_event_name: String,
    session_id: Option<String>,
    turn_id: Option<String>,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    tool_input: Option<Box<RawValue>>,
    tool_response: Option<Box<RawValue>>,
    cwd: Option<String>,
}

/// The member of a hook call's `_meta` that names the conversation the call runs in.
#[derive(Deserialize)]
struct HookCallMeta {
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
}

// Reads the tool call Codex made for `event`'s hook row.
fn read_hook_input(
    event: CodexHookEvent,
    call: CodexHookCall<'_>,
) -> Result<CodexHookInput, HookInputError> {
    let arguments: HookCallArguments = serde_json::from_str(&decode_inbound_json(call.arguments))
        .map_err(HookInputError::Malformed)?;
    let meta: HookCallMeta = serde_json::from_str(&decode_inbound_json(call.meta))
        .map_err(HookInputError::MalformedMeta)?;
    let named_event = match arguments.hook_event_name.as_str() {
        "PreToolUse" => Some(CodexHookEvent::PreToolUse),
        "PostToolUse" => Some(CodexHookEvent::PostToolUse),
        _ => None,
    };
    if named_event != Some(event) {
        return Err(HookInputError::OtherEvent {
            named: arguments.hook_event_name,
        });
    }
    let thread_id = non_empty(meta.thread_id).ok_or(HookInputError::NoConversation)?;
    Ok(CodexHookInput {
        event,
        thread_id,
        session_id: non_empty(arguments.session_id),
        turn_id: non_empty(arguments.turn_id),
        tool_name: non_empty(arguments.tool_name),
        tool_use_id: non_empty(arguments.tool_use_id),
        tool_input: arguments.tool_input,
        tool_response: arguments.tool_response,
        cwd: non_empty(arguments.cwd),
    })
}

// An empty string Codex sends reads as absent.
fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use tokio_util::sync::CancellationToken;

    use super::{
        CodexHookAnswer, CodexHookAnswerer, CodexHookCall, CodexHookDispatch, CodexHookEvent,
        CodexHookInput, HOOK_INPUT_UNREADABLE_REASON,
    };
    use crate::provider::driver::codex::session::errors::CodexError;

    const PRE_TOOL_ARGUMENTS: &[u8] = concat!(
        r#"{"hook_event_name":"PreToolUse","session_id":"thread-1","turn_id":"turn-1","#,
        r#""tool_name":"Bash","tool_use_id":"call-1","tool_input":{"command":"ls"},"#,
        r#""cwd":"/work"}"#,
    )
    .as_bytes();
    const POST_TOOL_ARGUMENTS: &[u8] = concat!(
        r#"{"hook_event_name":"PostToolUse","session_id":"thread-1","turn_id":"turn-1","#,
        r#""tool_name":"Bash","tool_use_id":"call-1","tool_input":{"command":"ls"},"#,
        r#""tool_response":"done","cwd":"/work"}"#,
    )
    .as_bytes();
    const META: &[u8] = br#"{"threadId":"thread-1","progressToken":7}"#;

    fn call(arguments: &'static [u8]) -> CodexHookCall<'static> {
        CodexHookCall {
            arguments,
            meta: META,
        }
    }

    /// Answers every call the same, counting the calls it was asked.
    struct FixedAnswerer {
        answer: Result<Option<CodexHookAnswer>, &'static str>,
        asked: AtomicUsize,
    }

    impl FixedAnswerer {
        fn new(answer: Result<Option<CodexHookAnswer>, &'static str>) -> Arc<Self> {
            Arc::new(Self {
                answer,
                asked: AtomicUsize::new(0),
            })
        }
    }

    impl CodexHookAnswerer for FixedAnswerer {
        fn answer<'a>(
            &'a self,
            _input: &'a CodexHookInput,
            _token: &'a CancellationToken,
        ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            let answer = self.answer.clone().map_err(|detail| CodexError::Transport {
                detail: detail.to_owned(),
                cause: None,
            });
            Box::pin(async move { answer })
        }
    }

    /// Answers a denial after a second, whether or not the call still waits.
    struct LateAnswerer;

    impl CodexHookAnswerer for LateAnswerer {
        fn answer<'a>(
            &'a self,
            _input: &'a CodexHookInput,
            _token: &'a CancellationToken,
        ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(Some(CodexHookAnswer::Deny {
                    reason: "late".to_owned(),
                }))
            }
            .boxed()
        }
    }

    fn deny(reason: &str) -> CodexHookAnswer {
        CodexHookAnswer::Deny {
            reason: reason.to_owned(),
        }
    }

    #[rstest]
    #[case::not_json_before_a_tool(
        CodexHookEvent::PreToolUse,
        call(b"not json"),
        Ok(None),
        deny(HOOK_INPUT_UNREADABLE_REASON)
    )]
    #[case::not_json_after_a_tool(
        CodexHookEvent::PostToolUse,
        call(b"not json"),
        Ok(None),
        CodexHookAnswer::Pass
    )]
    #[case::no_conversation(
        CodexHookEvent::PreToolUse,
        CodexHookCall { arguments: PRE_TOOL_ARGUMENTS, meta: br#"{"progressToken":7}"# },
        Ok(None),
        deny(HOOK_INPUT_UNREADABLE_REASON)
    )]
    #[case::meta_not_an_object(
        CodexHookEvent::PreToolUse,
        CodexHookCall { arguments: PRE_TOOL_ARGUMENTS, meta: b"[]" },
        Ok(None),
        deny(HOOK_INPUT_UNREADABLE_REASON)
    )]
    #[case::another_event(
        CodexHookEvent::PreToolUse,
        call(POST_TOOL_ARGUMENTS),
        Ok(None),
        deny(HOOK_INPUT_UNREADABLE_REASON)
    )]
    #[case::answerer_failed_before_a_tool(
        CodexHookEvent::PreToolUse,
        call(PRE_TOOL_ARGUMENTS),
        Err("  the policy store is gone  "),
        deny("the policy store is gone")
    )]
    #[case::answerer_failed_after_a_tool(
        CodexHookEvent::PostToolUse,
        call(POST_TOOL_ARGUMENTS),
        Err("the policy store is gone"),
        CodexHookAnswer::Pass
    )]
    #[tokio::test]
    async fn a_call_that_cannot_be_answered_denies_before_a_tool_and_passes_after(
        #[case] event: CodexHookEvent,
        #[case] hook_call: CodexHookCall<'static>,
        #[case] answered: Result<Option<CodexHookAnswer>, &'static str>,
        #[case] expected: CodexHookAnswer,
    ) {
        let dispatch = CodexHookDispatch::new(vec![FixedAnswerer::new(answered)]);

        let answer = dispatch
            .answer(event, hook_call, &CancellationToken::new())
            .await;

        assert_eq!(answer, Some(expected));
    }

    #[tokio::test]
    async fn the_first_answer_wins_and_a_call_none_answers_passes() {
        let letting_go = FixedAnswerer::new(Ok(None));
        let denying = FixedAnswerer::new(Ok(Some(deny("first"))));
        let after_the_winner = FixedAnswerer::new(Ok(Some(CodexHookAnswer::Context {
            additional_context: "second".to_owned(),
        })));
        let dispatch =
            CodexHookDispatch::new(vec![letting_go.clone(), denying, after_the_winner.clone()]);
        let token = CancellationToken::new();

        let answer = dispatch
            .answer(CodexHookEvent::PreToolUse, call(PRE_TOOL_ARGUMENTS), &token)
            .await;

        assert_eq!(answer, Some(deny("first")));
        assert_eq!(letting_go.asked.load(Ordering::SeqCst), 1);
        assert_eq!(after_the_winner.asked.load(Ordering::SeqCst), 0);

        let none_answers = CodexHookDispatch::new(vec![letting_go]);
        let answer = none_answers
            .answer(CodexHookEvent::PreToolUse, call(PRE_TOOL_ARGUMENTS), &token)
            .await;
        assert_eq!(answer, Some(CodexHookAnswer::Pass));
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_after_the_call_was_cancelled_is_dropped() {
        let dispatch = Arc::new(CodexHookDispatch::new(vec![Arc::new(LateAnswerer)]));
        let token = CancellationToken::new();
        let call = tokio::spawn({
            let dispatch = Arc::clone(&dispatch);
            let token = token.clone();
            async move {
                dispatch
                    .answer(CodexHookEvent::PreToolUse, call(PRE_TOOL_ARGUMENTS), &token)
                    .await
            }
        });
        tokio::task::yield_now().await;

        token.cancel();

        assert_eq!(call.await.expect("the call's task ends"), None);
    }
}
