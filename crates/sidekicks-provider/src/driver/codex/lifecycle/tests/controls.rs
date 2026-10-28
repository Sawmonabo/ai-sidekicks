//! A live session's level and mode moves Codex refuses, and a settle as the session opens and while
//! it comes back, with the resume its service's return owes it, through the driver.

use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

use super::super::service_events::CodexDriverServiceEvents;
use super::{LiveCodexSession, driver_holding};
use crate::driver::codex::service::supervisor::events::{
    CodexServiceEvents as _, CodexServiceRecoveryCause,
};
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::errors::CodexSessionSlotState;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, create_session_params};
use crate::driver::contract::{DriverError, SessionProcessState};
use crate::driver::session_control::{UpdatePermissionLevelParams, UpdateSessionModeParams};
use crate::driver::test_registry::new_session_id;
use crate::run::posture::compose_execution_posture;

/// How long a test waits before it counts a settle or a move as stuck.
const SETTLE_BOUND: Duration = Duration::from_secs(10);

/// A move of a live session's settings.
#[derive(Clone, Copy, Debug)]
enum SettingMove {
    Level,
    Mode,
}

// Killed by answering Codex's refusal of a level or a mode as a provider failure rather than as
// the setting not offered.
#[rstest]
#[case::level(SettingMove::Level, RefusalCode::SessionPermissionLevelNotOffered)]
#[case::mode(SettingMove::Mode, RefusalCode::SessionModeNotOffered)]
#[tokio::test]
async fn a_level_or_mode_codex_refuses_is_refused_as_not_offered(
    #[case] setting: SettingMove,
    #[case] code: RefusalCode,
) {
    let LiveCodexSession {
        driver,
        session_id,
        mut scripted,
        ..
    } = LiveCodexSession::idle().await;
    let moving = async {
        match setting {
            SettingMove::Level => {
                driver
                    .update_permission_level(UpdatePermissionLevelParams {
                        session_id,
                        execution_posture: compose_execution_posture(
                            PermissionLevel::Readonly,
                            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
                        ),
                    })
                    .await
            }
            SettingMove::Mode => {
                driver
                    .update_session_mode(UpdateSessionModeParams {
                        session_id,
                        mode: SessionMode::Plan,
                    })
                    .await
            }
        }
    };
    let refusing = async {
        let sent = scripted.next_request("thread/settings/update").await;
        scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": sent["id"],
            "error": {"code": -32600, "message": "this setting is not available"},
        }));
    };

    let (moved, ()) = tokio::time::timeout(SETTLE_BOUND, async { tokio::join!(moving, refusing) })
        .await
        .expect("the move settles");

    let Err(DriverError::Refused(refusal)) = moved else {
        panic!("a refused setting is refused, not {moved:?}");
    };
    assert_eq!(refusal.code, code);
}

/// What brings a live session back while a settle waits.
#[derive(Clone, Copy, Debug)]
enum ComingBack {
    /// An establishment claimed on the session.
    Establishment,
    /// The session's service reconnecting.
    Service,
}

// Killed by a settle that does not wait for an establishment in flight on its session, or for its
// service on its way back: it answers at once, so a run would be bound on the conversation about
// to change.
#[rstest]
#[case::establishment(ComingBack::Establishment)]
#[case::service(ComingBack::Service)]
#[tokio::test]
async fn a_settle_waits_until_its_session_came_back_live(#[case] coming_back: ComingBack) {
    let LiveCodexSession {
        driver,
        session_id,
        scripted,
        ..
    } = LiveCodexSession::idle().await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let (establishing, connection) = match coming_back {
        ComingBack::Establishment => (
            Some(
                parts
                    .slots
                    .claim_establishing(session_id)
                    .await
                    .expect("the session's slot is claimed"),
            ),
            None,
        ),
        ComingBack::Service => (None, Some(scripted.publish_reconnecting())),
    };
    assert_eq!(
        driver.session_process_state(session_id),
        SessionProcessState::Restarting
    );

    let mut settling = pin!(driver.settle_session(session_id));
    let early = tokio::time::timeout(Duration::from_millis(100), &mut settling).await;
    assert!(
        early.is_err(),
        "the settle waits for the session: {early:?}"
    );
    drop(establishing);
    if let Some(connection) = connection {
        scripted.publish_up(connection);
    }

    tokio::time::timeout(SETTLE_BOUND, settling)
        .await
        .expect("the settle answers")
        .expect("the session settles live");
}

// Killed by showing a new session's view only once its task first ran: a settle as soon as the
// create returns reads the session down and refuses its first run.
#[tokio::test]
async fn a_settle_as_soon_as_a_session_is_created_answers_live() {
    let mut scripted = start_scripted_codex_service();
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let driver = driver_holding(&scripted, folder.path());
    let session_id = new_session_id();
    let mut creating = pin!(driver.create_session(create_session_params(session_id)));

    let created = tokio::time::timeout(SETTLE_BOUND, async {
        loop {
            tokio::select! {
                created = &mut creating => break created,
                sent = scripted.script.next_sent() => {
                    let reply = if sent["method"] == "thread/start" {
                        json!({
                            "thread": {"id": TEST_THREAD, "sessionId": "codex-session"},
                            "activePermissionProfile": {
                                "id": sent["params"]["config"]["default_permissions"],
                            },
                        })
                    } else {
                        json!({})
                    };
                    scripted.script.answer(&sent, &reply);
                }
            }
        }
    })
    .await
    .expect("the create answers");
    created.expect("the session is created");
    // Polled once with no yield before it, so the session's task has not run yet.
    let settled = driver.settle_session(session_id).now_or_never();

    assert!(
        matches!(settled, Some(Ok(()))),
        "a session reads live as soon as its create returns: {settled:?}"
    );
}

// Killed by marking the resumes a service's return owes on the recovery's own task: until that
// task ran, the session would read live on a conversation its service has not resumed yet.
#[tokio::test]
async fn a_service_back_owes_its_sessions_their_resume_as_its_event_arrives() {
    let LiveCodexSession {
        driver,
        session_id,
        scripted,
        ..
    } = LiveCodexSession::idle().await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let events = CodexDriverServiceEvents::new(Arc::clone(&driver.link));

    events.recovered(&scripted.service, CodexServiceRecoveryCause::Reconnect);

    // Read with no yield after the event, before the recovery's task first runs.
    assert_eq!(
        parts.slots.describe_holder(session_id),
        Some(CodexSessionSlotState::Establishing)
    );
}
