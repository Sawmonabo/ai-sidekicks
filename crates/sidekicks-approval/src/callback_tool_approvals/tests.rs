//! The seam over the permission asks' fixture: the session's level stored apart from its run's
//! posture, every call answered through the intake as a client answers it, alone and through the
//! callback-tool host.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use serde_json::{Map, json};
use sidekicks_contracts::approval::ApprovalResolveRequest;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_provider::callback_tools::host::test_host::TestCallbackToolHost;
use sidekicks_provider::callback_tools::host::{
    CallbackToolApprovalBasis, CallbackToolApprovalOutcome, CallbackToolApprovalSeam,
    CallbackToolPortError,
};
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use sidekicks_provider::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_provider::port::permission_ask::ProviderAskAction;
use sidekicks_provider::run::posture::CURATED_CREDENTIAL_POLICY_REF;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate};
use tokio::task::JoinHandle;

use super::{
    CallbackToolApprovalError, CallbackToolApprovals, CallbackToolGate, UNGATED_TOOL_REFUSAL,
};
use crate::permission_asks::tests::{AsksFixture, device};
use crate::permission_check::{NO_LEVEL_REFUSAL, WORKFLOW_START_REFUSAL};
use crate::service::test_fixture::SETTLE_WAIT;
use crate::service::tests::from_json;

// A tool that only reads, one that acts, and one that starts a workflow.
const READ_TOOL: &str = "session_list";
const SEND_TOOL: &str = "session_send";
const START_TOOL: &str = "workflow_start";

#[expect(
    clippy::unnecessary_wraps,
    reason = "a workflow start's reader answers `None` for arguments that name no workflow"
)]
fn named_workflow(_arguments: &Map<String, serde_json::Value>) -> Option<WorkflowDefinitionId> {
    Some(
        WorkflowDefinitionId::new("0190c8a0-0000-7000-8000-000000000002")
            .expect("the text is a version 7 UUID"),
    )
}

/// The seam under test over the fixture, with each provider's id by whether it asks before the
/// app's own tools itself.
struct SeamFixture {
    asks: AsksFixture,
    seam: Arc<CallbackToolApprovals>,
    providers: Arc<ProviderRegistry>,
    asking: ProviderId,
    unasked: ProviderId,
}

impl SeamFixture {
    async fn new() -> Self {
        Self::over(AsksFixture::new().await)
    }

    /// The seam over a check deciding workflow starts by `authorizer`.
    async fn deciding_by(authorizer: Authorizer) -> Self {
        Self::over(AsksFixture::deciding_by(authorizer).await)
    }

    fn over(asks: AsksFixture) -> Self {
        let providers = Arc::new(registry_of_first_providers(
            PROVIDERS
                .iter()
                .map(|_descriptor| Arc::new(MockProviderDriver::new()) as _)
                .collect(),
        ));
        let gates = HashMap::from([
            (READ_TOOL.to_owned(), CallbackToolGate::Read),
            (SEND_TOOL.to_owned(), CallbackToolGate::Level),
            (
                START_TOOL.to_owned(),
                CallbackToolGate::WorkflowStart {
                    workflow_id_of: named_workflow,
                },
            ),
        ]);
        let seam = Arc::new(CallbackToolApprovals::new(
            Arc::clone(&asks.check.check),
            Arc::clone(&providers),
            gates,
        ));
        let provider_where = |asks_itself: bool| {
            let descriptor = PROVIDERS
                .iter()
                .find(|descriptor| descriptor.callback_tools_asked == asks_itself)
                .expect("the table holds a provider of each kind");
            ProviderId::new(descriptor.id.to_owned()).expect("a table id")
        };
        Self {
            seam,
            providers,
            asking: provider_where(true),
            unasked: provider_where(false),
            asks,
        }
    }

    fn invocation(&self, tool: &str) -> CallbackToolInvocation {
        CallbackToolInvocation {
            tool_name: FreeFormText::new(tool.to_owned()).expect("a short tool name"),
            arguments: Map::new(),
            tool_call_id: ToolCallId::new(mint_uuid_v7().to_string()).expect("a short id"),
            session_id: self.asks.check.approvals.session_id,
            run_id: self.asks.check.approvals.run_id,
        }
    }

