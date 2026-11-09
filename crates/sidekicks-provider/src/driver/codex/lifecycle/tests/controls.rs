//! A live session's level and mode moves Codex refuses, its switch of its tool servers, a settle
//! as the session opens and while it comes back, with the resume its service's return owes it, its
//! service's restart after the executor's end, and the helper move Codex has no form of, through
//! the driver.

use std::pin::pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::FutureExt as _;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

use super::super::service_events::CodexDriverServiceEvents;
use super::{LiveCodexSession, driver_holding};
use crate::command::helper_background::HelperBackgroundParams;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::driver::codex::service::supervisor::start::compose_exec_relay;
use crate::driver::codex::service::supervisor::test_service::{
    start_scripted_account_service_reporting_to, start_scripted_codex_service,
};
use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, create_session_params, fork_reply, no_turns, test_thread_settings,
};
use crate::driver::contract::ProviderDriver as _;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::mcp_server::session_switch::McpSessionSwitch;
use crate::driver::session_control::{
    SessionToolServer, UpdatePermissionLevelParams, UpdateSessionModeParams,
};
use crate::driver::test_registry::{new_run_id, new_session_id, test_driver_services};
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
                        is_provider_reported: false,
                    })
                    .await
            }
            SettingMove::Mode => {
                driver
                    .update_session_mode(UpdateSessionModeParams {
                        session_id,
                        mode: SessionMode::Plan,
                        is_provider_reported: false,
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

// Killed by a Codex driver that answers a helper's move at all but as the capability unsupported:
// each Codex helper is its own thread, so none holds the lead in the foreground.
#[tokio::test]
async fn a_helpers_move_to_the_background_is_refused_as_unsupported() {
    let driver = CodexDriver::new(&test_driver_services());

    let moved = driver
        .move_helper_to_background(HelperBackgroundParams {
            session_id: new_session_id(),
            run_id: new_run_id(),
            child_handle: ChildHandle::new("child-1".to_owned()).expect("a handle"),
            subagent_id: SubagentId::new("helper-1".to_owned()).expect("a helper id"),
        })
        .await;

    let Err(DriverError::Refused(refusal)) = moved else {
        panic!("a Codex helper's move is refused, not {moved:?}");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderCapabilityUnsupported);
}

// An idle session's switch moves it onto a fork and answers `Applied`; where Codex refuses the
// fork, the switch, its set kept and the fork still owed, answers `AtNextTurn` rather than a
// refusal. Killed by answering before the fork ran, and by answering a failed fork as a refusal.
#[rstest]
#[case::forked(true, McpSessionSwitch::Applied)]
#[case::fork_refused(false, McpSessionSwitch::AtNextTurn)]
#[tokio::test]
async fn an_idle_switch_answers_as_its_fork_ends(
    #[case] is_fork_answered: bool,
    #[case] answered: McpSessionSwitch,
) {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        mut scripted,
        ..
    } = LiveCodexSession::idle().await;
    let tracker_off = SessionToolServer {
        binding: McpServerBindingRef::User {
            provider: DESCRIPTOR.provider_id(),
            server_name: McpServerName::new("tracker".to_owned()).expect("a server name"),
        },
        is_enabled: false,
    };
    let switching = driver.switch_session_mcp_servers(session_id, run_id, vec![tracker_off]);
    let forking = async {
        let read = scripted.next_request("config/read").await;
        scripted
            .script
            .answer(&read, &json!({"config": {}, "origins": {}}));
        let forked = scripted.next_request("thread/fork").await;
        if !is_fork_answered {
            scripted.script.send(&json!({
                "jsonrpc": "2.0",
                "id": forked["id"],
                "error": {"code": -32603, "message": "the fork failed"},
            }));
            return;
        }
        let settings = test_thread_settings(session_id);
        scripted
            .script
            .answer(&forked, &fork_reply("thread-2", &settings));
        // The move onto the fork, up to the old conversation's unsubscribe.
        loop {
            let request = scripted.script.next_sent().await;
            match request["method"].as_str() {
                Some("thread/turns/list") => scripted.script.answer(&request, &no_turns()),
                Some("thread/backgroundTerminals/list") => {
                    scripted.script.answer(&request, &json!({"data": []}));
                }
                Some("thread/unsubscribe") => {
                    assert_eq!(request["params"]["threadId"], TEST_THREAD);
                    scripted
                        .script
                        .answer(&request, &json!({"status": "unsubscribed"}));
                    return;
                }
                Some(_) | None => scripted.script.answer(&request, &json!({})),
            }
        }
    };

    let (switched, ()) =
        tokio::time::timeout(SETTLE_BOUND, async { tokio::join!(switching, forking) })
            .await
            .expect("the switch settles");

    assert_eq!(switched.expect("the stored set is written"), answered);
}

// An idle session's `on` for a server Codex's own config switches off moves the session onto a
// fork whose table switches the server on by name over that `enabled = false`. Killed by the
// switch forking no conversation onto the set, and by a server the session switches on sent with
// Codex's own switch-off.
#[tokio::test]
async fn on_moves_an_idle_session_past_codexs_own_switch_off() {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        mut scripted,
        ..
    } = LiveCodexSession::idle().await;
    let tracker_on = SessionToolServer {
        binding: McpServerBindingRef::User {
            provider: DESCRIPTOR.provider_id(),
            server_name: McpServerName::new("tracker".to_owned()).expect("a server name"),
        },
        is_enabled: true,
    };
    let switching = driver.switch_session_mcp_servers(session_id, run_id, vec![tracker_on]);
    let forking = async {
        let read = scripted.next_request("config/read").await;
        scripted.script.answer(
            &read,
            &json!({
                "config": {"mcp_servers": {"tracker": {"command": "tracker", "enabled": false}}},
                "origins": {},
            }),
        );
        let forked = scripted.next_request("thread/fork").await;
        let tracker = forked["params"]["config"]["mcp_servers"]["tracker"].clone();
        scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": forked["id"],
            "error": {"code": -32603, "message": "the fork failed"},
        }));
        tracker
    };

    let (switched, tracker) =
        tokio::time::timeout(SETTLE_BOUND, async { tokio::join!(switching, forking) })
            .await
            .expect("the switch settles");

    assert_eq!(
        switched.expect("the stored set is written"),
        McpSessionSwitch::AtNextTurn
    );
    assert_eq!(tracker, json!({"enabled": true}));
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
    scripted.report_version("codex-cli 0.163.0");
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
                    } else if sent["method"] == "config/read" {
                        json!({"config": {}, "origins": {}})
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

// A service's events that reach the driver's only for an executor's end, once the driver is
// built on the service.
#[derive(Default)]
struct DriverExecutorEnds(OnceLock<CodexDriverServiceEvents>);

impl CodexServiceEvents for DriverExecutorEnds {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {}

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {}

    fn crash_loop(&self, _service: &Arc<CodexService>, _start_failure: Option<Arc<CodexError>>) {}

    fn start_failed(&self, _service: &Arc<CodexService>) {}

    fn rate_limits_observed(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}

    fn executor_ended(&self, service: &Arc<CodexService>) {
        if let Some(events) = self.0.get() {
            events.executor_ended(service);
        }
    }
}

// Driven through the callback the service's relay is composed with, so killed by that callback or
// the driver's handler restarting the service outside the recovery's mark, as the supervisor's own
// planned restart does, which resumes none of the home's live sessions.
#[tokio::test]
async fn an_executor_s_end_restarts_its_service_under_the_recovery_s_mark() {
    let ends = Arc::new(DriverExecutorEnds::default());
    let held = start_scripted_account_service_reporting_to(Arc::clone(&ends) as _);
    held.mark_started();
    let LiveCodexSession {
        driver, scripted, ..
    } = LiveCodexSession::on_held_service(held, &[]).await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    assert!(
        ends.0
            .set(CodexDriverServiceEvents::new(Arc::clone(&driver.link)))
            .is_ok()
    );
    let relay = scripted
        .service
        .exec_relay_or_insert_with(|| compose_exec_relay(&scripted.service));

    relay.report_executor_ended();

    assert!(
        parts.recovery.is_restarting(scripted.service.id()),
        "the restart runs under the recovery's mark"
    );
}
