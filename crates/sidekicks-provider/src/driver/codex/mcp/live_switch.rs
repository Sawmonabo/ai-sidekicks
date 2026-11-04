//! A Codex session's own switch of its tool servers on its live conversation: Codex takes a
//! changed server table only through a start, resume or fork, so the record takes the set and owes
//! a fork onto it, which runs at once while the session is idle and once its running turn settles
//! otherwise.

use std::sync::Arc;

use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::mcp_server::session_switch::McpSessionSwitch;
use crate::driver::session_control::SessionToolServer;

/// Puts `tool_servers` on `record`, which every resume and fork composes its table from, and owes
/// the fork onto it through `config_forks`. Answers `Applied` when the session is idle, the fork
/// then running, for the caller to wait on; `AtNextTurn` while a turn runs, starts or still ends,
/// the fork running once it settles, and while the service is coming back, the fork only marked
/// owed, as the resume carries the set. Called on the session's task.
pub(crate) fn switch_codex_session_servers(
    record: &mut CodexSessionRecord,
    config_forks: &Arc<CodexConfigForks>,
    tool_servers: Vec<SessionToolServer>,
) -> McpSessionSwitch {
    record.thread_settings.tool_servers = tool_servers;
    if record.service.is_coming_back() {
        record.is_config_fork_owed = true;
        return McpSessionSwitch::AtNextTurn;
    }
    let is_turn_in_flight = record.is_turn_in_flight(None);
    config_forks.owe(record);
    if is_turn_in_flight {
        McpSessionSwitch::AtNextTurn
    } else {
        McpSessionSwitch::Applied
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};

    use super::switch_codex_session_servers;
    use crate::driver::codex::DESCRIPTOR;
    use crate::driver::codex::session::calls::CodexSessionTask;
    use crate::driver::codex::session::fork::config_change::run_codex_config_fork;
    use crate::driver::codex::session::test_fixture::{
        TEST_THREAD, TestCodexSession, fork_reply, no_turns,
    };
    use crate::driver::mcp_server::session_switch::McpSessionSwitch;
    use crate::driver::session_control::SessionToolServer;
    use crate::driver::test_registry::new_run_id;

    fn tracker(is_enabled: bool) -> SessionToolServer {
        SessionToolServer {
            binding: McpServerBindingRef::User {
                provider: DESCRIPTOR.provider_id(),
                server_name: McpServerName::new("tracker".to_owned()).expect("a server name"),
            },
            is_enabled,
        }
    }

    // A switch while the lead's turn runs waits for the turn: it answers `AtNextTurn`, owes the
    // fork and sends nothing; once the turn is gone the fork reads the config and forks with the
    // server switched off. Killed by forking under the running turn, by the record's set left
    // unchanged, and by the held switch never sent.
    #[tokio::test(start_paused = true)]
    async fn a_switch_while_the_lead_runs_forks_once_its_turn_settles() {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        let record = &mut session.task.record;
        record.binding_id = Some(binding_id);
        record.thread_settings.tool_servers = vec![tracker(true)];
        record
            .active_turns
            .push(("turn-1".to_owned(), new_run_id()));
        let config_forks = Arc::clone(&session.task.calls.runs.config_forks);

        let switched = switch_codex_session_servers(record, &config_forks, vec![tracker(false)]);

        assert_eq!(switched, McpSessionSwitch::AtNextTurn);
        assert!(record.is_config_fork_owed, "the fork is owed");
        assert_eq!(record.thread_settings.tool_servers, vec![tracker(false)]);
        let mut task = CodexSessionTask {
            record: &mut session.task.record,
            routing: &mut session.task.routing,
            waiters: &mut session.task.waiters,
        };
        let (forked, _) = run_codex_config_fork(&mut task, &session.task.calls.forks)
            .await
            .expect("a fork under a running turn waits");
        assert!(!forked, "no fork runs under the lead's turn");

        session.task.record.active_turns.clear();
        let settings = session.task.record.thread_settings.clone();
        let mut task = CodexSessionTask {
            record: &mut session.task.record,
            routing: &mut session.task.routing,
            waiters: &mut session.task.waiters,
        };
        let fork = run_codex_config_fork(&mut task, &session.task.calls.forks);
        let script = &mut session.scripted.script;
        let answer = async {
            // The first message since the switch is the fork's own read, so the switch sent none.
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.answer(
                &read,
                &json!({
                    "config": { "mcp_servers": { "tracker": { "command": "tracker-server" } } },
                    "origins": {},
                }),
            );
            let forked = script.next_sent().await;
            assert_eq!(forked["method"], "thread/fork");
            assert_eq!(
                forked["params"]["config"]["mcp_servers"]["tracker"],
                json!({ "enabled": false })
            );
            script.answer(&forked, &fork_reply("thread-2", &settings));
            let mode = script.next_sent().await;
            assert_eq!(mode["method"], "thread/settings/update");
            script.answer(&mode, &json!({}));
            let turns = script.next_sent().await;
            assert_eq!(turns["method"], "thread/turns/list");
            script.answer(&turns, &no_turns());
            let listed = script.next_sent().await;
            assert_eq!(listed["method"], "thread/backgroundTerminals/list");
            script.answer(&listed, &json!({ "data": [] }));
            let unsubscribed = script.next_sent().await;
            assert_eq!(unsubscribed["method"], "thread/unsubscribe");
            assert_eq!(unsubscribed["params"]["threadId"], TEST_THREAD);
            script.answer(&unsubscribed, &json!({ "status": "unsubscribed" }));
        };
        let (forked, ()) = tokio::join!(fork, answer);

        let (forked, _) = forked.expect("the session moves onto the fork");
        assert!(forked, "the held switch is sent once the turn settles");
        assert_eq!(session.task.record.thread_id, "thread-2");
        assert!(!session.task.record.is_config_fork_owed);
    }
}
