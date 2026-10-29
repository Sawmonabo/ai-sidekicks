//! The status sink's leg of each session on a Codex service, ended once as the service's process
//! ends.

use std::sync::Arc;
use std::time::Duration;

use super::super::CodexDriver;
use super::super::intake::CodexSessionIntake;
use super::answer_stopping_request;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::context_reading::CodexFixedStart;
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::lifecycle_call::let_go_codex_session_record;
use crate::driver::codex::session::test_fixture::open_test_record;
use crate::driver::codex::session::test_fixture::status_sink::CountingStatusSink;
use crate::driver::test_registry::{new_run_id, new_session_id, test_driver_services};

/// How long the exit and the let-go may take before the test counts them as stuck.
const STEP_BOUND: Duration = Duration::from_secs(10);

// Real time under a bound, the let-go waiting on the service's answers. Two sessions on one
// service, the first with two live turns of two runs. Killed by dropping the leg's end from the
// exit's drop of a session's turns (a count of 0), by ending it once per dropped turn (2 on the
// first), and by ending it without letting the sink go, since the record's let-go after the exit
// would end the same leg again.
#[tokio::test]
async fn a_service_exit_ends_each_attached_sessions_status_leg_once() {
    let mut scripted = start_scripted_codex_service();
    let driver = CodexDriver::new(&test_driver_services());
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let mut sessions = Vec::new();
    for live_turns in [2, 0] {
        let session_id = new_session_id();
        let (inbound, receiver) = codex_session_inbound(session_id);
        parts
            .slots
            .claim_establishing(session_id)
            .await
            .expect("the session's slot is free")
            .install(inbound.clone());
        let (mut record, routing) = open_test_record(
            &scripted,
            session_id,
            inbound.clone(),
            &parts.delivery,
            parts.pending_compactions.clone(),
        )
        .await;
        for turn in 0..live_turns {
            record.add_active_turn(format!("turn-{turn}"), new_run_id());
        }
        let sink = Arc::new(CountingStatusSink::default());
        record.on_mcp_server_status = Some(Arc::clone(&sink) as _);
        let intake = CodexSessionIntake::new(
            record,
            routing,
            Arc::clone(&parts),
            CodexFixedStart::FirstRequest,
        );
        driver
            .tasks
            .spawn(intake.run(receiver, CodexRoutedFrames::default()));
        sessions.push((inbound, sink));
    }

    tokio::time::timeout(
        STEP_BOUND,
        parts.recovery.end_turns_on_exit(&scripted.service, None),
    )
    .await
    .expect("the exit's turns end within the bound");
    let ends: Vec<usize> = sessions.iter().map(|(_, sink)| sink.ends()).collect();
    assert_eq!(ends, [1, 1]);

    let (inbound, sink) = &sessions[0];
    let let_go = let_go_codex_session_record(inbound, CodexRecordExit::SessionContinues);
    tokio::pin!(let_go);
    let deadline = tokio::time::sleep(STEP_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the let-go ends within its bound"),
            () = &mut let_go => break,
            sent = scripted.script.next_sent() => answer_stopping_request(&scripted.script, &sent),
        }
    }
    assert_eq!(sink.ends(), 1, "the let-go ended the leg the exit ended");
}
