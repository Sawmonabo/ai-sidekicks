use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::app_link::AppLinkTarget;
use sidekicks_contracts::attention::AttentionItem;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::schema::session_directory::insert_session_row;

use super::{WebAddressMessage, read_message_body};
use crate::attention::test_log::AttentionTestLog;

const MACHINE: &str = "studio-mac";
const SESSION: &str = "018f0000-0000-7000-8000-000000000001";
const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const PLAN: &str = "018f0000-0000-7000-8000-000000000003";
const ARTIFACT: &str = "018f0000-0000-7000-8000-000000000008";
const SENTENCE: &str = "Move the billing tables onto the second cluster tonight";

/// The members every stored item carries, as an entry raised at 09:00 and still open.
fn item(arm: Value) -> AttentionItem {
    let mut item = json!({
        "id": "entry-1", "momentId": "moment-1", "sessionId": SESSION,
        "displayName": "Nightly bump", "sourceEventId": "event-1",
        "createdAt": "2026-10-29T09:00:00.000Z", "bannerState": "pending",
        "webAddressState": "pending", "webAddressAttemptCount": 0, "seen": false,
    });
    if let (Some(item), Value::Object(arm)) = (item.as_object_mut(), arm) {
        item.extend(arm);
    }
    serde_json::from_value(item).expect("the test item reads")
}

fn body_of(item: &AttentionItem, subject: &AppLinkTarget) -> Value {
    let message = WebAddressMessage::of_item(item, subject, MACHINE).expect("the item is sent");
    serde_json::from_slice(&message.to_body()).expect("the body is JSON")
}

/// Mutations: a wrong kind for a trigger; the Notify step's notice left out of its text; the
/// subject's type or link taken from the wrong id; `content` dropped or differing from `text`.
#[rstest]
#[case::an_approval("pendingApproval", "actionable", "Waiting on you", "waitingOnYou")]
#[case::an_answer("pendingInput", "actionable", "Waiting on you", "waitingOnYou")]
#[case::a_finish("runCompleted", "informational", "Finished", "finished")]
#[case::a_failure("runFailed", "informational", "Failed", "failed")]
fn a_moment_is_named_by_its_session_with_its_kind(
    #[case] trigger: &str,
    #[case] severity: &str,
    #[case] state: &str,
    #[case] kind: &str,
) {
    let moment = item(json!({
        "runId": "run-1", "trigger": trigger, "severity": severity, "stateWord": state,
    }));
    let subject = AppLinkTarget::Session {
        session_id: serde_json::from_value(json!(SESSION)).expect("a test session id"),
    };
    let text = format!("Nightly bump · {state}");
    assert_eq!(
        body_of(&moment, &subject),
        json!({
            "text": text, "kind": kind, "state": state,
            "subject": {"type": "session", "id": SESSION, "name": "Nightly bump"},
            "momentId": "moment-1", "at": "2026-10-29T09:00:00.000Z", "machine": MACHINE,
            "link": format!("sidekicks://session/{SESSION}"), "content": text,
        })
    );
}

/// Mutation: the Notify step's notice left out of its text, or its run named as a session.
#[test]
fn a_notify_step_is_its_runs_name_and_its_notice() {
    let notify = item(json!({
        "runId": WORKFLOW_RUN, "trigger": "workflowNotify", "severity": "informational",
        "stepId": "tell", "stateWord": "Deployed to staging",
    }));
    let subject = AppLinkTarget::WorkflowRun {
        workflow_run_id: WorkflowRunId::new(WORKFLOW_RUN).expect("a test workflow run id"),
    };
    let body = body_of(&notify, &subject);
    assert_eq!(body["text"], "Nightly bump · Deployed to staging");
    assert_eq!(body["kind"], "notifyStep");
    assert_eq!(
        body["subject"],
        json!({"type": "run", "id": WORKFLOW_RUN, "name": "Nightly bump"})
    );
    assert_eq!(
        body["link"],
        format!("sidekicks://workflow-run/{WORKFLOW_RUN}")
    );
    assert_eq!(body["content"], body["text"]);
}

/// Mutations: a transcript field reaching the body; the first message's opening restored as an
/// untitled session's name.
#[rstest]
#[case::a_named_session(Some("Release notes"), SessionShape::Chat, "Release notes")]
#[case::an_untitled_chat(None, SessionShape::Chat, "New chat")]
#[case::an_untitled_project_session(None, SessionShape::Project, "New session")]
#[tokio::test]
async fn a_message_names_its_session_and_never_a_word_of_its_transcript(
    #[case] name: Option<&str>,
    #[case] shape: SessionShape,
    #[case] shown: &str,
) {
    let log = AttentionTestLog::new().await;
    let reader = log.database.reader();
    insert_session_row(&reader, log.session_id.text().as_str(), name, None);
    reader
        .execute(
            "UPDATE sessions SET shape = ?2, first_message_preview = ?3 WHERE id = ?1",
            (
                log.session_id.text().as_str(),
                <&'static str>::from(shape),
                SENTENCE,
            ),
        )
        .expect("the test sets the session's shape and first message");
    let [planning_run, run_id] = [(); 2].map(|()| log.run(None));
    log.append(json!({"type": "plan.proposed", "payload": {
        "planId": PLAN, "sessionId": log.session_id, "runId": planning_run, "title": SENTENCE,
        "text": SENTENCE, "stepCount": 1, "fileCount": 0, "artifactId": ARTIFACT,
        "holdsRequest": false,
    }}))
    .await;
    log.append(log.run_state(run_id, "waitingForInput", 2, json!({})))
        .await;
    let entry = log.entry_of(run_id);

    let body = read_message_body(&reader, &entry, MACHINE)
        .expect("the entry reads")
        .expect("the entry is sent");

    let text = String::from_utf8(body).expect("the body is UTF-8");
    assert!(!text.contains("billing"), "{text}");
    let body: Value = serde_json::from_str(&text).expect("the body is JSON");
    assert_eq!(body["text"], format!("{shown} · Waiting on you"));
    assert_eq!(body["subject"]["type"], "session");
    assert_eq!(body["subject"]["name"], shown);
    assert_eq!(body["momentId"], format!("run:{run_id}"));
    assert_eq!(
        read_message_body(&reader, "no-such-entry", MACHINE).expect("the read runs"),
        None
    );
}
