//! A live session's level and mode moves Codex refuses, and a run started while the session is
//! being established again, through the driver.

use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::LiveCodexSession;
use crate::driver::codex::session::test_fixture::turn_reply;
use crate::driver::contract::{DriverError, RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::session_control::{UpdatePermissionLevelParams, UpdateSessionModeParams};
use crate::run::posture::compose_execution_posture;

/// How long a test waits before it counts a start or a move as stuck.
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

// Killed by a run start that does not wait for the establishment in flight on its session: it is
// refused at once as being re-established instead of starting once the establishment ended.
#[tokio::test]
async fn a_run_started_while_its_session_is_established_again_starts_once_it_settled() {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        binding_id,
        mut scripted,
        ..
    } = LiveCodexSession::idle().await;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let establishing = parts
        .slots
        .claim_establishing(session_id)
        .await
        .expect("the session's slot is claimed");
    let params = StartRunParams {
        run_id,
        opening: RunOpening {
            session_id,
            binding_id,
            agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
            message_id: QueueItemId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an item id"),
            item: RunOpeningItem::Review {
                target: SessionReviewTarget::WorkingTree,
            },
        },
        conversation_history: None,
        output_speed: None,
        options: Vec::new(),
        output_speed_for_turn: None,
        execution_posture: None,
        output_schema: None,
        step_bound: None,
    };

    let mut starting = pin!(driver.start_run(params));
    let early = tokio::time::timeout(Duration::from_millis(100), &mut starting).await;
    assert!(
        early.is_err(),
        "the run waits for the establishment: {early:?}"
    );
    drop(establishing);
    let serving = async {
        let sent = scripted.next_request("review/start").await;
        scripted.script.answer(&sent, &turn_reply("turn-review"));
    };
    let (started, ()) =
        tokio::time::timeout(SETTLE_BOUND, async { tokio::join!(starting, serving) })
            .await
            .expect("the run's start settles");

    started.expect("the run starts once its session settled");
}
