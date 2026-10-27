//! The plan record over the artifact test store: a plan's one write, its place in the artifact
//! list, and each way a held request ends with no verdict.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::operations::ArtifactListEntry;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId, PlanState};
use sidekicks_contracts::session::id::SessionId;
use tempfile::TempDir;

use super::PlansService;
use crate::artifacts::list::list_artifacts;
use crate::artifacts::test_store::ArtifactTestStore;
use crate::database::schema::session_directory::insert_session_row;
use crate::plans::store::StoredPlanHolds;
use crate::provider::port::plan::{ProviderPlan, ProviderPlanHoldEnd};
use crate::provider::run::state_entry::RunStateEntry;
use crate::session::directory::run_activity::session_activity_sql;
use crate::session::plan_holds::PlanHolds as _;
use crate::session::run::engine::tests::test_engine_with;
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions};
use sidekicks_contracts::wire::id::mint_uuid_v7;

const PLAN_TEXT: &str = "# Ship the importer\n\n1. Read `src/import.rs`\n2. Write the tests\n";

/// The test store and the plans service over it.
pub(crate) struct Fixture {
    /// The artifact test store the plans are written to.
    pub(crate) store: ArtifactTestStore,
    /// The plans service over the store.
    pub(crate) plans: PlansService,
}

impl Fixture {
    /// Opens a fresh test store and the plans service over it.
    pub(crate) async fn new() -> Self {
        let store = ArtifactTestStore::open().await;
        let plans = PlansService::new(
            Arc::new(store.publisher()),
            Arc::clone(&store.appender),
            Arc::clone(&store.reads),
        );
        Self { store, plans }
    }

    /// Takes the test's plan, holding its request when `holds_request`.
    pub(crate) async fn take(&self, holds_request: bool) -> PlanId {
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
// as a plan with its first heading and `waiting`, its session's activity reading waiting, then
// `open` once its hold ends, the activity back to its running run's; a manifest of the same plan in
// the session it was handed off to lists there as accepted. Killed by appending `plan.proposed`
// before or without its artifact, by a missing artifact id, by dropping the join on the plan, by
// dropping the fresh-session rule, and by a waiting-plan condition that never holds.
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
    let activity_sql = format!(
        "SELECT {}",
        session_activity_sql("?1", "'idle'", &StoredPlanHolds.waiting_plan_sql("?1"))
    );
    let activity = || {
        fixture
            .store
            .read_rows(&activity_sql, fixture.store.session_id.text().as_str())
    };
    assert_eq!(activity(), ["waiting"]);

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
    assert_eq!(activity(), ["running"]);

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
                    .end_holds_lost_at_restart(fixture.store.session_id)
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
            test_engine_with(
                &fixture.store.database,
                Arc::clone(&fixture.store.event_log),
                home.path(),
                Arc::new(StoredPlanHolds),
                Vec::new(),
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
