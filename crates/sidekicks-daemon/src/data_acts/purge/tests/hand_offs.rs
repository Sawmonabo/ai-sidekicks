//! A plan's hand-off under the purge: the fresh session's purge takes its storage folder and its
//! hand-off row, and the planning session's purge waits for the seed's queue item, then takes its
//! plans and leaves the fresh session's file and row.

use std::path::PathBuf;

use rusqlite::{Connection, params};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, PlanMessage, PlanMessageKind};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::directory::SessionLead;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_session::create::hand_off::{SessionHandOff, record_hand_off_statement};
use sidekicks_session::queue_store::test_items::test_queue_item;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemExit, QueueItemOutcome, insert_queue_item_statement,
    leave_queued_statement,
};
use sidekicks_store::data_folder::session_storage_folder;

use super::{PurgeFixture, count, only_outcome, purge_fixture, state_of, store_session};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurgeError, SessionPurgeOutcome};

const HAND_OFFS_OF_FRESH_SESSION: &str =
    "SELECT COUNT(*) FROM session_hand_offs WHERE session_id = ?1";
const PLANS_OF_SESSION: &str = "SELECT COUNT(*) FROM plans WHERE session_id = ?1";

fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

// Stores the hand-off of `plan_id`, made in `planning`, to the fresh session `fresh`, as the
// verdict's write does.
async fn record_hand_off(
    fixture: &PurgeFixture,
    plan_id: PlanId,
    planning: SessionId,
    fresh: SessionId,
) {
    let hand_off = SessionHandOff {
        session_id: fresh,
        client_idempotency_key: ClientUuid::new(fresh.to_string())
            .expect("a session id is a client UUID"),
        plan_id,
        planning_session_id: planning,
        lead: SessionLead {
            provider_name: ProviderId::new(PROVIDERS[0].id.to_owned())
                .expect("a table id is a provider id"),
            model_id: ProviderToken::new("model-a".to_owned()).expect("the model fits"),
            effort: None,
            output_speed: None,
            options: None,
            larger_window: None,
        },
        permission_level: PermissionLevel::Ask,
        title: "Add the export button".to_owned(),
        device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
    };
    fixture
        .log
        .writer
        .write(vec![record_hand_off_statement(&hand_off)])
        .await
        .expect("the test records the hand-off");
}

// The seed of `plan_id` for `fresh`'s queue, as the hand-off's seeding sends it.
fn seed_item(plan_id: PlanId, planning: SessionId, fresh: SessionId) -> NewQueueItem {
    let mut seed = test_queue_item(
        fresh,
        RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        QueueItemBody::PlanMessage {
            plan_message: PlanMessage {
                plan_id,
                kind: PlanMessageKind::Seed,
                source_session_id: Some(planning),
            },
            text: MessageContent::new("Implement the plan.".to_owned())
                .expect("the words are a message"),
        },
    );
    seed.device_id = Some(DeviceId::new("device-1".to_owned()).expect("a device id"));
    seed
}

// A file in `session_id`'s own storage folder, answered by its path.
fn store_file(fixture: &PurgeFixture, session_id: SessionId) -> PathBuf {
    let folder = session_storage_folder(fixture.home.path(), &session_id);
    std::fs::create_dir_all(&folder).expect("the storage folder is made");
    let file = folder.join("transcript.md");
    std::fs::write(&file, "the planning session's transcript").expect("the file is written");
    file
}

// The plan `plan_id` that `session_id` proposed, with the manifest that keeps its text.
fn store_plan(connection: &Connection, session_id: SessionId, plan_id: PlanId) {
    let artifact_id = mint_uuid_v7().to_string();
    connection
        .execute(
            "INSERT INTO artifact_manifests (id, session_id, artifact_type, content_hash, \
             size_bytes, plan_id, created_at) VALUES (?1, ?2, 'file', ?3, 1, ?4, ?5)",
            params![
                artifact_id,
                session_id.text().as_str(),
                format!("sha256:{}", "0".repeat(64)),
                plan_id.text().as_str(),
                "2026-10-02T00:00:00.000Z"
            ],
        )
        .expect("the test stores the plan's manifest");
    connection
        .execute(
            "INSERT INTO plans (id, session_id, run_id, artifact_id, title, holds_request, \
             created_at) VALUES (?1, ?2, ?3, ?4, 'Add the export button', 0, ?5)",
            params![
                plan_id.text().as_str(),
                session_id.text().as_str(),
                mint_uuid_v7().to_string(),
                artifact_id,
                "2026-10-02T00:00:00.000Z"
            ],
        )
        .expect("the test stores the plan");
}

