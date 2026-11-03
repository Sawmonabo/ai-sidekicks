//! The plan record over the artifact test store: a plan's one write, its place in the artifact
//! list, the newer plan's supersede of the older, each way a held request ends with no verdict,
//! and a hand-off whose fresh session went putting its plan back up.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::artifacts::operations::ArtifactListEntry;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{PlanHandedOffPayload, PlanHoldEndedReason, PlanId, PlanState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::port::plan::{ProviderPlan, ProviderPlanHoldEnd};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::directory::run_activity::session_activity_sql;
use sidekicks_session::plan_holds::PlanHolds as _;
use sidekicks_session::run::engine::test_fixture::test_engine_with;
use sidekicks_session::run::state_change::{RunStateChange, RunWriteCompanions};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::events::log_service::EventReadAfterCursorRequest;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use tempfile::TempDir;

use super::test_fixture::Fixture;
use crate::list::list_artifacts;
use crate::plans::projection::PlansProjection;
use crate::plans::store::{StoredPlanHolds, hold_end_write, settle_verdict_statement};
use crate::test_store::ArtifactTestStore;

// A plan is kept as a `summary` artifact naming it, and `artifact.published` and the
// `plan.proposed` that names the artifact land in one write, the artifact first, both under the
// plan id the driver minted before the take. The list shows it as a plan with its first heading and
// `waiting`, its session's activity reading waiting, then `open` once its hold ends, the activity
// back to its running run's; a manifest of the same plan in the session it was handed off to lists
// there as accepted. Killed by appending `plan.proposed` before or without its artifact, by a
// missing artifact id, by a plan id the record mints in place of the driver's, by dropping the join
// on the plan, by dropping the fresh-session rule, and by a waiting-plan condition that never
// holds.
#[tokio::test]
async fn a_plan_is_its_artifact_then_its_record_and_lists_with_its_word() {
    let fixture = Fixture::new().await;

    let plan_id = fixture.take(true).await;

    let proposed = fixture.payloads("plan.proposed");
    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0]["planId"], json!(plan_id));
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
// no request, stays waiting through every one. Each plan waits in a session of its own, since a
// newer plan supersedes an older one. Killed by dropping the `holds_request` guard or the state
// guard, by sweeping Codex plans, and by a run's end that leaves a holding plan waiting.
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
    let holding_fixture = Fixture::new().await;
    let holding = holding_fixture.take(true).await;
    let codex_fixture = Fixture::new().await;
    let codex = codex_fixture.take(false).await;

    for (fixture, plan_id) in [(&holding_fixture, holding), (&codex_fixture, codex)] {
        end_hold(fixture, plan_id, end).await;
    }

    let ended = holding_fixture.payloads("plan.hold.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["planId"], json!(holding));
    assert_eq!(ended[0]["reason"], reason);
    assert_eq!(holding_fixture.state(holding), "open");
    assert_eq!(
        codex_fixture.payloads("plan.hold.ended"),
        Vec::<serde_json::Value>::new()
    );
    assert_eq!(codex_fixture.state(codex), "waiting");
}

