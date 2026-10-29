//! A Codex helper stopped alone, at its token limit or refused by the daemon after it started: its
//! own conversation's running turn is interrupted, so the lead's turn, on its own conversation,
//! goes on; each turn it starts after is interrupted at its start, and each of its pre-tool calls
//! is denied with the sentence its stop's reason carries, which the helper reads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde::Deserialize;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::read_codex_newest_turn;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::DriverError;
use crate::driver::run_control::{HelperStopReason, HelperTokenLimitParams};

// The member of a listed turn this stop reads.
#[derive(Deserialize)]
struct ListedTurnStatus {
    status: Option<String>,
}

/// The helper conversations stopped alone, whose every later turn is interrupted at its start and
/// whose every pre-tool call is denied.
pub(crate) struct CodexStoppedHelpers {
    // Each stopped helper by its own conversation's id, which no other conversation shares.
    helpers: Mutex<HashMap<String, StoppedHelper>>,
    // The driver's tasks, which each interrupt runs on.
    tasks: TaskTracker,
}

// A stopped helper's session and why it was stopped.
struct StoppedHelper {
    session_id: SessionId,
    reason: HelperStopReason,
}

impl CodexStoppedHelpers {
    /// No helper stopped yet, each interrupt run on `tasks`, the driver's.
    pub(crate) fn new(tasks: TaskTracker) -> Self {
        Self {
            helpers: Mutex::default(),
            tasks,
        }
    }

    /// Marks the helper conversation `helper_thread_id` of `session_id` stopped for `reason`; a
    /// later stop's reason replaces an earlier one.
    pub(crate) fn stop(
        &self,
        session_id: SessionId,
        helper_thread_id: &str,
        reason: HelperStopReason,
    ) {
        lock(&self.helpers).insert(
            helper_thread_id.to_owned(),
            StoppedHelper { session_id, reason },
        );
    }

    /// Stops the helper conversation `helper_thread_id` of the session `record` holds for
    /// `reason`, as [`Self::stop`] does, and interrupts the turn it is running; the interrupt runs
    /// on a task of the driver's, since the frame that asks for it is still being delivered, and a
    /// failed one is logged.
    pub(crate) fn stop_running(
        &self,
        record: &CodexSessionRecord,
        helper_thread_id: &str,
        reason: HelperStopReason,
    ) {
        self.stop(record.session_id, helper_thread_id, reason);
        let service = Arc::clone(&record.service);
        let session_id = record.session_id;
        let helper_thread_id = helper_thread_id.to_owned();
        self.tasks.spawn(async move {
            let stopped = match service.connection() {
                Ok(connection) => stop_codex_helper_turn(&connection, &helper_thread_id).await,
                Err(error) => Err(error),
            };
            if let Err(error) = stopped {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    helper_thread_id,
                    "a stopped codex helper's running turn could not be interrupted"
                );
            }
        });
    }

    /// Interrupts the turn `turn_id` that the helper conversation `helper_thread_id` of the
    /// session `record` holds just started, when that helper was stopped; the interrupt runs on a
    /// task of the driver's, and a failed one is logged.
    pub(crate) fn interrupt_started_turn(
        &self,
        record: &CodexSessionRecord,
        helper_thread_id: &str,
        turn_id: &str,
    ) {
        let is_stopped = lock(&self.helpers).contains_key(helper_thread_id);
        if !is_stopped {
            return;
        }
        let service = Arc::clone(&record.service);
        let session_id = record.session_id;
        let helper_thread_id = helper_thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        self.tasks.spawn(async move {
            let interrupted = match service.connection() {
                Ok(connection) => interrupt_codex_turn(&connection, &helper_thread_id, &turn_id)
                    .await
                    .map(drop),
                Err(error) => Err(error),
            };
            if let Err(error) = interrupted {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    helper_thread_id,
                    turn_id,
                    "a stopped codex helper could not be interrupted at its turn's start"
                );
            }
        });
    }

    /// Lets go of a closed session's stopped helpers.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.helpers).retain(|_, stopped| stopped.session_id != session_id);
    }
}