// Kills: the fresh session's storage folder left by its purge, and its hand-off row left.
#[tokio::test]
async fn a_fresh_sessions_purge_takes_its_storage_folder_and_hand_off_row() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let (planning, fresh) = (new_session_id(), new_session_id());
    let plan_id = PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id");
    store_session(&reader, fresh, SessionState::Archived);
    record_hand_off(&fixture, plan_id, planning, fresh).await;
    let seed = seed_item(plan_id, planning, fresh);
    let taken = QueueItemExit::Outcome(QueueItemOutcome::Admitted {
        run_id: seed.target_run_id,
    });
    fixture
        .log
        .writer
        .write(vec![
            insert_queue_item_statement(&seed),
            leave_queued_statement(&seed.id, &taken, &WireInstant::now()),
        ])
        .await
        .expect("a run takes the seed");
    let file = store_file(&fixture, fresh);

    let outcome = only_outcome(fixture.purge.purge(&[fresh], PurgeCaller::Retention).await);

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the fresh session is removed, got {outcome:?}"
    );
    assert!(
        !file.parent().expect("the file is in a folder").exists(),
        "the storage folder goes with its session"
    );
    assert_eq!(count(&reader, HAND_OFFS_OF_FRESH_SESSION, fresh), 0);
}

// Kills: the mark's guard removed (the first purge lands), a guard that counts any queue item
// (the plain item lets the first purge through), a guard keyed on the fresh session's id in place
// of the planning one's, a blanket refusal (the second purge refused), the plans delete missing
// (the writer's foreign key refuses the deletion write), the fresh session's file removed with
// the planning session, and the hand-off delete keyed on the planning session.
#[tokio::test]
async fn a_planning_sessions_purge_waits_for_the_seed_and_takes_only_its_own_rows() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let (planning, fresh) = (new_session_id(), new_session_id());
    let plan_id = PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id");
    store_session(&reader, planning, SessionState::Archived);
    store_plan(&reader, planning, plan_id);
    record_hand_off(&fixture, plan_id, planning, fresh).await;
    let file = store_file(&fixture, fresh);
    reader
        .execute(
            "INSERT INTO queue_items (id, session_id, payload, position, created_at, updated_at) \
             VALUES (?1, ?2, '{}', 0, '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z')",
            params![mint_uuid_v7().to_string(), fresh.text().as_str()],
        )
        .expect("the test queues an item that is no plan message");

    let refused = only_outcome(
        fixture
            .purge
            .purge(&[planning], PurgeCaller::Retention)
            .await,
    );

    assert!(
        matches!(
            refused,
            SessionPurgeOutcome::Refused(SessionPurgeError::HandOffUnfinished)
        ),
        "the mark waits for the seed, got {refused:?}"
    );
    assert_eq!(
        state_of(&reader, planning).as_deref(),
        Some(<&'static str>::from(SessionState::Archived))
    );
    assert_eq!(count(&reader, PLANS_OF_SESSION, planning), 1);

    fixture
        .log
        .writer
        .write(vec![insert_queue_item_statement(&seed_item(
            plan_id, planning, fresh,
        ))])
        .await
        .expect("the seed is queued");
    let removed = only_outcome(
        fixture
            .purge
            .purge(&[planning], PurgeCaller::Retention)
            .await,
    );

    assert!(
        matches!(removed, SessionPurgeOutcome::Removed { .. }),
        "the planning session is removed once the seed is queued, got {removed:?}"
    );
    assert_eq!(count(&reader, PLANS_OF_SESSION, planning), 0);
    assert!(file.exists(), "the fresh session's file stays");
    assert_eq!(count(&reader, HAND_OFFS_OF_FRESH_SESSION, fresh), 1);
}