    /// How the seam settles a call of `tool` from `provider`'s run, which asks no person.
    async fn decide(&self, tool: &str, provider: &ProviderId) -> CallbackToolApprovalOutcome {
        tokio::time::timeout(
            SETTLE_WAIT,
            self.seam.evaluate(&self.invocation(tool), provider),
        )
        .await
        .expect("the call settles with no card")
        .expect("the seam adjudicates")
    }

    /// Resolves the run's posture, so its calls are its running run's.
    async fn resolve_posture(&self) {
        let check = &self.asks.check;
        let posture = posture_at("sandboxed");
        check
            .postures
            .assert_run_ready(&RunSetupContext {
                run_id: check.approvals.run_id,
                session_id: check.approvals.session_id,
                queue_item: None,
                workspace_id: None,
                execution_posture: posture,
            })
            .await
            .expect("the run's posture resolves");
    }

    /// A host over the seam with `provider`'s spawn offering the three tools.
    fn host(&self, provider: &ProviderId) -> Arc<TestCallbackToolHost> {
        Arc::new(TestCallbackToolHost::new(
            Arc::clone(&self.seam) as _,
            self.asks.check.approvals.session_id,
            provider.clone(),
            &[READ_TOOL, SEND_TOOL, START_TOOL],
        ))
    }

    /// A call of the acting tool from the run of a provider that does not ask itself, waiting on
    /// its card, and that card's id.
    async fn raise(
        &self,
    ) -> (
        JoinHandle<Result<CallbackToolApprovalOutcome, CallbackToolPortError>>,
        String,
    ) {
        let seam = Arc::clone(&self.seam);
        let invocation = self.invocation(SEND_TOOL);
        let provider = self.unasked.clone();
        self.raise_by(async move { seam.evaluate(&invocation, &provider).await })
            .await
    }