impl CodexHookAnswerer for CodexStoppedHelpers {
    /// Denies a stopped helper's pre-tool call with its stop's sentence; any other call is left to
    /// the next answerer. Never fails.
    fn answer<'a>(
        &'a self,
        input: &'a CodexHookInput,
        _token: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
        let answer = match input.event {
            CodexHookEvent::PreToolUse => {
                lock(&self.helpers)
                    .get(&input.thread_id)
                    .map(|stopped| CodexHookAnswer::Deny {
                        reason: stopped.reason.sentence(),
                    })
            }
            CodexHookEvent::PostToolUse => None,
        };
        Box::pin(std::future::ready(Ok(answer)))
    }
}

impl CodexDriver {
    /// Stops the helper `params.subagent_id` names, whose id is its own conversation's, by
    /// interrupting that conversation's running turn, and marks it so each turn it starts later is
    /// interrupted at its start; a session with no live conversation or a helper running no turn
    /// is left as it is. Fails as the service's requests do.
    pub(crate) async fn stop_helper_at_token_limit(
        &self,
        params: HelperTokenLimitParams,
    ) -> Result<(), DriverError> {
        self.stopped_helpers.stop(
            params.session_id,
            params.subagent_id.as_str(),
            HelperStopReason::TokenLimit,
        );
        let Some(conversation) = self.views.conversation(params.session_id) else {
            return Ok(());
        };
        let connection = conversation.service.connection()?;
        stop_codex_helper_turn(&connection, params.subagent_id.as_str()).await?;
        Ok(())
    }
}

