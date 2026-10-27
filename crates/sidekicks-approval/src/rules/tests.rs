//! The standing rules over the approval fixture and a test database: rules in a skipped range,
//! revokes whose provider failed, and the list of an unknown session.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalResolveRequest, RememberedRuleSense, RememberedScopeKind,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::port::permission_ask::ProviderAnswerRule;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::session::insert::{SessionEventRow, monotonic_ns_now};
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

use super::{
    APPROVAL_RULES_STATEMENT_CAPACITY, ApprovalRuleError, ApprovalRules, SELECT_RULES_IN_FORCE_SQL,
    provider_rule_of, query_rule_rows, rule_over,
};
use crate::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::schema::schema_parts;
use crate::service::tests::{ApprovalFixture, from_json};

// Appends the event `event` describes to the session's log and answers its sequence.
async fn append(writer: &DatabaseWriter, session_id: SessionId, event: serde_json::Value) -> i64 {
    let event: SessionEvent =
        serde_json::from_value(event).expect("the test writes a valid session event");
    let envelope = test_envelope(session_id, &event);
    let row = SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns: monotonic_ns_now(),
        content_payload: None,
    };
    let sequences = writer
        .append_events(vec![row], Vec::new())
        .await
        .expect("the event is kept");
    i64::from(sequences[0])
}

// A rule whose event lies in a range the session continued past as damaged is neither in force
// nor listed, while one outside it still is; a read of the rule events that keeps the skipped
// range applies the skipped rule and fails.
#[tokio::test]
async fn a_rule_remembered_in_a_skipped_range_is_not_in_force() {
    let database = TestDatabase::new(schema_parts());
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let reader = database.reader();
    let mut rule_sequences = Vec::new();
    for subject in ["npm run", "cargo test"] {
        let ask_id = mint_uuid_v7().to_string();
        let run_id = mint_uuid_v7().to_string();
        // The ask's row as its request wrote it, naming the action whose kind the rule takes.
        let descriptor = json!({
            "subject": subject,
            "standingAllowOffered": true,
            "projectScopeOffered": true,
            "editable": true,
            "action": { "kind": "command", "command": format!("{subject} build") },
        });
        reader
            .execute(
                "INSERT INTO approval_requests (id, session_id, run_id, requested_by, category,
                   scope, resource_descriptor, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'agent-1', 'toolExecution', ?4, ?5,
                   '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
                (
                    ask_id.as_str(),
                    session_id.text().as_str(),
                    run_id.as_str(),
                    format!("{subject} build"),
                    descriptor.to_string(),
                ),
            )
            .expect("the ask's row is written");
        let remembered = json!({
            "type": "approval.rule.remembered",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "approvalRequestId": ask_id,
                "category": "toolExecution",
                "scope": format!("{subject} build"),
                "machineId": "machine-1",
                "ruleId": ask_id,
                "rememberedScope": { "kind": "session", "pattern": subject, "sense": "allow" },
            },
        });
        rule_sequences.push(append(&writer, session_id, remembered).await);
    }
    let skipped = json!({
        "type": "session.damagedEvents.skipped",
        "payload": {
            "sessionId": session_id,
            "fromSequence": rule_sequences[0],
            "toSequence": rule_sequences[0],
        },
    });
    append(&writer, session_id, skipped).await;

    let in_force = query_rule_rows(&reader, &SELECT_RULES_IN_FORCE_SQL, session_id)
        .expect("the rules in force read");

    assert!(rule_over(&in_force, ProviderAskActionKind::Command, "npm run").is_none());
    assert_eq!(
        in_force
            .iter()
            .map(|row| provider_rule_of(row).subject)
            .collect::<Vec<_>>(),
        vec!["cargo test".to_owned()]
    );
}

