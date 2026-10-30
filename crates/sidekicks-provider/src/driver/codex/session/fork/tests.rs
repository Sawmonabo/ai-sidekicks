use std::sync::Arc;

use serde_json::json;

use crate::driver::codex::session::fork::establish_codex_fork;
use crate::driver::codex::session::test_fixture::relaunches::{
    RefusedRelaunchStep, TakenRelaunches,
};
use crate::driver::codex::session::test_fixture::status_sink::{
    CountingStatusSink, mcp_server_startup,
};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns,
};
use crate::driver::mcp_server::status::McpServerStatusProducer;
use crate::driver::ports::SessionRelaunchListener;
use crate::runtime_binding::resume::ResumeFunctionLegs;

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

// A fork onto another binding ends the leg the record held once, reports on legs of its own,
// opened under a binding minted for them so they share no pair with a leg still open, and
// forgets the startups the left conversation reported. Killed by keeping the predecessor's
// producer, by leaving its leg open, by opening the legs under the binding moved to or the one
// left, and by keeping the left conversation's startups.
#[tokio::test(start_paused = true)]
async fn a_fork_onto_another_binding_ends_the_left_leg_and_takes_its_own() {
    let mut session = TestCodexSession::start().await;
    let left_binding = session.record_binding().await;
    let new_binding = session.record_binding().await;
    let left_sink = Arc::new(CountingStatusSink::default());
    let new_sink = Arc::new(CountingStatusSink::default());
    session.task.record.binding_id = Some(left_binding.clone());
    session.task.record.on_mcp_server_status =
        Some(Arc::clone(&left_sink) as McpServerStatusProducer);
    session
        .task
        .handle(mcp_server_startup(TEST_THREAD, "github", "starting", None))
        .await;
    let opened = Arc::new(std::sync::Mutex::new(Vec::new()));
    let heard = Arc::clone(&opened);
    let relaunches: Arc<dyn SessionRelaunchListener> = Arc::new(TakenRelaunches {
        heard: Box::new(move |step| heard.lock().expect("the steps lock").push(step)),
        refused: RefusedRelaunchStep::Nothing,
        legs: ResumeFunctionLegs {
            on_mcp_server_status: Some(Arc::clone(&new_sink) as McpServerStatusProducer),
        },
    });
    session
        .task
        .calls
        .forks
        .session_relaunched
        .register(relaunches)
        .expect("the port registers once");
    let settings = session.task.record.thread_settings.clone();
    let (mut task, dependencies) = session.task.split();
    let fork = establish_codex_fork(
        &mut task,
        &dependencies.forks,
        None,
        Some(new_binding.clone()),
    );
    let script = &mut session.scripted.script;
    let answer = async {
        let forked = script.next_sent().await;
        assert_eq!(forked["method"], "thread/fork");
        script.answer(&forked, &fork_reply("thread-2", &settings));
        let mode = script.next_sent().await;
        assert_eq!(mode["method"], "thread/settings/update");
        script.answer(&mode, &json!({}));
        let turns = script.next_sent().await;
        assert_eq!(turns["method"], "thread/turns/list");
        script.answer(&turns, &no_turns());
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "thread/backgroundTerminals/list");
        script.answer(&listed, &json!({"data": []}));
        let unsubscribed = script.next_sent().await;
        assert_eq!(unsubscribed["method"], "thread/unsubscribe");
        script.answer(&unsubscribed, &json!({"status": "unsubscribed"}));
    };
    let (forked, ()) = tokio::join!(fork, answer);
    forked.expect("the session moves onto the fork");

    let opened = opened.lock().expect("the steps lock").clone();
    let [step] = opened.as_slice() else {
        panic!("one opening of legs, got {opened:?}");
    };
    assert!(step.starts_with("legs "), "{step}");
    assert_ne!(*step, format!("legs {new_binding:?}"));
    assert_ne!(*step, format!("legs {left_binding:?}"));
    assert!(
        session.task.record.mcp_server_startups.is_empty(),
        "the left conversation's startups were kept"
    );
    assert_eq!(left_sink.ends(), 1, "the left binding's leg ends once");
    assert_eq!(new_sink.ends(), 0, "the new binding's leg stays open");
    let held = session
        .task
        .record
        .on_mcp_server_status
        .as_ref()
        .expect("the record holds the new binding's producer");
    assert!(Arc::ptr_eq(
        held,
        &(Arc::clone(&new_sink) as McpServerStatusProducer)
    ));
}
