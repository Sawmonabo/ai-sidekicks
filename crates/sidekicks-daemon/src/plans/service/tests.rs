//! The plan record over the artifact test store: a plan's one write, its place in the artifact
//! list, each way a held request ends with no verdict, and the rows a rebuild writes.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::operations::ArtifactListEntry;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId, PlanKeptPayload, PlanState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use tempfile::TempDir;

use super::PlansService;
use crate::artifacts::list::list_artifacts;
use crate::artifacts::test_store::ArtifactTestStore;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::plans::projection::PlansProjection;
use crate::plans::store::settle_verdict_statement;
use crate::provider::port::plan::{ProviderPlan, ProviderPlanHoldEnd};
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::projection_rebuild::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildRequest, ProjectionRebuildService,
};
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::tests::test_engine;
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};
use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use sidekicks_contracts::wire::id::mint_uuid_v7;

const PLAN_TEXT: &str = "# Ship the importer\n\n1. Read `src/import.rs`\n2. Write the tests\n";

/// The test store and the plans service over it.
struct Fixture {
    store: ArtifactTestStore,
    plans: PlansService,
}

impl Fixture {
    async fn new() -> Self {
        let store = ArtifactTestStore::open().await;
        let plans = PlansService::new(
            Arc::new(store.publisher()),
            Arc::clone(&store.appender),
            Arc::clone(&store.reads),
        );
        Self { store, plans }
    }

    /// Takes the test's plan, holding its request when `holds_request`.
    async fn take(&self, holds_request: bool) -> PlanId {
        self.plans
            .take_plan(ProviderPlan {
                session_id: self.store.session_id,
                run_id: self.store.run_id,
                text: PLAN_TEXT.to_owned(),
                plan_file_path: None,
                holds_request,
            })
            .await
            .expect("the plan is recorded")
    }

    /// The state `plan_id`'s row holds.
    fn state(&self, plan_id: PlanId) -> String {
        self.store
            .read_rows(
                "SELECT state FROM plans WHERE id = ?1",
                plan_id.text().as_str(),
            )
            .remove(0)
    }

    /// The payloads of the log's events of `event_type`, oldest first.
    fn payloads(&self, event_type: &str) -> Vec<Value> {
        self.store
            .read_rows(
                "SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence",
                event_type,
            )
            .iter()
            .map(|payload| serde_json::from_str(payload).expect("each payload is JSON"))
            .collect()
    }
}

// A plan is kept as a `summary` artifact naming it, and `artifact.published` and the
// `plan.proposed` that names the artifact land in one write, the artifact first. The list shows it
// as a plan with its first heading and `waiting`, then `open` once its hold ends; a manifest of the
// same plan in the session it was handed off to lists there as accepted. Killed by appending
// `plan.proposed` before or without its artifact, by a missing artifact id, by dropping the join
// on the plan, and by dropping the fresh-session rule.
#[tokio::test]
async fn a_plan_is_its_artifact_then_its_record_and_lists_with_its_word() {
    let fixture = Fixture::new().await;

    let plan_id = fixture.take(true).await;

    let proposed = fixture.payloads("plan.proposed");
    assert_eq!(proposed.len(), 1);
    let artifact_id = proposed[0]["artifactId"]
        .as_str()
        .expect("an artifact id")
        .to_owned();
    assert_eq!(proposed[0]["holdsRequest"], json!(true));
    assert_eq!(proposed[0]["title"], "Ship the importer");
    assert_eq!(proposed[0]["stepCount"], json!(2));
    let sequences = fixture.store.read_rows(
        "SELECT CAST(sequence AS TEXT) || ' ' || type FROM session_events
          WHERE type IN ('artifact.published', 'plan.proposed') AND ?1 = session_id
          ORDER BY sequence",
        fixture.store.session_id.text().as_str(),
    );
    let [published, proposed_at] = sequences.as_slice() else {
        panic!("one artifact and one record are written: {sequences:?}");
    };
    let sequence_of = |row: &String| -> i64 {
        row.split(' ')
            .next()
            .and_then(|text| text.parse().ok())
            .expect("a sequence")
    };
    assert!(published.ends_with("artifact.published") && proposed_at.ends_with("plan.proposed"));
    assert_eq!(sequence_of(proposed_at), sequence_of(published) + 1);
    assert_eq!(
        fixture.store.read_rows(
            "SELECT artifact_type || ' ' || plan_id FROM artifact_manifests WHERE id = ?1",
            &artifact_id,
        ),
        vec![format!("summary {plan_id}")]
    );
    let plan_word = |entries: Vec<ArtifactListEntry>| -> Vec<(String, PlanState)> {
        entries
            .into_iter()
            .map(|entry| match entry {
                ArtifactListEntry::Plan { title, state, .. } => (title, state),
                ArtifactListEntry::File { path, .. } => panic!("no file is written: {path:?}"),
            })
            .collect()
    };
    let title = "Ship the importer".to_owned();
    assert_eq!(
        plan_word(listed(&fixture.store, fixture.store.session_id).await),
        vec![(title.clone(), PlanState::Waiting)]
    );

    fixture
        .plans
        .end_plan_hold(ProviderPlanHoldEnd {
            session_id: fixture.store.session_id,
            plan_id,
            reason: PlanHoldEndedReason::Withdrawn,
        })
        .await
        .expect("the hold ends");
    assert_eq!(
        plan_word(listed(&fixture.store, fixture.store.session_id).await),
        vec![(title.clone(), PlanState::Open)]
    );

    let fresh_session = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID");
    let reader = fixture.store.database.reader();
    insert_session_row(&reader, fresh_session.text().as_str(), None, None);
    reader
        .execute(
            "UPDATE plans SET state = 'handedOff', fresh_session_id = ?1 WHERE id = ?2",
            [fresh_session.text().as_str(), plan_id.text().as_str()],
        )
        .expect("the test hands the plan off");
    reader
        .execute(
            "INSERT INTO artifact_manifests
               (id, session_id, artifact_type, content_hash, size_bytes, metadata, plan_id,
                created_at)
             SELECT ?1, ?2, artifact_type, content_hash, size_bytes, metadata, plan_id, created_at
               FROM artifact_manifests WHERE id = ?3",
            [
                mint_uuid_v7().to_string(),
                fresh_session.text().as_str().to_owned(),
                artifact_id,
            ],
        )
        .expect("the test writes the seed plan");
    assert_eq!(
        plan_word(listed(&fixture.store, fixture.store.session_id).await),
        vec![(title.clone(), PlanState::HandedOff)]
    );
    assert_eq!(
        plan_word(listed(&fixture.store, fresh_session).await),
        vec![(title, PlanState::Accepted)]
    );
}

