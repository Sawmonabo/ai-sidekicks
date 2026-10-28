use serde_json::json;

use crate::driver::codex::session::fork::establish_codex_fork;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns,
};

// Kills: pointing the binding at the fork after the conversation the session leaves is let go.
#[tokio::test(start_paused = true)]
async fn a_fork_rebinds_before_it_lets_go_of_the_conversation_left() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    session.task.record.binding_id = Some(binding_id.clone());
    session.task.record.is_config_fork_owed = true;
    let settings = session.task.record.thread_settings.clone();
    let (mut task, dependencies) = session.task.split();
    let fork = establish_codex_fork(
        &mut task,
        &dependencies.forks,
        None,
        Some(binding_id.clone()),
    );
    let script = &mut session.scripted.script;
    let database = &session.database;
    let answer = async {
        let forked = script.next_sent().await;
        assert_eq!(forked["method"], "thread/fork");
        assert_eq!(forked["params"]["threadId"], TEST_THREAD);
        script.answer(&forked, &fork_reply("thread-2", &settings));
        let mode = script.next_sent().await;
        assert_eq!(mode["method"], "thread/settings/update");
        script.answer(&mode, &json!({}));
        let turns = script.next_sent().await;
        assert_eq!(turns["method"], "thread/turns/list");
        script.answer(&turns, &no_turns());
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "thread/backgroundTerminals/list");
        assert_eq!(listed["params"]["threadId"], TEST_THREAD);
        let resume_handle =
            crate::runtime_binding::store::read_binding(&database.reader(), &binding_id)
                .expect("the binding reads")
                .expect("the binding has a row")
                .resume_handle;
        assert_eq!(
            resume_handle.as_deref(),
            Some("thread-2"),
            "the binding names the fork before the conversation left is let go"
        );
        script.answer(&listed, &json!({"data": []}));
        let unsubscribed = script.next_sent().await;
        assert_eq!(unsubscribed["method"], "thread/unsubscribe");
        assert_eq!(unsubscribed["params"]["threadId"], TEST_THREAD);
        script.answer(&unsubscribed, &json!({"status": "unsubscribed"}));
    };
    let (forked, ()) = tokio::join!(fork, answer);
    forked.expect("the session moves onto the fork");
    assert_eq!(session.task.record.thread_id, "thread-2");
    assert!(!session.task.record.is_config_fork_owed);
}