// A revoke of a project rule whose provider failed: before the record, out of a project's rule
// file, it is refused `approval.rule.notKept` naming the rule and the rule stays in force; after
// the record, handing a session its rules again, it is a fault and the rule is revoked. Killed by
// answering the rule-file failure as the provider's raw error.
#[rstest]
#[case::rule_file_kept(true)]
#[case::hand_out_failed(false)]
#[tokio::test]
async fn a_revoke_answers_not_kept_only_while_the_rule_file_keeps_it(
    #[case] fails_in_rule_file: bool,
) {
    let approvals = ApprovalFixture::without_holds().await;
    let session = approvals.session_id.text();
    let [project, mount] = project_and_mount_rows("mount", None);
    approvals.execute(&format!(
        "UPDATE sessions SET shape = 'project'; {project}; {mount};
         INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
           created_at, updated_at)
         VALUES ('workspace', '{}', 'mount', 'provisionedWorktree', '/repos/app/worktree',
           'ready', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');",
        session.as_str()
    ));
    let is_failing = Arc::new(AtomicBool::new(false));
    let failing = Arc::clone(&is_failing);
    let rules = ApprovalRules::new(
        Arc::new(DatabaseReadPool::new(
            approvals.database.path(),
            APPROVAL_RULES_STATEMENT_CAPACITY,
        )),
        Arc::clone(&approvals.events),
        MachineId::new("machine".to_owned()).expect("the id is short"),
        Box::new(move |params| {
            let is_rule_file = params.project_folder.is_some();
            let fails = failing.load(Ordering::SeqCst) && is_rule_file == fails_in_rule_file;
            async move {
                if fails {
                    Err(DriverError::Internal("the provider could not write".into()))
                } else {
                    Ok(())
                }
            }
            .boxed()
        }),
        Arc::new(ShellLineReadingBound::new(1024)),
    );
    let card = approvals
        .service
        .create(
            ApprovalRequestCreateRequest {
                session_id: approvals.session_id,
                run_id: approvals.run_id,
                requested_by: from_json(json!("agent")),
                category: ApprovalCategory::ToolExecution,
                scope: from_json(json!("npm test")),
                resource_descriptor: from_json(json!({
                    "subject": "npm test",
                    "standingAllowOffered": true,
                    "projectScopeOffered": true,
                    "editable": false,
                    "action": { "kind": "command", "command": "npm test" },
                })),
            },
            ApprovalRequestOrigin {
                ask_id: Some(from_json(json!(mint_uuid_v7()))),
                tool_call_id: None,
            },
        )
        .await
        .expect("the rule's card is raised");
    let answer: ApprovalResolveRequest = from_json(json!({
        "decision": "approved",
        "approvalRequestId": card.approval_request_id,
        "clientResolutionId": mint_uuid_v7().to_string(),
        "rememberedScope": { "kind": "project", "pattern": "npm test", "sense": "allow" },
    }));
    let resolved = approvals
        .service
        .resolve(&answer, from_json(json!("device-1")))
        .await
        .expect("the rule's card is answered");
    let made = ProviderAnswerRule {
        rule: ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense: RememberedRuleSense::Allow,
            action: ProviderAskActionKind::Command,
            subject: "npm test".to_owned(),
        },
        project_folders: Vec::new(),
    };
    rules
        .record(&resolved.request, &made)
        .await
        .expect("the provider kept the rule");
    let rule_id = rules
        .list(approvals.session_id)
        .await
        .expect("the rules read")
        .rules[0]
        .rule_id;

    is_failing.store(true, Ordering::SeqCst);
    let failure = rules
        .revoke(rule_id)
        .await
        .expect_err("the provider's failure fails the revoke");
    let in_force = rules
        .list(approvals.session_id)
        .await
        .expect("the rules read")
        .rules;

    match HandlerError::from(failure) {
        HandlerError::Refused(DomainError { code, detail, .. }) if fails_in_rule_file => {
            assert_eq!(code, RefusalCode::ApprovalRuleNotKept);
            assert_eq!(
                detail.and_then(|detail| detail.get("ruleId").cloned()),
                Some(json!(rule_id))
            );
            assert_eq!(in_force.len(), 1, "the rule still applies: {in_force:?}");
        }
        HandlerError::Internal(_) if !fails_in_rule_file => {
            assert!(in_force.is_empty(), "the revoke was recorded: {in_force:?}");
        }
        other @ (HandlerError::Refused(_) | HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("the revoke answered {other:?}")
        }
    }
}

// A list of the rules of a session with no row is refused `session.notFound`, and a held session
// lists its rules, none yet. Killed by dropping the existence read from `list`, which answers the
// unknown session with no rules.
#[tokio::test]
async fn a_rule_list_of_an_unknown_session_is_refused() {
    let approvals = ApprovalFixture::without_holds().await;
    let rules = ApprovalRules::new(
        Arc::new(DatabaseReadPool::new(
            approvals.database.path(),
            APPROVAL_RULES_STATEMENT_CAPACITY,
        )),
        Arc::clone(&approvals.events),
        MachineId::new("machine".to_owned()).expect("the id is short"),
        Box::new(|_params| async { Ok(()) }.boxed()),
        Arc::new(ShellLineReadingBound::new(1024)),
    );

    let refused = rules.list(test_session_id()).await;
    assert!(
        matches!(&refused, Err(ApprovalRuleError::Refused(refusal))
            if refusal.code == RefusalCode::SessionNotFound),
        "an unknown session is refused: {refused:?}"
    );

    let listed = rules
        .list(approvals.session_id)
        .await
        .expect("a held session's rules are listed");
    assert!(listed.rules.is_empty(), "{listed:?}");
}
