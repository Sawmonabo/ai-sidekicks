//! A session's level and mode moves reached through the driver: the person's own and one that
//! follows a mode Claude Code reported running.

use std::sync::Arc;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_std::mutex_lock::lock;

use crate::driver::CommandSandboxAvailability;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::contract::DriverError;
use crate::driver::session_control::{UpdatePermissionLevelParams, UpdateSessionModeParams};
use crate::run::posture::compose_execution_posture;

// Killed by answering Claude Code's refusal of a mode as an internal failure.
#[tokio::test(start_paused = true)]
async fn a_mode_claude_code_refuses_is_refused_as_not_offered() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    channel.answer("set_permission_mode", ScriptedAnswer::Refused);

    let moved = fixture
        .driver
        .update_session_mode(UpdateSessionModeParams {
            session_id,
            mode: SessionMode::Plan,
            is_provider_reported: false,
        })
        .await;

    let Err(DriverError::Refused(refusal)) = moved else {
        panic!("a refused mode is refused, not {moved:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionModeNotOffered);
}

// Killed by a `set_permission_mode` sent for a mode Claude Code runs already, by the sandbox
// omitted from the flag settings or sent without failing closed, by the notice dropped, and by
// the reported mode not taken as the one the process runs.
#[tokio::test]
async fn a_reported_sandboxed_level_the_sandbox_cannot_run_fails_closed_and_is_told() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let sent_before = channel.control_requests().len();
    let work_folder = FilesystemPath::new(fixture.work.to_string_lossy().into_owned())
        .expect("the work folder is a path");

    parts
        .session_controls
        .follow_reported_level(
            &live,
            &UpdatePermissionLevelParams {
                session_id,
                execution_posture: compose_execution_posture(
                    PermissionLevel::Sandboxed,
                    work_folder,
                ),
                is_provider_reported: true,
            },
            false,
            &[],
        )
        .await
        .expect("the reported level is followed");

    let sent = channel.control_requests().split_off(sent_before);
    assert!(
        sent.iter()
            .all(|request| request["subtype"] != "set_permission_mode")
    );
    let flag_settings: Vec<_> = sent
        .iter()
        .filter(|request| request["subtype"] == "apply_flag_settings")
        .collect();
    assert_eq!(flag_settings.len(), 1);
    let sandbox = &flag_settings[0]["settings"]["sandbox"];
    assert_eq!(sandbox["enabled"], true);
    assert_eq!(sandbox["failIfUnavailable"], true);
    let unavailable: Vec<_> = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionNotice")
        .filter_map(|delivery| delivery.payload)
        .filter(|notice| notice["kind"] == "levelUnavailable")
        .collect();
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0]["level"], "sandboxed");
    live.permission_mode
        .note_report("dontAsk", "system", &live.admitted_provider_account_id);
    assert_eq!(live.permission_mode.reported_level(), None);
}

// A reported level moved through the driver sends no mode, takes the report as the mode the
// process runs, and tells the person where the sandbox cannot start at the session's place.
// Killed by moving a reported level as the person's own move, which drops the notice where the
// sandbox cannot start; the check runs the same sandbox read the driver makes, so on a system
// whose sandbox always starts the notice is rightly absent.
#[tokio::test]
async fn a_reported_level_moved_through_the_driver_is_followed_and_told() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let legs = &live.spawn_bound_legs;
    let can_run_sandbox = matches!(
        DESCRIPTOR.can_run_command_sandbox(&legs.spawn_environment, &legs.working_directory, &[]),
        Ok(CommandSandboxAvailability::Runs)
    );
    let sent_before = channel.control_requests().len();
    let work_folder = FilesystemPath::new(fixture.work.to_string_lossy().into_owned())
        .expect("the work folder is a path");

    fixture
        .driver
        .update_permission_level(UpdatePermissionLevelParams {
            session_id,
            execution_posture: compose_execution_posture(PermissionLevel::Sandboxed, work_folder),
            is_provider_reported: true,
        })
        .await
        .expect("the reported level is followed");

    let sent = channel.control_requests().split_off(sent_before);
    assert!(
        sent.iter()
            .all(|request| request["subtype"] != "set_permission_mode")
    );
    let unavailable = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionNotice")
        .filter_map(|delivery| delivery.payload)
        .filter(|notice| notice["kind"] == "levelUnavailable")
        .count();
    assert_eq!(unavailable, usize::from(!can_run_sandbox));
    live.permission_mode
        .note_report("dontAsk", "system", &live.admitted_provider_account_id);
    assert_eq!(live.permission_mode.reported_level(), None);
}

// A mode Claude Code reported running, Plan and then Build again, moves the session's mode with
// nothing sent and is taken as the mode the process runs, so the report reads as followed.
// Killed by sending the reported mode, and by not taking it as the mode the process runs.
#[tokio::test(start_paused = true)]
async fn a_reported_mode_is_followed_with_nothing_sent() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let sent_before = channel.control_requests().len();

    // At Ask, Build runs in `acceptEdits`.
    for (mode, word) in [
        (SessionMode::Plan, "plan"),
        (SessionMode::Build, "acceptEdits"),
    ] {
        fixture
            .driver
            .update_session_mode(UpdateSessionModeParams {
                session_id,
                mode,
                is_provider_reported: true,
            })
            .await
            .expect("the reported mode is followed");
        assert_eq!(lock(&live.settings).session_mode, mode);
        live.permission_mode
            .note_report(word, "system", &live.admitted_provider_account_id);
        assert_eq!(live.permission_mode.reported_level(), None, "{word}");
    }
    assert!(
        channel
            .control_requests()
            .split_off(sent_before)
            .iter()
            .all(|request| request["subtype"] != "set_permission_mode")
    );
}
