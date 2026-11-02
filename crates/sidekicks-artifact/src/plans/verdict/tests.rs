//! A plan's verdict over the artifact test store: the guarded settle and its read-back, the seed
//! copy held to one per fresh session, and the fresh session's list after the plan row is gone.

use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::artifacts::operations::ArtifactListEntry;
use sidekicks_contracts::plan::{PlanId, PlanState};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::directory::SessionLead;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_session::create::hand_off::{SessionHandOff, record_hand_off_statement};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::statement::WriteStatement;

use super::{PlanSettleOutcome, PlanSettleVerdict, PlanVerdicts, StoredPlan};
use crate::list::list_artifacts;
use crate::plans::service::test_fixture::Fixture;

const TITLE: &str = "Ship the importer";

/// The verdicts over `fixture`'s store.
fn verdicts(fixture: &Fixture) -> PlanVerdicts {
    PlanVerdicts::new(
        Arc::clone(&fixture.store.appender),
        Arc::clone(&fixture.store.reads),
        Arc::new(fixture.store.publisher()),
    )
}

/// A fresh session's row, under a minted id.
fn fresh_session(fixture: &Fixture) -> SessionId {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    insert_session_row(
        &fixture.store.database.reader(),
        session_id.text().as_str(),
        None,
        None,
    );
    session_id
}

/// The device every verdict comes from.
fn device() -> DeviceId {
    DeviceId::new("device-1".to_owned()).expect("a test device id")
}

/// The hand-off record of `plan_id` to `fresh`, as the pivot writes it after the settle.
fn hand_off_row(fixture: &Fixture, plan_id: PlanId, fresh: SessionId) -> WriteStatement {
    record_hand_off_statement(&SessionHandOff {
        session_id: fresh,
        client_idempotency_key: ClientUuid::new(fresh.to_string())
            .expect("a session id is a client UUID"),
        plan_id,
        planning_session_id: fixture.store.session_id,
        lead: SessionLead {
            provider_name: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            model_id: ProviderToken::new("model-a".to_owned()).expect("the model fits"),
            effort: None,
            output_speed: None,
            options: None,
            larger_window: None,
        },
        permission_level: PermissionLevel::Ask,
        title: TITLE.to_owned(),
        device_id: device(),
    })
}

/// Settles `plan_id` with `verdict` under its lock, the caller's `statements` in the write.
async fn settle(
    fixture: &Fixture,
    verdicts: &PlanVerdicts,
    plan_id: PlanId,
    verdict: PlanSettleVerdict,
    statements: Vec<WriteStatement>,
) -> PlanSettleOutcome {
    let hold = verdicts.plan_lock().acquire(plan_id).await;
    verdicts
        .settle(
            &hold,
            fixture.store.session_id,
            verdict,
            device(),
            statements,
        )
        .await
        .expect("the settle runs")
}

/// The payloads of the log's events of `event_type`, oldest first.
fn payloads(fixture: &Fixture, event_type: &str) -> Vec<Value> {
    fixture
        .store
        .read_rows(
            "SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence",
            event_type,
        )
        .iter()
        .map(|payload| serde_json::from_str(payload).expect("each payload is JSON"))
        .collect()
}

/// The `state fresh_session_id` of `plan_id`'s row.
fn plan_row(fixture: &Fixture, plan_id: PlanId) -> Vec<String> {
    fixture.store.read_rows(
        "SELECT state || ' ' || coalesce(fresh_session_id, '-') FROM plans WHERE id = ?1",
        plan_id.text().as_str(),
    )
}

// A verdict settles a waiting plan, its event carrying the device; a second verdict on the settled
// plan writes nothing, the caller's hand-off row with it, and answers the row as it stands; a
// waiting plan hands off with its row and event; an unknown plan is gone. Killed by the settle's
// guard removed (the second settle lands), by the caller's statements written outside the settle's
// write (a hand-off row after a refusal), by the wrong event or none, and by `Unchanged` and
// `Gone` confused.
#[tokio::test]
async fn a_verdict_settles_a_waiting_plan_once_with_the_callers_statements() {
    let fixture = Fixture::new().await;
    let verdicts = verdicts(&fixture);
    let kept = fixture.take(false).await;
    let fresh = fresh_session(&fixture);

    assert_eq!(
        settle(
            &fixture,
            &verdicts,
            kept,
            PlanSettleVerdict::Keep,
            Vec::new()
        )
        .await,
        PlanSettleOutcome::Settled
    );
    assert_eq!(plan_row(&fixture, kept), ["open -"]);
    let kept_events = payloads(&fixture, "plan.kept");
    assert_eq!(kept_events.len(), 1);
    assert_eq!(kept_events[0]["planId"], json!(kept));
    assert_eq!(kept_events[0]["deviceId"], "device-1");

    let refused = settle(
        &fixture,
        &verdicts,
        kept,
        PlanSettleVerdict::HandOff {
            fresh_session_id: fresh,
        },
        vec![hand_off_row(&fixture, kept, fresh)],
    )
    .await;
    assert_eq!(
        refused,
        PlanSettleOutcome::Unchanged(StoredPlan {
            session_id: fixture.store.session_id,
            state: PlanState::Open,
            holds_request: false,
            fresh_session_id: None,
            title: TITLE.to_owned(),
        })
    );
    assert_eq!(fixture.store.count_rows("session_hand_offs"), 0);
    assert_eq!(fixture.store.count_events("plan.handedOff"), 0);

    let handed_off = fixture.take(false).await;
    assert_eq!(
        settle(
            &fixture,
            &verdicts,
            handed_off,
            PlanSettleVerdict::HandOff {
                fresh_session_id: fresh,
            },
            vec![hand_off_row(&fixture, handed_off, fresh)],
        )
        .await,
        PlanSettleOutcome::Settled
    );
    assert_eq!(
        plan_row(&fixture, handed_off),
        [format!("handedOff {fresh}")]
    );
    assert_eq!(
        fixture.store.read_rows(
            "SELECT session_id FROM session_hand_offs WHERE plan_id = ?1",
            handed_off.text().as_str(),
        ),
        [fresh.to_string()]
    );
    let handed_off_events = payloads(&fixture, "plan.handedOff");
    assert_eq!(handed_off_events.len(), 1);
    assert_eq!(handed_off_events[0]["planId"], json!(handed_off));
    assert_eq!(handed_off_events[0]["freshSessionId"], json!(fresh));
    assert_eq!(handed_off_events[0]["deviceId"], "device-1");

    let unknown = PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id");
    assert_eq!(
        settle(
            &fixture,
            &verdicts,
            unknown,
            PlanSettleVerdict::Build,
            Vec::new()
        )
        .await,
        PlanSettleOutcome::Gone
    );
    assert_eq!(fixture.store.count_events("plan.accepted"), 0);
}

