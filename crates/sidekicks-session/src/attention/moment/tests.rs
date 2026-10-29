use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::attention::AttentionMomentTrigger::{
    self, PendingApproval, PendingInput, RunCompleted, RunFailed,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::{
    AttentionChange, AttentionEnd, AttentionMoment, AttentionOpenEntries, AttentionRaise,
    AttentionWait, entry_change_of,
};

const SESSION: &str = "018f0000-0000-7000-8000-000000000001";
const RUN: &str = "018f0000-0000-7000-8000-000000000002";
const PLAN: &str = "018f0000-0000-7000-8000-000000000003";
const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const DEFINITION: &str = "018f0000-0000-7000-8000-000000000005";
const VERSION: &str = "018f0000-0000-7000-8000-000000000006";
const DEVICE: &str = "018f0000-0000-7000-8000-000000000007";
const ARTIFACT: &str = "018f0000-0000-7000-8000-000000000008";
const QUEUE_ITEM: &str = "018f0000-0000-7000-8000-000000000009";
const QUESTION: &str = "018f0000-0000-7000-8000-00000000000a";
const APPROVAL_REQUEST: &str = "018f0000-0000-7000-8000-00000000000b";
const ACCOUNT: &str = "018f0000-0000-7000-8000-00000000000c";
const AGENT: &str = "018f0000-0000-7000-8000-00000000000d";
const NODE: &str = "ask";

fn session_id() -> SessionId {
    SessionId::new(SESSION).expect("a test session id")
}

fn run_id() -> RunId {
    RunId::new(RUN).expect("a test run id")
}

fn plan_id() -> PlanId {
    PlanId::new(PLAN).expect("a test plan id")
}

fn workflow_run_id() -> WorkflowRunId {
    WorkflowRunId::new(WORKFLOW_RUN).expect("a test workflow run id")
}

fn step_key() -> WorkflowStepKey {
    WorkflowStepKey {
        workflow_run_id: workflow_run_id(),
        node_id: WorkflowNodeId::new(NODE.to_owned()).expect("a test node id"),
        attempt: SafeInt::new(1).expect("a test attempt"),
        execution_index: SafeInt::new(0).expect("a test execution index"),
    }
}

/// An `agent.run.<state>` event of the test run, with `extra` members on its payload.
fn run_state(state: &str, extra: Value) -> Value {
    let mut payload = json!({
        "sessionId": SESSION, "runId": RUN, "runVersion": 2,
        "previousState": "running", "newState": state,
    });
    if let (Some(payload), Value::Object(extra)) = (payload.as_object_mut(), extra) {
        payload.extend(extra);
    }
    json!({"type": format!("agent.run.{state}"), "payload": payload})
}

/// A step event of the test step, with `extra` members on its payload.
fn step_event(event_type: &str, extra: Value) -> Value {
    let mut payload = json!({
        "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN, "nodeId": NODE,
        "attempt": 1, "executionIndex": 0,
    });
    if let (Some(payload), Value::Object(extra)) = (payload.as_object_mut(), extra) {
        payload.extend(extra);
    }
    json!({"type": event_type, "payload": payload})
}

/// A workflow-run event of the test run.
fn workflow_run_event(event_type: &str) -> Value {
    json!({"type": event_type, "payload": {
        "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN,
        "definitionId": DEFINITION, "workflowVersionId": VERSION,
    }})
}

fn plan_proposed(holds_request: bool) -> Value {
    json!({"type": "plan.proposed", "payload": {
        "planId": PLAN, "sessionId": SESSION, "runId": RUN, "title": "Plan", "text": "Do it",
        "stepCount": 1, "fileCount": 0, "artifactId": ARTIFACT, "holdsRequest": holds_request,
    }})
}

fn raise_wait(wait: AttentionWait, trigger: AttentionMomentTrigger) -> AttentionChange {
    AttentionChange::Raise(AttentionRaise::Wait { wait, trigger })
}

fn resolve(entries: AttentionOpenEntries) -> AttentionChange {
    AttentionChange::Resolve {
        entries,
        then: None,
    }
}

fn resolve_run_then(then: AttentionRaise) -> AttentionChange {
    AttentionChange::Resolve {
        entries: AttentionOpenEntries::Run(run_id()),
        then: Some(then),
    }
}

fn run_end(trigger: AttentionMomentTrigger) -> AttentionChange {
    resolve_run_then(AttentionRaise::End {
        end: AttentionEnd::Run(run_id()),
        trigger,
    })
}

fn run_wait(trigger: AttentionMomentTrigger) -> AttentionChange {
    resolve_run_then(AttentionRaise::Wait {
        wait: AttentionWait::Run(run_id()),
        trigger,
    })
}

fn workflow_run_end(trigger: AttentionMomentTrigger) -> AttentionChange {
    AttentionChange::Resolve {
        entries: AttentionOpenEntries::WorkflowRun(workflow_run_id()),
        then: Some(AttentionRaise::End {
            end: AttentionEnd::WorkflowRun(workflow_run_id()),
            trigger,
        }),
    }
}

#[rstest]
#[case::waiting_for_approval(
    run_state("waitingForApproval", json!({})),
    run_wait(PendingApproval)
)]
#[case::waiting_for_input(
    run_state("waitingForInput", json!({})),
    run_wait(PendingInput)
)]
#[case::running_resolves(
    run_state("running", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::queued_resolves(
    json!({"type": "agent.run.queued", "payload": {
        "sessionId": SESSION, "runId": RUN, "runVersion": 0, "newState": "queued", "agentId": AGENT,
        "admittedProviderAccountId": "account-1",
    }}),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::starting_resolves(
    run_state("starting", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::pausing_resolves(
    run_state("pausing", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::paused_resolves(
    run_state("paused", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::completed(run_state("completed", json!({})), run_end(RunCompleted))]
#[case::completed_closed_by_the_daemon(
    run_state("completed", json!({"intendedClose": true})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::failed(run_state("failed", json!({})), run_end(RunFailed))]
#[case::failed_closed_by_the_daemon(
    run_state("failed", json!({"intendedClose": true})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::interrupted_by_the_person(
    run_state("interrupted", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::interrupted_at_the_step_limit(
    run_state("interrupted", json!({"trigger": "stepLimit"})),
    run_end(RunFailed)
)]
#[case::interrupted_at_the_spend_limit(
    run_state("interrupted", json!({"trigger": "spendLimit"})),
    run_end(RunFailed)
)]
#[case::interrupted_by_a_canceled_phase(
    run_state("interrupted", json!({"trigger": "workflowPhaseCanceled"})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::interrupted_by_a_restart(
    run_state("interrupted", json!({"trigger": "daemonRestart"})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::limit_closed_by_the_daemon(
    run_state("interrupted", json!({"trigger": "stepLimit", "intendedClose": true})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::stopped_at_the_token_limit(
    run_state("stopped", json!({"trigger": "tokenLimit"})),
    run_end(RunFailed)
)]
#[case::stopped_by_the_person(
    run_state("stopped", json!({})),
    resolve(AttentionOpenEntries::Run(run_id()))
)]
#[case::turn_started(
    json!({"type": "agent.turn.started", "payload": {
        "sessionId": SESSION, "runId": RUN, "runVersion": 0, "turnNumber": 1,
    }}),
    AttentionChange::Nothing
)]
#[case::step_limit_reached(
    json!({"type": "agent.run.stepLimit.reached", "payload": {
        "sessionId": SESSION, "runId": RUN, "count": 1,
    }}),
    AttentionChange::Nothing
)]
#[case::refusal_choice_requested(
    json!({"type": "agent.run.refusalChoice.requested", "payload": {
        "sessionId": SESSION, "runId": RUN, "refusedModel": "model-a", "fallbackModel": "model-b",
    }}),
    AttentionChange::Nothing
)]
#[case::rolled_back(
    json!({"type": "agent.run.rolledBack", "payload": {
        "sessionId": SESSION, "runId": RUN, "runVersion": 3, "targetPosition": 4,
    }}),
    AttentionChange::Nothing
)]
#[case::run_rejected(
    json!({"type": "agent.run.rejected", "payload": {"sessionId": SESSION, "reason": "busy"}}),
    AttentionChange::Nothing
)]
#[case::queue_item_canceled(
    json!({"type": "agent.queueItem.canceled", "payload": {
        "sessionId": SESSION, "queueItemId": QUEUE_ITEM, "state": "canceled",
    }}),
    AttentionChange::Nothing
)]
#[case::question_canceled(
    json!({"type": "question.canceled", "payload": {
        "sessionId": SESSION, "questionId": QUESTION, "reason": "withdrawn",
    }}),
    AttentionChange::Nothing
)]
#[case::approval_canceled(
    json!({"type": "approval.canceled", "payload": {
        "sessionId": SESSION, "runId": RUN, "approvalRequestId": APPROVAL_REQUEST,
        "category": "toolExecution", "scope": "once",
    }}),
    AttentionChange::Nothing
)]
#[case::session_pinned(
    json!({"type": "session.pinned", "payload": {
        "sessionId": SESSION, "at": "2026-01-01T00:00:00.000Z",
    }}),
    AttentionChange::Nothing
)]
#[case::request_retried(
    json!({"type": "usage.apiRequest.retried", "payload": {
        "sessionId": SESSION, "provider": "provider-a", "errorKind": "rateLimit",
    }}),
    AttentionChange::Nothing
)]
#[case::agent_message(
    json!({"type": "agent.message.sent", "payload": {
        "sessionId": SESSION, "runId": RUN, "providerMessageId": "m",
    }}),
    AttentionChange::Nothing
)]
#[case::user_message(
    json!({"type": "user.message.sent", "payload": {
        "sessionId": SESSION, "actor": "person", "message": "hi",
    }}),
    AttentionChange::NameChanged(session_id())
)]
#[case::plan_holding_no_request(
    plan_proposed(false),
    raise_wait(
        AttentionWait::Plan {
            plan_id: plan_id(),
            run_id: run_id(),
        },
        PendingInput
    )
)]
#[case::plan_holding_its_request(plan_proposed(true), AttentionChange::Nothing)]
#[case::plan_accepted(
    json!({"type": "plan.accepted", "payload": {
        "planId": PLAN, "sessionId": SESSION, "deviceId": DEVICE,
    }}),
    resolve(AttentionOpenEntries::Plan(plan_id()))
)]
#[case::plan_kept(
    json!({"type": "plan.kept", "payload": {
        "planId": PLAN, "sessionId": SESSION, "deviceId": DEVICE,
    }}),
    resolve(AttentionOpenEntries::Plan(plan_id()))
)]
#[case::plan_handed_off(
    json!({"type": "plan.handedOff", "payload": {
        "planId": PLAN, "sessionId": SESSION, "freshSessionId": DEFINITION, "deviceId": DEVICE,
    }}),
    resolve(AttentionOpenEntries::Plan(plan_id()))
)]
#[case::plan_hold_ended(
    json!({"type": "plan.hold.ended", "payload": {
        "planId": PLAN, "sessionId": SESSION, "reason": "runEnded",
    }}),
    AttentionChange::Nothing
)]
#[case::session_renamed(
    json!({"type": "session.renamed", "payload": {
        "sessionId": SESSION, "name": "Named", "origin": "user",
    }}),
    AttentionChange::NameChanged(session_id())
)]
#[case::session_muted(
    json!({"type": "session.muted", "payload": {
        "sessionId": SESSION, "at": "2026-01-01T00:00:00.000Z",
    }}),
    AttentionChange::WithdrawMuted(session_id())
)]
#[case::session_unmuted(
    json!({"type": "session.unmuted", "payload": {
        "sessionId": SESSION, "at": "2026-01-01T00:00:00.000Z",
    }}),
    AttentionChange::Nothing
)]
#[case::workflow_gate_reached(
    workflow_run_event("workflow.gate.reached"),
    AttentionChange::Nothing
)]
#[case::workflow_run_started(
    json!({"type": "workflow.run.started", "payload": {
        "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN, "definitionId": DEFINITION,
        "workflowVersionId": VERSION, "mode": "manual", "startedBy": {"kind": "schedule"},
    }}),
    AttentionChange::Nothing
)]
#[case::workflow_run_waiting(workflow_run_event("workflow.run.waiting"), AttentionChange::Nothing)]
#[case::step_waits_on_an_approval(
    step_event("workflow.phase.suspended", json!({"waitCause": "approval"})),
    raise_wait(AttentionWait::Step(step_key()), PendingInput)
)]
#[case::step_waits_on_a_form(
    step_event("workflow.phase.suspended", json!({"waitCause": "form"})),
    raise_wait(AttentionWait::Step(step_key()), PendingInput)
)]
#[case::step_waits_on_a_reply(
    step_event("workflow.phase.suspended", json!({"waitCause": "reply"})),
    raise_wait(AttentionWait::Step(step_key()), PendingInput)
)]
#[case::step_waits_on_its_chain(
    step_event("workflow.phase.suspended", json!({"waitCause": "chain"})),
    raise_wait(AttentionWait::Step(step_key()), PendingInput)
)]
#[case::step_waits_on_a_spent_account(
    step_event(
        "workflow.phase.suspended",
        json!({"waitCause": "account", "providerAccountId": ACCOUNT}),
    ),
    AttentionChange::Nothing
)]
#[case::step_resumed(
    step_event("workflow.phase.resumed", json!({})),
    resolve(AttentionOpenEntries::Step(step_key()))
)]
#[case::step_completed(
    step_event("workflow.step.completed", json!({
        "outputRef": {"kind": "inline", "items": []},
        "logRef": {"kind": "inline", "items": []},
    })),
    resolve(AttentionOpenEntries::Step(step_key()))
)]
#[case::step_failed(
    step_event("workflow.step.failed", json!({"error": {"message": "It broke"}})),
    resolve(AttentionOpenEntries::Step(step_key()))
)]
#[case::step_canceled(
    step_event("workflow.step.canceled", json!({})),
    resolve(AttentionOpenEntries::Step(step_key()))
)]
#[case::workflow_run_resumed(
    json!({"type": "workflow.run.resumed", "payload": {
        "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN, "definitionId": DEFINITION,
        "workflowVersionId": VERSION,
        "resumptionPoint": {"activeSteps": [], "pendingGates": []},
    }}),
    resolve(AttentionOpenEntries::WorkflowRun(workflow_run_id()))
)]
#[case::workflow_run_canceled(
    workflow_run_event("workflow.run.canceled"),
    resolve(AttentionOpenEntries::WorkflowRun(workflow_run_id()))
)]
#[case::workflow_run_completed(
    workflow_run_event("workflow.run.completed"),
    workflow_run_end(RunCompleted)
)]
#[case::workflow_run_failed(workflow_run_event("workflow.run.failed"), workflow_run_end(RunFailed))]
#[case::workflow_run_deleted(
    workflow_run_event("workflow.run.deleted"),
    AttentionChange::DeleteWorkflowRun(workflow_run_id())
)]
#[case::workflow_phase_started(
    step_event("workflow.phase.started", json!({})),
    AttentionChange::Nothing
)]
fn each_event_raises_resolves_or_deletes_its_entries(
    #[case] event: Value,
    #[case] expected: AttentionChange,
) {
    let event: SessionEvent = serde_json::from_value(event).expect("the test event reads");

    assert_eq!(entry_change_of(&event), expected);
}

#[test]
fn every_moment_id_fits_a_banner_tag_and_a_notify_id_hides_its_node() {
    let long_node = WorkflowNodeId::new("n".repeat(256)).expect("a long node id");
    let moments = [
        AttentionMoment::Run(run_id()),
        AttentionMoment::Plan(plan_id()),
        AttentionMoment::WorkflowRun(workflow_run_id()),
        AttentionMoment::Session(session_id()),
        AttentionMoment::Notify {
            workflow_run_id: workflow_run_id(),
            node_id: long_node,
            execution_index: SafeInt::new(7).expect("a test execution index"),
        },
    ];

    for moment in &moments {
        assert!(moment.id().as_str().len() <= 64, "{moment:?}");
    }
    assert_eq!(moments[4].id().as_str().len(), 39);

    let notify = |node: &str, execution_index| AttentionMoment::Notify {
        workflow_run_id: workflow_run_id(),
        node_id: WorkflowNodeId::new(node.to_owned()).expect("a test node id"),
        execution_index: SafeInt::new(execution_index).expect("a test execution index"),
    };
    assert_ne!(notify(NODE, 0).id(), notify(NODE, 1).id());
    assert_ne!(notify(NODE, 0).id(), notify("tell", 0).id());
}