/// Ends the hold of `plan_id`, the fixture's one plan, as `end` does.
async fn end_hold(fixture: &Fixture, plan_id: PlanId, end: HoldEnd) {
    match end {
        HoldEnd::DriverReport => {
            for _ in 0..2 {
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
            let home = TempDir::new().expect("the test makes a home folder");
            test_engine_with(
                &fixture.store.database,
                Arc::clone(&fixture.store.event_log),
                home.path(),
                Arc::new(StoredPlanHolds),
                Vec::new(),
            )
            .transition(
                RunStateChange::new(fixture.store.run_id, entry),
                RunWriteCompanions::default(),
            )
            .await
            .expect("the run ends");
        }
    }
}

// A newer plan of a session reopens the older one still waiting, a Codex plan holding no request,
// `superseded`, in its own take's write: the older plan's `plan.hold.ended` is the write's first
// event, the newer plan's artifact and record right after it. A take refused for a plan id already
// recorded writes nothing, so the plan it would have superseded still waits. A rebuild of the plan
// rows from the log writes the same states. Killed by the supersede written as a write of its own
// (before the take, the refused take reopens the older plan; after it, the order breaks), by a
// supersede that needs a held request (the older plan stays waiting, live and on rebuild), and by
// a rebuild that replays `superseded` through the held request's statement.
#[tokio::test]
async fn a_newer_plan_supersedes_the_older_waiting_one_in_its_own_write() {
    let fixture = Fixture::new().await;
    let older = fixture.take(false).await;
    let events_before = fixture.store.count_rows("session_events");

    let retaken = fixture
        .plans
        .take_plan(ProviderPlan {
            plan_id: older,
            session_id: fixture.store.session_id,
            run_id: fixture.store.run_id,
            text: "# Ship it again\n".to_owned(),
            plan_file_path: None,
            holds_request: false,
        })
        .await;
    assert!(retaken.is_err(), "a plan id already recorded is refused");
    assert_eq!(fixture.store.count_rows("session_events"), events_before);
    assert_eq!(fixture.state(older), "waiting");

    let newer = fixture.take(true).await;

    assert_eq!(fixture.state(older), "open");
    assert_eq!(fixture.state(newer), "waiting");
    let ended = fixture.payloads("plan.hold.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["planId"], json!(older));
    assert_eq!(ended[0]["reason"], "superseded");
    assert_eq!(
        fixture.store.read_rows(
            "SELECT type FROM session_events WHERE session_id = ?1 ORDER BY sequence",
            fixture.store.session_id.text().as_str(),
        ),
        [
            "artifact.published",
            "plan.proposed",
            "plan.hold.ended",
            "artifact.published",
            "plan.proposed",
        ]
    );

    let plan_states_sql = "SELECT id || ' ' || state FROM plans WHERE session_id = ?1 ORDER BY id";
    let live = fixture
        .store
        .read_rows(plan_states_sql, fixture.store.session_id.text().as_str());
    rebuild_plans(&fixture).await;
    assert_eq!(
        fixture
            .store
            .read_rows(plan_states_sql, fixture.store.session_id.text().as_str()),
        live
    );
}

// The newer plan of the session beside the handed-off plan whose fresh session goes.
#[derive(Clone, Copy)]
enum NewerPlan {
    None,
    Waiting,
    HandedOffAndGoneAfter,
}

// A handed-off plan whose fresh session went before its first turn waits again, holding no
// request, live and on rebuild, and the plan recorded last stands: a newer waiting plan keeps its
// card and the handed-off plan reopens, and a newer handed-off plan whose fresh session goes after
// it takes the card back and reopens it. One plan waits. Killed by every hold's end read through
// the held request's statement, which reopens a plan only while it waits, by the newer-plan guard
// removed, and by the older waiting plans left as they are, each leaving two plans waiting.
#[rstest]
#[case::alone(NewerPlan::None, "waiting 0 -")]
#[case::beside_a_newer_waiting_plan(NewerPlan::Waiting, "open 0 -")]
#[case::before_a_newer_hand_off_whose_session_goes(NewerPlan::HandedOffAndGoneAfter, "open 0 -")]
#[tokio::test]
async fn a_hand_off_whose_fresh_session_went_puts_its_plan_back_up(
    #[case] newer_plan: NewerPlan,
    #[case] handed_off_row: &str,
) {
    let fixture = Fixture::new().await;
    let session_id = fixture.store.session_id;
    let device_id = DeviceId::new("device-1".to_owned()).expect("a test device id");
    let append = |event, statements| {
        fixture.store.appender.append(
            event,
            SessionEventLinkage {
                transactional_prelude: statements,
                ..SessionEventLinkage::default()
            },
        )
    };
    let hand_off = async |plan_id| {
        let fresh_session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID");
        let handed_off = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::PlanHandedOff(PlanHandedOffPayload {
                plan_id,
                session_id,
                fresh_session_id,
                device_id: device_id.clone(),
            }),
        )
        .expect("a plan.handedOff payload names only checked ids");
        let verdict = settle_verdict_statement(
            &plan_id,
            PlanState::HandedOff,
            Some(&fresh_session_id),
            &device_id,
            &WireInstant::now(),
        );
        append(handed_off, vec![verdict])
            .await
            .expect("the hand-off is written");
    };
    let fresh_session_goes = async |plan_id| {
        let (statements, ended) =
            hold_end_write(session_id, plan_id, PlanHoldEndedReason::FreshSessionGone);
        append(ended, statements)
            .await
            .expect("the hold's end is written");
    };
    let plan_id = fixture.take(true).await;
    hand_off(plan_id).await;
    let (newer, goes_after) = match newer_plan {
        NewerPlan::None => (None, None),
        NewerPlan::Waiting => (Some(fixture.take(true).await), None),
        NewerPlan::HandedOffAndGoneAfter => {
            let newer = fixture.take(true).await;
            hand_off(newer).await;
            (Some(newer), Some(newer))
        }
    };
    fresh_session_goes(plan_id).await;
    if let Some(goes_after) = goes_after {
        assert_eq!(fixture.state(plan_id), "waiting");
        fresh_session_goes(goes_after).await;
    }
    let plan_row_sql = "SELECT state || ' ' || holds_request || ' ' || \
        coalesce(fresh_session_id, '-') FROM plans WHERE id = ?1";
    let session_rows_sql = "SELECT id || ' ' || state || ' ' || holds_request || ' ' || \
        coalesce(fresh_session_id, '-') FROM plans WHERE session_id = ?1 ORDER BY id";

    assert_eq!(
        fixture
            .store
            .read_rows(plan_row_sql, plan_id.text().as_str()),
        [handed_off_row]
    );
    if let Some(newer) = newer {
        assert_eq!(fixture.state(newer), "waiting");
    }
    assert_eq!(
        fixture.store.read_rows(
            "SELECT CAST(count(*) AS TEXT) FROM plans WHERE session_id = ?1 AND state = 'waiting'",
            session_id.text().as_str(),
        ),
        ["1"]
    );
    let live = fixture
        .store
        .read_rows(session_rows_sql, session_id.text().as_str());
    rebuild_plans(&fixture).await;
    assert_eq!(
        fixture
            .store
            .read_rows(session_rows_sql, session_id.text().as_str()),
        live
    );
}

/// Writes the session's plan rows again from its log, through the plans projection's own fold.
async fn rebuild_plans(fixture: &Fixture) {
    let session_id = fixture.store.session_id;
    let page = fixture
        .store
        .event_log
        .read_after_cursor(EventReadAfterCursorRequest {
            session_id,
            after_cursor: None,
            limit: None,
        })
        .await
        .expect("the log reads");
    assert!(!page.has_more, "one page holds the test's log");
    let mut statements = PlansProjection.clear_statements(&session_id);
    let mut fold = PlansProjection.fold(&session_id);
    for envelope in &page.events {
        let event = SessionEvent::from_envelope(envelope).expect("each event reads");
        fold.apply(envelope, &event, &mut statements)
            .expect("each event folds");
    }
    fixture
        .store
        .writer
        .write(statements)
        .await
        .expect("the rebuilt rows are written");
}