// A seed copy written twice into one fresh session leaves one manifest and one
// `artifact.published` there, and a second fresh session's copy of the same plan stands beside it,
// each over the planning manifest's stored bytes. Killed by the guard removed (the first session
// holds two) and by the guard keyed on the plan alone (the second session's copy refused).
#[tokio::test]
async fn a_seed_copy_is_written_once_per_fresh_session() {
    let fixture = Fixture::new().await;
    let verdicts = verdicts(&fixture);
    let plan_id = fixture.take(false).await;
    let text = payloads(&fixture, "plan.proposed")[0]["text"]
        .as_str()
        .expect("the plan's text")
        .to_owned();
    let first = fresh_session(&fixture);
    let second = fresh_session(&fixture);

    for fresh in [first, first, second] {
        verdicts
            .write_seed_manifest(fresh, plan_id, text.clone())
            .await
            .expect("the seed copy is written or already there");
    }

    let hashes_in = |session_id: SessionId| {
        fixture.store.read_rows(
            &format!(
                "SELECT content_hash FROM artifact_manifests
                  WHERE session_id = ?1 AND plan_id = '{}'",
                plan_id.text().as_str()
            ),
            session_id.text().as_str(),
        )
    };
    let planning = hashes_in(fixture.store.session_id);
    assert_eq!(planning.len(), 1);
    assert_eq!(hashes_in(first), planning);
    assert_eq!(hashes_in(second), planning);
    assert_eq!(
        fixture.store.read_rows(
            "SELECT CAST(count(*) AS TEXT) FROM session_events
              WHERE type = 'artifact.published' AND session_id = ?1",
            first.text().as_str(),
        ),
        ["1"]
    );
}

// A fresh session lists its seed plan accepted under the plan's title; once the planning session's
// plan row is deleted it still does, from its hand-off row, and with neither row it lists nothing.
// Killed by an inner join on the plan (the entry lost with the plan row), by the title not read
// from the hand-off row (a NULL title fails the read), and by the state not read as accepted.
#[tokio::test]
async fn a_seed_plan_lists_accepted_from_its_hand_off_once_the_plan_row_is_gone() {
    let fixture = Fixture::new().await;
    let verdicts = verdicts(&fixture);
    let plan_id = fixture.take(false).await;
    let fresh = fresh_session(&fixture);
    let text = payloads(&fixture, "plan.proposed")[0]["text"]
        .as_str()
        .expect("the plan's text")
        .to_owned();
    assert_eq!(
        settle(
            &fixture,
            &verdicts,
            plan_id,
            PlanSettleVerdict::HandOff {
                fresh_session_id: fresh,
            },
            vec![hand_off_row(&fixture, plan_id, fresh)],
        )
        .await,
        PlanSettleOutcome::Settled
    );
    verdicts
        .write_seed_manifest(fresh, plan_id, text)
        .await
        .expect("the seed copy is written");
    let listed = async || -> Vec<(PlanId, String, PlanState)> {
        list_artifacts(&fixture.store.reads, fresh)
            .await
            .expect("the list reads")
            .artifacts
            .into_iter()
            .map(|entry| match entry {
                ArtifactListEntry::Plan {
                    plan_id,
                    title,
                    state,
                    ..
                } => (plan_id, title, state),
                ArtifactListEntry::File { path, .. } => panic!("no file is written: {path:?}"),
            })
            .collect()
    };
    let seed = vec![(plan_id, TITLE.to_owned(), PlanState::Accepted)];
    assert_eq!(listed().await, seed);

    let reader = fixture.store.database.reader();
    reader
        .execute("DELETE FROM plans WHERE id = ?1", [plan_id.text().as_str()])
        .expect("the test deletes the plan row");
    assert_eq!(listed().await, seed);

    reader
        .execute(
            "DELETE FROM session_hand_offs WHERE session_id = ?1",
            [fresh.text().as_str()],
        )
        .expect("the test deletes the hand-off row");
    assert_eq!(listed().await, Vec::new());
}
