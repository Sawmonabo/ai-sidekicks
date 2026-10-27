//! The seam over the permission asks' fixture: the session's level stored apart from its run's
//! posture, every call answered through the intake as a client answers it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, json};
use sidekicks_contracts::approval::ApprovalResolveRequest;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::callback_tools::host::{
    CallbackToolApprovalBasis, CallbackToolApprovalOutcome, CallbackToolApprovalSeam,
    CallbackToolPortError,
};
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::callback_tool::CallbackToolInvocation;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_provider::port::permission_ask::ProviderAskAction;
use sidekicks_provider::run::posture::CURATED_CREDENTIAL_POLICY_REF;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate};
use tokio::task::JoinHandle;

use super::{
    CallbackToolApprovalError, CallbackToolApprovals, CallbackToolGate, UNGATED_TOOL_REFUSAL,
};
use crate::permission_asks::tests::{AsksFixture, device};
use crate::service::test_fixture::SETTLE_WAIT;
use crate::service::tests::from_json;

// A tool that only reads, and one that acts.
const READ_TOOL: &str = "session_list";
const SEND_TOOL: &str = "session_send";

/// The seam under test over the fixture, with each provider's id by whether it asks before the
/// app's own tools itself.
struct SeamFixture {
    asks: AsksFixture,
    seam: Arc<CallbackToolApprovals>,
    asking: ProviderId,
    unasked: ProviderId,
}

impl SeamFixture {
    async fn new() -> Self {
        let asks = AsksFixture::new().await;
        let providers = registry_of_first_providers(
            PROVIDERS
                .iter()
                .map(|_descriptor| Arc::new(MockProviderDriver::new()) as _)
                .collect(),
        );
        let gates = HashMap::from([
            (READ_TOOL.to_owned(), CallbackToolGate::Read),
            (SEND_TOOL.to_owned(), CallbackToolGate::Level),
        ]);
        let seam = Arc::new(CallbackToolApprovals::new(
            Arc::clone(&asks.check.check),
            Arc::new(providers),
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

    /// A call of the acting tool from the run of a provider that does not ask itself, waiting on
    /// its card, and that card's id.
    async fn raise(
        &self,
    ) -> (
        JoinHandle<Result<CallbackToolApprovalOutcome, CallbackToolPortError>>,
        String,
    ) {
        let waiting = self.asks.pending_cards();
        let seam = Arc::clone(&self.seam);
        let invocation = self.invocation(SEND_TOOL);
        let provider = self.unasked.clone();
        let call = tokio::spawn(async move { seam.evaluate(&invocation, &provider).await });
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

async fn settled(
    call: JoinHandle<Result<CallbackToolApprovalOutcome, CallbackToolPortError>>,
) -> Result<CallbackToolApprovalOutcome, CallbackToolPortError> {
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
    let posture: ExecutionPosture = from_json(json!({
        "mode": "sandboxed",
        "credentialPolicyRef": CURATED_CREDENTIAL_POLICY_REF,
        "writableRoots": [],
    }));
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
