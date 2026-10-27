//! The plan rows a rebuild writes from the log against the rows the live writes wrote.

use std::sync::Arc;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanKeptPayload, PlanState};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;

use super::{rebuild_whole, table_rows};
use crate::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use crate::plans::projection::PlansProjection;
use crate::plans::service::tests::Fixture;
use crate::plans::store::settle_verdict_statement;
use crate::provider::port::plan::ProviderPlanHoldEnd;

const PLAN_ROWS_SQL: &str = "SELECT * FROM plans ORDER BY id";

// The rows a rebuild writes from the log are the rows the live writes wrote: a plan proposed and
// left waiting, one kept with its device and instant, and one whose hold ended. Killed by a fold
// arm that drops an event or writes another column than its live write.
#[tokio::test]
async fn a_rebuild_writes_the_plan_rows_the_live_writes_wrote() {
    let fixture = Fixture::new().await;
    fixture.take(false).await;
    let kept = fixture.take(true).await;
    let lost = fixture.take(true).await;
    let device_id = DeviceId::new("device-1".to_owned()).expect("a device id");
    let kept_at = WireInstant::try_from("2026-10-21T05:00:00.000Z".to_owned())
        .expect("the test's instant reads");
    // The verdict's write as the plan's verdict call makes it.
    fixture
        .store
        .appender
        .append(
            SessionEventDraft::of_session(
                fixture.store.session_id,
                &SessionEvent::PlanKept(PlanKeptPayload {
                    plan_id: kept,
                    session_id: fixture.store.session_id,
                    device_id: device_id.clone(),
                }),
            )
            .expect("the verdict drafts"),
            SessionEventLinkage {
                occurred_at: Some(kept_at.clone()),
                transactional_prelude: vec![settle_verdict_statement(
                    &kept,
                    PlanState::Open,
                    None,
                    &device_id,
                    &kept_at,
                )],
                ..SessionEventLinkage::default()
            },
        )
        .await
        .expect("the verdict is written");
    fixture
        .plans
        .end_plan_hold(ProviderPlanHoldEnd {
            session_id: fixture.store.session_id,
            plan_id: lost,
            reason: PlanHoldEndedReason::Interrupted,
        })
        .await
        .expect("the hold ends");
    let reader = fixture.store.database.reader();
    let live = table_rows(&reader, PLAN_ROWS_SQL);

    rebuild_whole(
        &fixture.store.database,
        Arc::clone(&fixture.store.writer),
        Box::new(PlansProjection),
        fixture.store.session_id,
    )
    .await;

    assert_eq!(table_rows(&reader, PLAN_ROWS_SQL), live);
}
