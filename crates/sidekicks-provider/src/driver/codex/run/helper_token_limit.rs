//! A Codex helper stopped alone at its token limit: its own conversation's running turn is
//! interrupted, so the lead's turn, on its own conversation, goes on.

use serde::Deserialize;

use crate::driver::codex::app_server_protocol::ThreadTurnsListParams;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::DriverError;
use crate::driver::run_control::HelperTokenLimitParams;

const THREAD_TURNS_LIST_METHOD: &str = "thread/turns/list";

// The members of a `thread/turns/list` page this stop reads.
#[derive(Deserialize)]
struct NewestTurnPage {
    data: Vec<ListedTurn>,
}

#[derive(Deserialize)]
struct ListedTurn {
    id: String,
    status: String,
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

/// Interrupts the running turn of the helper conversation `helper_thread_id`, read as the newest
/// turn `thread/turns/list` names; a helper whose newest turn has ended is left as it is.
async fn stop_codex_helper_turn(
    connection: &CodexAppServerConnection,
    helper_thread_id: &str,
) -> Result<(), CodexError> {
    let params = ThreadTurnsListParams {
        cursor: None,
        items_view: None,
        limit: Some(1),
        // Codex lists the newest turn first by default.
        sort_direction: None,
        thread_id: helper_thread_id.to_owned(),
    };
    let reply = connection
        .request(THREAD_TURNS_LIST_METHOD, &params)
        .await?;
    let page =
        read_codex_object::<NewestTurnPage>(reply.get()).ok_or_else(|| CodexError::Transport {
            detail: format!(
                "The Codex app-server \"{THREAD_TURNS_LIST_METHOD}\" reply carried no page of turns."
            ),
            cause: None,
        })?;
    let Some(newest) = page.data.into_iter().next() else {
        return Ok(());
    };
    if CodexTurnStatus::read(&newest.status) != Some(CodexTurnStatus::InProgress) {
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
    // one; a helper whose newest turn ended is sent no interrupt.
    #[rstest]
    #[case::running("inProgress", true)]
    #[case::ended("completed", false)]
    #[tokio::test]
    async fn interrupts_only_the_running_turn_of_the_helpers_own_conversation(
        #[case] status: &str,
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
        script.answer(
            &list,
            &json!({ "data": [{ "id": HELPER_TURN, "status": status }], "nextCursor": null }),
        );

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
