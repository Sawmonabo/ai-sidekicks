//! A Codex helper stopped alone at its token limit: its own conversation's running turn is
//! interrupted, so the lead's turn, on its own conversation, goes on.

use serde::Deserialize;

use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::read_codex_newest_turn;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::DriverError;
use crate::driver::run_control::HelperTokenLimitParams;

// The member of a listed turn this stop reads.
#[derive(Deserialize)]
struct ListedTurnStatus {
    status: Option<String>,
}

impl CodexDriver {
    /// Stops the helper `params.subagent_id` names, whose id is its own conversation's, by
    /// interrupting that conversation's running turn; a session with no live conversation or a
    /// helper running no turn is left as it is. Fails as the service's requests do.
    pub(crate) async fn stop_helper_at_token_limit(
        &self,
        params: HelperTokenLimitParams,
    ) -> Result<(), DriverError> {
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
    use rstest::rstest;
    use serde_json::json;

    use super::stop_codex_helper_turn;
    use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
    use crate::driver::codex::transport::connection::CodexConnectionHandlers;
    use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;

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
    #[case::running(json!({ "result": { "data": [{ "id": HELPER_TURN, "status": "inProgress" }] } }), true)]
    #[case::ended(json!({ "result": { "data": [{ "id": HELPER_TURN, "status": "completed" }] } }), false)]
    #[case::no_turn_yet(
        json!({ "error": { "code": -32600, "message": "thread helper-thread is not materialized yet" } }),
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
}
