//! A session's process ending: the restarts after an exit, a move to a new build, and the held
//! presses each end lets go.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;

use super::{RESTART_WAITS_PASSED, resume_params, start_params};
use crate::provider::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::provider::driver::claude::session::scripted::daemon_services::PortCall;
use crate::provider::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::provider::driver::claude::session::scripted::{binding_id, mint_run_id, settle};
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::provider::driver::session_control::{
    CloseSessionParams, DriverResumeResult, ProviderBuildChange,
};

// Killed by restarting past a full crash window: the fifth exit inside it reports the loop and
// starts nothing.
#[tokio::test(start_paused = true)]
async fn a_full_crash_window_reports_the_loop_and_restarts_nothing() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let mut current = fixture.next_start().await;
    for _ in 0..4 {
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        ScriptedDriver::exit(&current);
        current = fixture.next_start().await;
    }
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    ScriptedDriver::exit(&current);
    tokio::time::sleep(RESTART_WAITS_PASSED).await;

    assert!(fixture.starts.take_started().is_empty());
    assert_eq!(fixture.relaunches.taken(), vec![(session_id, true); 4]);
    let notices = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionNotice")
        .count();
    assert_eq!(notices, 1);
}

// Killed by a waited restart that resumes a session a create or resume took meanwhile: it would
// fight for the slot and report a failed relaunch over the session the person brought back.
#[tokio::test(start_paused = true)]
async fn a_restart_whose_slot_was_taken_during_its_wait_does_nothing() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let first = fixture.next_start().await;
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    ScriptedDriver::exit(&first);
    // The first restart waits nothing; the second waits a second.
    let second = fixture.next_start().await;
    ScriptedDriver::exit(&second);
    settle().await;
    let taken_by_resume = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&taken_by_resume));
    let resumed = fixture
        .driver
        .resume_session(resume_params(session_id))
        .await
        .expect("the resume answers");
    assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
    assert_eq!(fixture.starts.take_started().len(), 1);

    tokio::time::sleep(RESTART_WAITS_PASSED).await;

    assert!(fixture.starts.take_started().is_empty());
    assert_eq!(fixture.relaunches.taken(), vec![(session_id, true)]);
    assert!(!fixture.driver.starts_process(session_id));
}

// Killed by moving a busy session to the new build at once, which would end its running reply,
// and by never moving it once the reply ends.
#[tokio::test(start_paused = true)]
async fn a_build_move_on_a_busy_session_waits_for_its_turn_to_settle() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let first = fixture.next_start().await;
    fixture
        .driver
        .start_run(start_params(session_id, mint_run_id()))
        .await
        .expect("the run starts");
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    fixture
        .driver
        .move_to_provider_build(ProviderBuildChange {
            from_version: "2.1.0".to_owned(),
            to_version: "2.2.0".to_owned(),
        })
        .await
        .expect("the move is taken");
    settle().await;
    assert!(fixture.starts.take_started().is_empty());

    fixture.end_turn(&first, session_id);
    let moved = fixture.next_start().await;

    assert!(matches!(
        moved.conversation,
        ClaudeConversationStart::Resume { .. }
    ));
    assert_eq!(
        fixture.relaunches.first_reported().await,
        vec![(session_id, true)]
    );
}

// Killed by a relaunch that leaves the advisor unpicked again, so a later change to the person's
// own Claude Code setting reaches a running session, by an advisor resolved to none read back as
// no pick, and by a start that sends an advisor no one picked.
#[rstest]
#[case::model(ClaudeSessionAdvisor::Model("opus".to_owned()))]
#[case::off(ClaudeSessionAdvisor::Off)]
#[tokio::test(start_paused = true)]
async fn a_relaunch_keeps_the_advisor_claude_code_resolved_at_the_start(
    #[case] resolved: ClaudeSessionAdvisor,
) {
    let fixture = ScriptedDriver::new();
    fixture.starts.script_resolved_advisor(resolved.clone());
    fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let first = fixture.next_start().await;
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    ScriptedDriver::exit(&first);
    let relaunched = fixture.next_start().await;

    assert_eq!(first.advisor, ClaudeSessionAdvisor::Unpicked);
    assert_eq!(relaunched.advisor, resolved);
}

// How a test ends a session's process.
#[derive(Clone, Copy, Debug)]
enum ProcessEnd {
    ExitWhileIdle,
    Close,
    CloseOfQuarantined,
    BuildMove,
}

// Killed by letting go only the presses of runs still bound when the process ends, which keeps a
// press held on a binding whose run already ended, by an end that lets go none, and by a close of
// a process an abandoned close quarantined that forgets the bindings it served.
#[rstest]
#[case::exit_while_idle(ProcessEnd::ExitWhileIdle)]
#[case::close(ProcessEnd::Close)]
#[case::close_of_quarantined(ProcessEnd::CloseOfQuarantined)]
#[case::build_move(ProcessEnd::BuildMove)]
#[tokio::test(start_paused = true)]
async fn a_process_end_lets_go_the_held_presses_of_every_binding_it_served(
    #[case] end: ProcessEnd,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    let first = fixture.next_start().await;
    fixture
        .driver
        .start_run(start_params(session_id, mint_run_id()))
        .await
        .expect("the run starts");
    fixture.end_turn(&first, session_id);
    settle().await;
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    match end {
        ProcessEnd::ExitWhileIdle => ScriptedDriver::exit(&first),
        ProcessEnd::Close => fixture
            .driver
            .close_session(CloseSessionParams { session_id })
            .await
            .expect("the close succeeds"),
        ProcessEnd::CloseOfQuarantined => {
            let held = channel.hold_next_close();
            let abandoned = tokio::time::timeout(
                Duration::from_millis(50),
                fixture
                    .driver
                    .close_session(CloseSessionParams { session_id }),
            )
            .await;
            assert!(abandoned.is_err(), "the held close is abandoned");
            drop(held);
            let released = PortCall::PressesReleased(binding_id("lead"));
            assert!(!fixture.ports.calls().contains(&released));
            fixture
                .driver
                .close_session(CloseSessionParams { session_id })
                .await
                .expect("the quarantined process's close succeeds");
        }
        ProcessEnd::BuildMove => fixture
            .driver
            .move_to_provider_build(ProviderBuildChange {
                from_version: "2.1.0".to_owned(),
                to_version: "2.2.0".to_owned(),
            })
            .await
            .expect("the move is taken"),
    }

    let released = PortCall::PressesReleased(binding_id("lead"));
    ScriptedDriver::wait_for(|| fixture.ports.calls().contains(&released)).await;
}