    /// `call` on its own task once it has raised its one new card, and that card's id.
    async fn raise_by<T: Send + 'static>(
        &self,
        call: impl Future<Output = T> + Send + 'static,
    ) -> (JoinHandle<T>, String) {
        let waiting = self.asks.pending_cards();
        let call = tokio::spawn(call);
        let card = tokio::time::timeout(SETTLE_WAIT, async {
            loop {
                if let Some(card) = self
                    .asks
                    .pending_cards()
                    .into_iter()
                    .find(|card| !waiting.contains(card))
                {
                    return card;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the call raises its card");
        (call, card)
    }

    /// Answers `card` as a client does, with the members `answer` adds.
    async fn answer(&self, card: &str, answer: serde_json::Value) {
        let mut request = json!({
            "approvalRequestId": card,
            "clientResolutionId": mint_uuid_v7().to_string(),
        });
        if let (Some(members), serde_json::Value::Object(answer)) =
            (request.as_object_mut(), answer)
        {
            members.extend(answer);
        }
        let request: ApprovalResolveRequest = from_json(request);
        self.asks
            .asks
            .resolve(&request, device())
            .await
            .expect("the card is answered");
    }

    fn set_level(&self, level: &str) {
        self.asks
            .check
            .approvals
            .execute(&format!("UPDATE sessions SET permission_level = '{level}'"));
    }
}

// The posture at the level whose wire word is `mode`, writing nowhere.
fn posture_at(mode: &str) -> ExecutionPosture {
    from_json(json!({
        "mode": mode,
        "credentialPolicyRef": CURATED_CREDENTIAL_POLICY_REF,
        "writableRoots": [],
    }))
}

async fn settled<T>(call: JoinHandle<T>) -> T {
    tokio::time::timeout(SETTLE_WAIT, call)
        .await
        .expect("the call settles")
        .expect("the call's task ends")
}

fn allow(basis: CallbackToolApprovalBasis) -> CallbackToolApprovalOutcome {
    CallbackToolApprovalOutcome::Allow { basis }
}

// A call of the app's own tools is gated by the calling session's stored level, never its run's
// posture: a tool with no gate is refused, a read runs, a provider that asks itself has asked,
// a level that asks raises the card, whose decline sends the person's words and whose "Always
// allow" keeps a session rule the daemon alone keeps, hands no provider and answers no provider's
// ask, Sandboxed runs the call, and a card's wait settled stopped fails the call. Killed by
// dropping the refusal of a tool with no gate, by reading the run's posture in place of the
// session's level, by not recording the daemon card's rule, by inverting which keeper a rule
// has, and by handing a rule the daemon keeps to a provider.
#[tokio::test]
async fn a_call_of_the_apps_own_tools_is_gated_by_the_sessions_level() {
    let fixture = SeamFixture::new().await;
    let check = &fixture.asks.check;
    fixture.set_level("ask");
    fixture.resolve_posture().await;

    assert_eq!(
        fixture.decide("browser_open", &fixture.unasked).await,
        CallbackToolApprovalOutcome::Deny {
            basis: CallbackToolApprovalBasis::Policy,
            reason: UNGATED_TOOL_REFUSAL.to_owned(),
        }
    );
    assert_eq!(
        fixture.decide(READ_TOOL, &fixture.unasked).await,
        allow(CallbackToolApprovalBasis::Policy)
    );
    assert_eq!(
        fixture.decide(SEND_TOOL, &fixture.asking).await,
        allow(CallbackToolApprovalBasis::Policy)
    );

    let (declined, card) = fixture.raise().await;
    fixture
        .answer(
            &card,
            json!({ "decision": "rejected", "declineReason": "not now" }),
        )
        .await;
    assert_eq!(
        settled(declined).await.expect("the seam adjudicates"),
        CallbackToolApprovalOutcome::Deny {
            basis: CallbackToolApprovalBasis::UserRefusal,
            reason: "not now".to_owned(),
        }
    );

    // Two calls wait at once, so the second "Always allow" replaces the first one's rule.
    let always_allow = json!({
        "decision": "approved",
        "rememberedScope": { "kind": "session", "pattern": SEND_TOOL, "sense": "allow" },
    });
    let (first, first_card) = fixture.raise().await;
    let (second, second_card) = fixture.raise().await;
    for card in [first_card, second_card] {
        fixture.answer(&card, always_allow.clone()).await;
    }
    for call in [first, second] {
        assert_eq!(
            settled(call).await.expect("the seam adjudicates"),
            allow(CallbackToolApprovalBasis::UserGrant)
        );
    }
    assert_eq!(
        fixture.decide(SEND_TOOL, &fixture.unasked).await,
        allow(CallbackToolApprovalBasis::RememberedRule)
    );
    let in_force = check
        .rules
        .list(check.approvals.session_id)
        .await
        .expect("the rules read")
        .rules;
    assert_eq!(in_force.len(), 1);
    let provider_ask = check.ask(
        "ask-1",
        ProviderAskAction::Tool {
            tool_name: SEND_TOOL.to_owned(),
        },
    );
    assert_eq!(
        check.verdict(&provider_ask).await,
        "card offering a rule: true"
    );
    check
        .rules
        .revoke(in_force[0].rule_id)
        .await
        .expect("the rule is revoked");
    assert_eq!(check.provider_rule_calls(), []);

    fixture.set_level("sandboxed");
    assert_eq!(
        fixture.decide(SEND_TOOL, &fixture.unasked).await,
        allow(CallbackToolApprovalBasis::Policy)
    );

    fixture.set_level("ask");
    let (stopped, _card) = fixture.raise().await;
    check.approvals.stop_raised_cards();
    let failure = settled(stopped).await.expect_err("a stopped call fails");
    assert!(matches!(
        failure.downcast_ref::<CallbackToolApprovalError>(),
        Some(CallbackToolApprovalError::Stopped)
    ));
}

// Through the host, a provider that runs the app's tools unasked, and whose capabilities lack
// interactive asks, raises one card for an acting tool at a level that asks; the tool runs only
// once that card is approved, a decline or a cancel answers `denied` with nothing run, and a read
// tool runs with no card at all. Killed by running the executor before the seam settles, by a
// deny answered `completed`, by gating the card on interactive asks, and by a card for every call.
#[tokio::test]
async fn the_host_runs_an_acting_tool_only_once_its_card_is_approved() {
    let fixture = SeamFixture::new().await;
    fixture.set_level("ask");
    fixture.resolve_posture().await;
    fixture
        .providers
        .record_capabilities(
            &fixture.unasked,
            DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    flag != DriverCapabilityFlag::InteractiveRequests
                }),
                contract_version: FreeFormText::new("1".to_owned()).expect("a short version"),
            },
        )
        .expect("the provider is registered");
    let host = fixture.host(&fixture.unasked);
    let raise = || {
        let host = Arc::clone(&host);
        let invocation = fixture.invocation(SEND_TOOL);
        fixture.raise_by(async move { host.call(invocation).await })
    };

    let (declined, card) = raise().await;
    assert_eq!(fixture.asks.pending_cards(), std::slice::from_ref(&card));
    fixture
        .answer(&card, json!({ "decision": "rejected" }))
        .await;
    assert!(matches!(
        settled(declined).await,
        CallbackToolResult::Denied { .. }
    ));
    assert_eq!(host.executed_count(), 0);

    let (canceled, _card) = raise().await;
    fixture
        .asks
        .check
        .approvals
        .service
        .cancel_pending_for_run(fixture.asks.check.approvals.run_id, None)
        .await
        .expect("the run's cards are canceled");
    assert!(matches!(
        settled(canceled).await,
        CallbackToolResult::Denied { .. }
    ));
    assert_eq!(host.executed_count(), 0);

    let (approved, card) = raise().await;
    assert_eq!(fixture.asks.pending_cards(), std::slice::from_ref(&card));
    assert_eq!(host.executed_count(), 0);
    fixture
        .answer(&card, json!({ "decision": "approved" }))
        .await;
    assert!(matches!(
        settled(approved).await,
        CallbackToolResult::Completed { .. }
    ));
    assert_eq!(host.executed_count(), 1);

    let read = tokio::time::timeout(SETTLE_WAIT, host.call(fixture.invocation(READ_TOOL)))
        .await
        .expect("a read settles with no card");
    assert!(matches!(read, CallbackToolResult::Completed { .. }));
    assert_eq!(fixture.asks.pending_cards(), Vec::<String>::new());
    assert_eq!(host.executed_count(), 2);
}