/// The entries of `session_id`'s artifact list.
async fn listed(store: &ArtifactTestStore, session_id: SessionId) -> Vec<ArtifactListEntry> {
    list_artifacts(&store.reads, session_id)
        .await
        .expect("the list reads")
        .artifacts
}

/// What ends a plan's held request with no verdict.
#[derive(Clone, Copy, Debug)]
enum HoldEnd {
    /// The driver reports it, twice.
    DriverReport,
    /// The daemon's start, which no held request survives.
    Restart,
    /// Its run is interrupted.
    RunInterrupted,
    /// Its run fails, as any end but an interrupt.
    RunFailed,
}

// A plan waiting on a held request is reopened once, with `plan.hold.ended` and the reason the end
// gives, whichever way the hold ends: the driver's report, written once however often it comes,
// the daemon's start, and its run's end, in the write that ends the run; a Codex plan, which holds
// no request, stays waiting through every one. Killed by dropping the `holds_request` guard or the
// state guard, by sweeping Codex plans, and by a run's end that leaves a holding plan waiting.
#[rstest]
#[case::by_the_drivers_report(HoldEnd::DriverReport, "withdrawn")]
#[case::by_a_restart(HoldEnd::Restart, "runEnded")]
#[case::by_an_interrupted_run(HoldEnd::RunInterrupted, "interrupted")]
#[case::by_a_failed_run(HoldEnd::RunFailed, "runEnded")]
#[tokio::test]
async fn a_lost_hold_reopens_a_holding_plan_once_and_leaves_a_codex_plan(
    #[case] end: HoldEnd,
    #[case] reason: &str,
) {
    let fixture = Fixture::new().await;
    let home = TempDir::new().expect("the test makes a home folder");
    let holding = fixture.take(true).await;
    let codex = fixture.take(false).await;

    match end {
        HoldEnd::DriverReport => {
            for plan_id in [holding, holding, codex] {
                fixture
                    .plans
                    .end_plan_hold(ProviderPlanHoldEnd {
                        session_id: fixture.store.session_id,
                        plan_id,
                        reason: PlanHoldEndedReason::Withdrawn,
                    })
                    .await
                    .expect("the report is taken");
            }
        }
        HoldEnd::Restart => {
            for _ in 0..2 {
                fixture
                    .plans
                    .end_holds_lost_at_restart()
                    .await
                    .expect("the sweep runs");
            }
        }
        HoldEnd::RunInterrupted | HoldEnd::RunFailed => {
            let entry = if matches!(end, HoldEnd::RunInterrupted) {
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                }
            } else {
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: None,
                    provider_failure_detail: None,
                    process_exit: None,
                }
            };
            test_engine(
                &fixture.store.database,
                Arc::clone(&fixture.store.event_log),
                home.path(),
            )
            .transition(
                RunStateChange::new(fixture.store.run_id, entry),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run ends");
        }
    }

    let ended = fixture.payloads("plan.hold.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["planId"], json!(holding));
    assert_eq!(ended[0]["reason"], reason);
    assert_eq!(fixture.state(holding), "open");
    assert_eq!(fixture.state(codex), "waiting");
}

fn plan_rows(connection: &Connection) -> Vec<Vec<SqlValue>> {
    let mut statement = connection
        .prepare("SELECT * FROM plans ORDER BY id")
        .expect("the read prepares");
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("the rows read")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("every row reads")
}

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
    let live = plan_rows(&reader);

    let pool = Arc::new(DatabaseReadPool::new(
        fixture.store.database.path(),
        PROJECTION_REBUILD_STATEMENT_CAPACITY + SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let reads_whole: Arc<DamagedFromSequenceReader> =
        Arc::new(|_session_id: &SessionId| -> Option<i64> { None });
    ProjectionRebuildService::new(
        Arc::clone(&pool),
        Arc::clone(&fixture.store.writer),
        Arc::new(SessionService::new(pool, reads_whole)),
        Arc::new(DatabaseDamageWatch::new()),
        vec![Box::new(PlansProjection)],
    )
    .rebuild(ProjectionRebuildRequest {
        session_id: fixture.store.session_id,
        is_forced: true,
        before_sequence: None,
        stop: None,
    })
    .await
    .expect("the session's plans are rebuilt");

    assert_eq!(plan_rows(&reader), live);
}