/// Interrupts the running turn of the helper conversation `helper_thread_id`, read as its newest
/// turn; a helper whose newest turn has ended, or that no message has reached yet, is left as it
/// is.
async fn stop_codex_helper_turn(
    connection: &CodexAppServerConnection,
    helper_thread_id: &str,
) -> Result<(), CodexError> {
    let Some(newest) = read_codex_newest_turn(connection, helper_thread_id).await? else {
        return Ok(());
    };
    let status =
        read_codex_object::<ListedTurnStatus>(newest.turn.get()).and_then(|listed| listed.status);
    if status.as_deref().and_then(CodexTurnStatus::read) != Some(CodexTurnStatus::InProgress) {
        return Ok(());
    }
    interrupt_codex_turn(connection, helper_thread_id, &newest.id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    use super::{CodexStoppedHelpers, stop_codex_helper_turn};
    use crate::driver::codex::hooks::server::{
        CodexHookAnswer, CodexHookCall, CodexHookDispatch, CodexHookEvent,
    };
    use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
    use crate::driver::codex::transport::connection::CodexConnectionHandlers;
    use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;
    use crate::driver::run_control::HelperStopReason;
    use crate::driver::test_registry::new_session_id;
    use crate::run::delivery::RunSetupRefusal;

    /// The largest message the scripted connection takes, far above any a test sends.
    const MESSAGE_LIMIT: usize = 1 << 20;

    /// The helper's own conversation, which is its id.
    const HELPER_THREAD: &str = "helper-thread";

    /// The helper's running turn.
    const HELPER_TURN: &str = "helper-turn";

    // A helper running a turn has that turn interrupted on its own conversation, and only that
    // one; a helper whose newest turn ended, or that no message has reached yet, is sent no
    // interrupt and its stop succeeds. The last case is killed by reading Codex's refusal for a
    // conversation with no turn as a failed stop.
    #[rstest]
    #[case::running(
        json!({ "result": { "data": [{ "id": HELPER_TURN, "status": "inProgress" }] } }),
        true
    )]
    #[case::ended(
        json!({ "result": { "data": [{ "id": HELPER_TURN, "status": "completed" }] } }),
        false
    )]
    #[case::no_turn_yet(
        json!({
            "error": { "code": -32600, "message": "thread helper-thread is not materialized yet" }
        }),
        false
    )]
    #[tokio::test]
    async fn interrupts_only_the_running_turn_of_the_helpers_own_conversation(
        #[case] answer: serde_json::Value,
        #[case] is_interrupted: bool,
    ) {
        let (events, _frames) = CodexDetachedFrames::new();
        let (connection, mut script) = connect_scripted_service(
            MESSAGE_LIMIT,
            CodexConnectionHandlers {
                events,
                responder: None,
            },
        );
        let stop = tokio::spawn(async move {
            let stopped = stop_codex_helper_turn(&connection, HELPER_THREAD).await;
            (connection, stopped)
        });

        let list = script.next_sent().await;
        assert_eq!(list["method"], "thread/turns/list");
        assert_eq!(list["params"]["threadId"], HELPER_THREAD);
        assert_eq!(list["params"]["limit"], 1);
        let mut reply = answer;
        reply["id"] = list["id"].clone();
        script.send(&reply);

        if is_interrupted {
            let interrupt = script.next_sent().await;
            assert_eq!(interrupt["method"], "turn/interrupt");
            assert_eq!(
                interrupt["params"],
                json!({ "threadId": HELPER_THREAD, "turnId": HELPER_TURN })
            );
            script.answer(&interrupt, &json!({}));
        }
        let (_connection, stopped) = stop.await.expect("the stop ran");
        stopped.expect("the helper's stop is answered");
        assert!(
            script.sent.try_recv().is_err(),
            "nothing else is sent to the service"
        );
    }

    /// The lead's own conversation.
    const LEAD_THREAD: &str = "lead-thread";

    // One hook call of `event` on `thread_id`, through a dispatch point whose only answerer is
    // the stopped helpers; the arguments name the lead's conversation as the session, so only
    // `_meta` tells a helper's call.
    async fn hook_call(
        stopped: &Arc<CodexStoppedHelpers>,
        event: CodexHookEvent,
        thread_id: &str,
    ) -> Option<CodexHookAnswer> {
        let event_name = match event {
            CodexHookEvent::PreToolUse => "PreToolUse",
            CodexHookEvent::PostToolUse => "PostToolUse",
        };
        let call = CodexHookCall {
            arguments: Map::from_iter([
                ("hook_event_name".to_owned(), Value::from(event_name)),
                ("session_id".to_owned(), Value::from(LEAD_THREAD)),
            ]),
            meta: Map::from_iter([("threadId".to_owned(), Value::from(thread_id))]),
        };
        CodexHookDispatch::new(vec![Arc::clone(stopped) as _])
            .answer(event, call, &CancellationToken::new())
            .await
    }

    fn setup_refused(is_posture_rejection: bool) -> HelperStopReason {
        HelperStopReason::SetupRefused {
            refusal: RunSetupRefusal {
                cause: "the writable root '/gone/repo.git' could not be resolved".to_owned(),
                is_posture_rejection,
            },
        }
    }

    // A stopped helper's every pre-tool call is denied with its stop's sentence, which names the
    // session's level only for a posture rejection, while the lead's calls and the helper's
    // post-tool calls pass, and a forgotten session's helper passes again. Killed by a stop that
    // keeps no reason, by an answer keyed off another conversation, and by a setup refusal worded
    // as a level that cannot run.
    #[rstest]
    #[case::token_limit(HelperStopReason::TokenLimit, false)]
    #[case::posture_refused(setup_refused(true), true)]
    #[case::setup_refused(setup_refused(false), false)]
    #[tokio::test]
    async fn a_stopped_helpers_tool_calls_are_denied_with_its_reason(
        #[case] reason: HelperStopReason,
        #[case] names_the_level: bool,
    ) {
        let stopped = Arc::new(CodexStoppedHelpers::new(TaskTracker::new()));
        let session_id = new_session_id();
        let sentence = reason.sentence();
        stopped.stop(session_id, HELPER_THREAD, reason);

        let denied = Some(CodexHookAnswer::Deny {
            reason: sentence.clone(),
        });
        for _ in 0..2 {
            assert_eq!(
                hook_call(&stopped, CodexHookEvent::PreToolUse, HELPER_THREAD).await,
                denied
            );
        }
        assert_eq!(sentence.contains("permission level"), names_the_level);
        assert_eq!(
            hook_call(&stopped, CodexHookEvent::PreToolUse, LEAD_THREAD).await,
            Some(CodexHookAnswer::Pass)
        );
        assert_eq!(
            hook_call(&stopped, CodexHookEvent::PostToolUse, HELPER_THREAD).await,
            Some(CodexHookAnswer::Pass)
        );
        stopped.forget_session(session_id);
        assert_eq!(
            hook_call(&stopped, CodexHookEvent::PreToolUse, HELPER_THREAD).await,
            Some(CodexHookAnswer::Pass)
        );
    }
}