// Through the host, a workflow start whose asking run holds no resolved posture is refused as not
// running, even where the provider asked before the call itself. Killed by dropping the asking
// run's check from the workflow start's decision.
#[tokio::test]
async fn the_host_refuses_a_workflow_start_from_a_run_with_no_posture() {
    let fixture = SeamFixture::new().await;
    let host = fixture.host(&fixture.asking);
    let answer = tokio::time::timeout(SETTLE_WAIT, host.call(fixture.invocation(START_TOOL)))
        .await
        .expect("the start settles with no card");
    assert_eq!(
        answer,
        CallbackToolResult::Denied {
            error: Some(NO_LEVEL_REFUSAL.to_owned()),
        }
    );
    assert_eq!(host.executed_count(), 0);
}

// Through the host, a workflow start rule that reads the asking run's posture reads the posture
// the run's session moved to since the run's gate: a rule that permits a start only at YOLO
// refuses the run at Sandboxed, and allows it once its session moved to YOLO. Killed by a move
// that leaves the session's live runs at the postures their gates resolved.
#[tokio::test]
async fn the_host_decides_a_workflow_start_by_the_posture_its_session_moved_to() {
    let authorizer = Authorizer::load_test_rules(
        r#"permit (principal is User, action == Action::"workflow::start", resource)
        when { context has posture && context.posture.mode == "yolo" };"#,
    )
    .expect("the test rules load");
    let fixture = SeamFixture::deciding_by(authorizer).await;
    fixture.resolve_posture().await;
    let host = fixture.host(&fixture.asking);
    let start = || tokio::time::timeout(SETTLE_WAIT, host.call(fixture.invocation(START_TOOL)));

    assert_eq!(
        start().await.expect("the start settles with no card"),
        CallbackToolResult::Denied {
            error: Some(WORKFLOW_START_REFUSAL.to_owned()),
        }
    );
    let check = &fixture.asks.check;
    check
        .postures
        .move_session(&check.approvals.session_id, posture_at("yolo"));
    assert!(matches!(
        start().await.expect("the start settles with no card"),
        CallbackToolResult::Completed { .. }
    ));
    assert_eq!(host.executed_count(), 1);
}
