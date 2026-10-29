use serde_json::json;
use sidekicks_contracts::attention::{
    AttentionItem, AttentionProjection, AttentionSeenSubject, AttentionSeverity,
    AttentionSubscribeRequest, AttentionSubscribeScope,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::read_attention_projection;
use crate::attention::seen::write_seen;
use crate::attention::test_log::AttentionTestLog;

const SESSION_NAME: &str = "Release notes";
const PLAN: &str = "018f0000-0000-7000-8000-000000000003";
const ARTIFACT: &str = "018f0000-0000-7000-8000-000000000008";

/// A test log whose session has its directory row, named [`SESSION_NAME`].
async fn named_session_log() -> AttentionTestLog {
    let log = AttentionTestLog::new().await;
    insert_session_row(
        &log.database.reader(),
        log.session_id.text().as_str(),
        Some(SESSION_NAME),
        None,
    );
    log
}

fn read(log: &AttentionTestLog, request: AttentionSubscribeRequest) -> AttentionProjection {
    read_attention_projection(&log.database.reader(), &request).expect("the projection reads")
}

/// The session's aggregate as its severity and seen fact, `None` when nothing contributes.
fn aggregate(log: &AttentionTestLog) -> Option<(AttentionSeverity, bool)> {
    let projection = read(
        log,
        AttentionSubscribeRequest {
            session_id: Some(log.session_id),
            scope: Some(AttentionSubscribeScope::Session),
            run_id: None,
        },
    );
    match projection.items.as_slice() {
        [] => None,
        [AttentionItem::Moment(item)] => {
            assert_eq!(item.run_id, None, "the aggregate names no run");
            assert_eq!(item.banner_state, None, "the aggregate has no banner");
            Some((item.severity, item.seen))
        }
        other => panic!("one aggregate at most, read {other:?}"),
    }
}

async fn mark_session_seen(log: &AttentionTestLog) {
    write_seen(
        &log.writer,
        &AttentionSeenSubject {
            session_id: log.session_id,
            run_id: None,
        },
    )
    .await
    .expect("the seen mark is written");
}

/// Mutations: the aggregate's severity taken from its first contributor in either order, where an
/// informational Finished stands first and last; the seen filter dropped from its contributors.
#[tokio::test]
async fn two_waits_keep_the_aggregate_actionable_until_both_resolve_and_a_seen_finish_drops_out() {
    let log = named_session_log().await;
    let [first_finished, approval, input, last_finished] = [(); 4].map(|()| log.run(None));
    log.append(log.run_state(first_finished, "completed", 2, json!({})))
        .await;
    log.append(log.run_state(approval, "waitingForApproval", 2, json!({})))
        .await;
    log.append(log.run_state(input, "waitingForInput", 2, json!({})))
        .await;
    log.append(log.run_state(last_finished, "completed", 2, json!({})))
        .await;
    assert_eq!(
        aggregate(&log),
        Some((AttentionSeverity::Actionable, false))
    );

    log.append(log.run_state(approval, "running", 3, json!({})))
        .await;
    assert_eq!(
        aggregate(&log),
        Some((AttentionSeverity::Actionable, false)),
        "one wait still open"
    );

    log.append(log.run_state(input, "running", 3, json!({})))
        .await;
    assert_eq!(
        aggregate(&log),
        Some((AttentionSeverity::Informational, false)),
        "the unseen Finished entries remain"
    );

    mark_session_seen(&log).await;
    assert_eq!(aggregate(&log), None, "a seen Finished drops out");
}

/// Mutation: a name, state word or any other field built from an event's payload text.
#[tokio::test]
async fn an_entry_carries_none_of_its_plan_text() {
    let log = named_session_log().await;
    let run_id = log.run(None);
    let sentence = "Move the billing tables onto the second cluster tonight";
    log.append(json!({"type": "plan.proposed", "payload": {
        "planId": PLAN, "sessionId": log.session_id, "runId": run_id, "title": sentence,
        "text": sentence, "stepCount": 1, "fileCount": 0, "artifactId": ARTIFACT,
        "holdsRequest": false,
    }}))
    .await;
    log.append(log.run_state(run_id, "waitingForInput", 2, json!({})))
        .await;

    let projection = read(
        &log,
        AttentionSubscribeRequest {
            session_id: Some(log.session_id),
            scope: None,
            run_id: None,
        },
    );

    // The plan's wait, the run's wait and the aggregate.
    assert_eq!(projection.items.len(), 3);
    for item in &projection.items {
        let AttentionItem::Moment(item) = item else {
            panic!("no Notify step ran");
        };
        assert_eq!(
            (item.display_name.as_str(), item.state_word.as_str()),
            (SESSION_NAME, "Waiting on you")
        );
    }
    let served = serde_json::to_string(&projection).expect("the projection writes");
    assert!(!served.contains("billing"), "{served}");
}

/// Mutation: the plan's run id dropped from its wait or from the entry's insert, which serves the
/// plan's entry with no `runId`, the session aggregate's shape.
#[tokio::test]
async fn a_plan_entry_names_the_run_that_proposed_it() {
    let log = named_session_log().await;
    let run_id = log.run(None);
    log.append(json!({"type": "plan.proposed", "payload": {
        "planId": PLAN, "sessionId": log.session_id, "runId": run_id, "title": "Plan",
        "text": "Do it", "stepCount": 1, "fileCount": 0, "artifactId": ARTIFACT,
        "holdsRequest": false,
    }}))
    .await;

    let projection = read(
        &log,
        AttentionSubscribeRequest {
            session_id: None,
            scope: None,
            run_id: None,
        },
    );

    let [AttentionItem::Moment(plan_entry)] = projection.items.as_slice() else {
        panic!("the plan's one entry reads: {projection:?}");
    };
    assert_eq!(
        plan_entry.run_id.as_ref().map(|id| id.as_str().to_owned()),
        Some(run_id.to_string())
    );
}

/// Mutation: seen read by comparing the entry's or its event's instant with the mark's.
#[tokio::test]
async fn an_entry_committed_after_the_seen_mark_in_its_millisecond_reads_unseen() {
    let log = named_session_log().await;
    let [before, after]: [RunId; 2] = [(); 2].map(|()| log.run(None));
    // Every event at one past instant: only the log's order tells the two apart.
    let at_one_instant = || SessionEventLinkage {
        occurred_at: Some(
            WireInstant::try_from("2026-10-18T09:00:00.000Z".to_owned())
                .expect("the test instant reads"),
        ),
        ..SessionEventLinkage::default()
    };
    log.append_with(
        log.run_state(before, "completed", 2, json!({})),
        at_one_instant(),
    )
    .await;
    mark_session_seen(&log).await;
    log.append_with(
        log.run_state(after, "completed", 2, json!({})),
        at_one_instant(),
    )
    .await;

    let projection = read(
        &log,
        AttentionSubscribeRequest {
            session_id: None,
            scope: None,
            run_id: None,
        },
    );
    let seen_of = |run_id: RunId| {
        projection
            .items
            .iter()
            .find_map(|item| match item {
                AttentionItem::Moment(item)
                    if item.run_id.as_ref().map(|id| id.as_str())
                        == Some(run_id.to_string().as_str()) =>
                {
                    Some(item.seen)
                }
                AttentionItem::Moment(_)
                | AttentionItem::Notify(_)
                | AttentionItem::ProviderBuild(_) => None,
            })
            .expect("the run's Finished entry reads")
    };
    assert_eq!((seen_of(before), seen_of(after)), (true, false));
}
