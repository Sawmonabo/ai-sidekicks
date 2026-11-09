//! A workflow gate card's answer made the gate's answer: its kind, its node and the decision's
//! context, with no engine.

use rstest::rstest;
use serde_json::json;
use sidekicks_approval::workflow_gate::ApprovalWaitAnswer;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::approval::holder::ApprovalHolder;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalScope,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::gate_resolution::{
    WorkflowGateApprovalCategory, WorkflowGateKind,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use super::gate_answer;

/// The answer `decision` to a card a wait of a fresh run holds, on the step of `node_id` or, with
/// none, on the chain's question, with the decline words `decline_reason`.
fn wait_answer(
    node_id: Option<WorkflowNodeId>,
    decision: ApprovalDecision,
    decline_reason: Option<NonEmptyText>,
) -> ApprovalWaitAnswer {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session's");
    let workflow_run_id =
        WorkflowRunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run's");
    let approval_request_id =
        ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's");
    let wait_id = UuidTextForm::from(mint_uuid_v7());
    let scope = ApprovalScope::new(session_id.text().as_str().to_owned()).expect("a scope");
    let device_id = DeviceId::new("test-device".to_owned()).expect("the test's device");
    let payload = ApprovalResolvedPayload {
        session_id,
        holder: ApprovalHolder::Wait {
            workflow_run_id,
            wait_id,
            node_id: node_id.clone(),
        },
        approval_request_id,
        category: ApprovalCategory::Gate,
        scope: scope.clone(),
        effective_scope: scope.clone(),
        device_id: device_id.clone(),
        client_resolution_id: ClientUuid::new(mint_uuid_v7().to_string())
            .expect("a minted UUID is a client's"),
        remembered_scope: None,
        decline_reason: decline_reason.clone(),
        edited_action: None,
    };
    let event = match decision {
        ApprovalDecision::Approved => SessionEvent::ApprovalApproved(payload),
        ApprovalDecision::Rejected => SessionEvent::ApprovalRejected(payload),
    };
    ApprovalWaitAnswer {
        session_id,
        approval_request_id,
        workflow_run_id,
        wait_id,
        node_id,
        category: ApprovalCategory::Gate,
        scope,
        resource_descriptor: JsonRecord::default(),
        decision,
        decline_reason,
        device_id,
        resolved_at: WireInstant::try_from("2026-10-02T00:05:00.000Z".to_owned())
            .expect("an instant"),
        statements: Vec::new(),
        event,
    }
}

/// A step card's answer is a `human.approval` gate's naming the step's node, and a chain card's a
/// chain gate's naming none; the card's ask, decision, device and instant carry over, and a
/// Decline's words ride the decision's context beside the scope and the resource. Kills: the kind
/// picked wrong; the node dropped; the decline words lost.
#[rstest]
#[case::step_approved(true, ApprovalDecision::Approved, None)]
#[case::step_declined(true, ApprovalDecision::Rejected, Some("use the test database"))]
#[case::chain_approved(false, ApprovalDecision::Approved, None)]
fn a_cards_answer_is_its_gates_answer(
    #[case] is_step: bool,
    #[case] decision: ApprovalDecision,
    #[case] words: Option<&str>,
) {
    let node_id =
        is_step.then(|| WorkflowNodeId::new("approve".to_owned()).expect("the test's node id"));
    let decline_reason =
        words.map(|words| NonEmptyText::new(words.to_owned()).expect("the test's words"));
    let answer = wait_answer(node_id.clone(), decision, decline_reason);
    let expected_card_event = answer.event.clone();
    let (approval_request_id, workflow_run_id, scope, device_id, resolved_at) = (
        answer.approval_request_id,
        answer.workflow_run_id,
        answer.scope.clone(),
        answer.device_id.clone(),
        answer.resolved_at.clone(),
    );

    let (gate, card) = gate_answer(answer);

    let kind = if is_step {
        WorkflowGateKind::HumanApproval
    } else {
        WorkflowGateKind::Chain
    };
    assert_eq!((gate.gate, gate.node_id), (kind, node_id));
    assert_eq!(
        (
            gate.workflow_run_id,
            gate.approval_request_id,
            gate.outcome,
            gate.device_id,
            gate.resolved_at,
            gate.approval_category,
        ),
        (
            workflow_run_id,
            approval_request_id,
            decision,
            device_id,
            resolved_at,
            Some(WorkflowGateApprovalCategory::Gate),
        )
    );
    let mut context = json!({ "scope": scope, "resourceDescriptor": {} });
    if let Some(words) = words {
        context["declineReason"] = json!(words);
    }
    assert_eq!(
        serde_json::to_value(&gate.decision_context).expect("a record writes as JSON"),
        context
    );
    assert_eq!(card.event, expected_card_event);
}
