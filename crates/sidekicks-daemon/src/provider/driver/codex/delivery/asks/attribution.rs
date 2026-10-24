//! The run each routed Codex ask belongs to, named on the session's task before the ask is handed
//! on: a helper's ask to the helper's child run, else the run of the turn it names, else, where it
//! names none and needs none, the session's sole active run. A named turn no live route resolves is
//! refused, never attributed to the sole active run, which would decide it for a run that did not
//! ask. An attributed approval or question is held for its card; a callback tool's call goes to the
//! daemon's callback-tool host.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_contracts::run::id::RunId;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::ask_option_sets::{
    CodexAskOptionSetReading, ProviderAskOption, read_codex_ask_option_set,
};
use crate::provider::driver::codex::delivery::asks::{CodexAskHandOff, read_params, refuse};
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::server_requests::{
    CodexAskKind, CodexAskOwner, CodexInboundServerRequest, CodexRoutedAskAttribution,
    CodexRoutedAskTurnId, CodexServerRequestDecision, CodexSessionServerRequest,
    CodexSessionServerRequestResponder, compose_routed_ask_refusal_reason, read_routed_ask_turn_id,
};
use crate::provider::driver::codex::service::supervisor::routing::read_codex_ask_thread_id;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::port::registration::PortRegistration;

/// Where a decided ask's decision goes; a dropped sender refuses the ask.
pub(crate) type CodexAskDecisionSender =
    oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>;

/// What the session's task hands each routed ask to: the run routes it attributes by, the hand-off
/// that holds an approval or a question, and the callback-tool host.
pub(crate) struct CodexAskIntake {
    /// The hand-off that holds an approval or a question for its card.
    pub(crate) hand_off: Arc<CodexAskHandOff>,
    /// The driver's run routes, which name a run's binding.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The daemon's callback-tool host, once registered.
    pub(crate) callback_tools: Arc<PortRegistration<Arc<dyn CodexSessionServerRequestResponder>>>,
    /// The driver's tasks, which its shutdown waits for; each callback tool's call runs on one.
    pub(crate) tasks: TaskTracker,
}

impl CodexAskIntake {
    /// Decides one ask of `record`'s session on its task and sends the decision on `decision`: an
    /// ask that cannot be attributed is refused, an approval or a question is held once its card
    /// is dispatched, and a callback tool's call is answered by the host off the task, since the
    /// tool may run long. The task never waits for the person.
    pub(crate) async fn take(
        &self,
        record: &CodexSessionRecord,
        request: CodexInboundServerRequest,
        decision: CodexAskDecisionSender,
    ) {
        let owner = match attribute_codex_ask(record, &self.run_routes, &request) {
            CodexRoutedAskAttribution::Refused { reason } => {
                send_decision(decision, refuse(reason));
                return;
            }
            CodexRoutedAskAttribution::Attributed { owner } => Some(owner),
            CodexRoutedAskAttribution::Unattributed { owner } => owner,
        };
        if request.ask_kind != CodexAskKind::CallbackTool {
            let held = self.hand_off.hold(record, owner, &request).await;
            send_decision(decision, held);
            return;
        }
        let Some(host) = self.callback_tools.port().cloned() else {
            let reason = format!(
                "The daemon has no callback-tool host for \"{}\".",
                request.method.method()
            );
            send_decision(decision, refuse(reason));
            return;
        };
        let options = match read_ask_options(record, &request) {
            Ok(options) => options,
            Err(reason) => {
                send_decision(decision, refuse(reason));
                return;
            }
        };
        let call = CodexSessionServerRequest {
            request,
            session_id: record.session_id,
            run_id: owner.map(|owner| owner.run_id),
            options,
        };
        self.tasks.spawn(async move {
            let answered = host.answer(call).await;
            // The connection that asked closed first; nothing waits for the answer.
            let _unheard = decision.send(answered);
        });
    }
}

/// Names the run `request` of `record`'s session belongs to and the binding its permission ask
/// goes on, or refuses it: a helper's ask is its child run's, a named turn its live run's, and an
/// ask that names no turn and needs none the sole active run's. A named turn no live route
/// resolves, and a callback tool's call that names none, are refused and reported.
pub(crate) fn attribute_codex_ask(
    record: &CodexSessionRecord,
    run_routes: &CodexRunRoutes,
    request: &CodexInboundServerRequest,
) -> CodexRoutedAskAttribution {
    let method = request.method.method();
    let owner_of = |run_id: RunId| {
        run_routes.binding_for(run_id).map(|binding| CodexAskOwner {
            run_id,
            binding_id: binding.binding_id,
        })
    };
    let child = read_codex_ask_thread_id(&request.params)
        .filter(|thread_id| *thread_id != record.thread_id)
        .and_then(|thread_id| record.delivery.child_run_by_thread_id.get(&thread_id));
    if let Some(child) = child {
        return match &child.started {
            Some(started) => CodexRoutedAskAttribution::Attributed {
                owner: CodexAskOwner {
                    run_id: started.child_run_id,
                    binding_id: child.binding_id.clone(),
                },
            },
            None => CodexRoutedAskAttribution::Refused {
                reason: format!(
                    "The provider's \"{method}\" request came from a helper whose run did not \
                     start, so no one can answer it."
                ),
            },
        };
    }
    let turn_id = read_routed_ask_turn_id(&request.params);
    if let CodexRoutedAskTurnId::Resolvable(turn_id) = &turn_id
        && let Some(owner) = record.active_turn_run(turn_id).and_then(owner_of)
    {
        return CodexRoutedAskAttribution::Attributed { owner };
    }
    // A callback tool's call always names its turn, so naming none is itself the fault.
    if turn_id == CodexRoutedAskTurnId::Absent && request.ask_kind != CodexAskKind::CallbackTool {
        return CodexRoutedAskAttribution::Unattributed {
            owner: record.sole_active_run().and_then(owner_of),
        };
    }
    report_turn_unresolved(record, request, &turn_id);
    CodexRoutedAskAttribution::Refused {
        reason: compose_routed_ask_refusal_reason(request.method, &turn_id),
    }
}

// Reports a refused ask whose named turn no live route resolves; a callback tool's refusal is
// also counted as one, which no other refusal may be.
fn report_turn_unresolved(
    record: &CodexSessionRecord,
    request: &CodexInboundServerRequest,
    turn_id: &CodexRoutedAskTurnId,
) {
    let method = request.method.method();
    let (recorded, is_turn_id_cut) = match turn_id {
        CodexRoutedAskTurnId::Absent => (None, false),
        CodexRoutedAskTurnId::Resolvable(turn_id) => (Some(turn_id.clone()), false),
        CodexRoutedAskTurnId::Unresolvable { recorded } => (Some(recorded.clone()), true),
    };
    CodexTransportDiagnostic::RoutedAskTurnUnresolved {
        method: method.to_owned(),
        turn_id: recorded.clone(),
        is_turn_id_cut,
    }
    .report();
    if request.ask_kind != CodexAskKind::CallbackTool {
        return;
    }
    let mut details = Map::new();
    details.insert("sessionId".to_owned(), json!(record.session_id.to_string()));
    details.insert("method".to_owned(), json!(method));
    details.insert("turnId".to_owned(), json!(recorded));
    details.insert("turnIdTruncated".to_owned(), json!(is_turn_id_cut));
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: record.provider_account_id.clone(),
        kind: DriverDiagnosticKind::CallbackToolInvocationRefused,
        raw_wire_type: Some(method.to_owned()),
        disposition_reason: "the invocation named no turn this daemon holds a live route for, so \
                             no run's tool registry could adjudicate it"
            .to_owned(),
        details,
    });
}

// The choices an ask offers; a set the driver will not carry is reported and dropped, the ask
// still answerable in free text. Fails, with why, when the ask's params do not read.
fn read_ask_options(
    record: &CodexSessionRecord,
    request: &CodexInboundServerRequest,
) -> Result<Option<Vec<ProviderAskOption>>, String> {
    let params = Value::Object(read_params(request)?);
    let method = request.method.method();
    Ok(match read_codex_ask_option_set(method, &params) {
        CodexAskOptionSetReading::Absent => None,
        CodexAskOptionSetReading::Read { options } => Some(options),
        CodexAskOptionSetReading::Dropped {
            reason,
            declared_count,
        } => {
            let mut details = Map::new();
            details.insert("sessionId".to_owned(), json!(record.session_id.to_string()));
            details.insert("declaredOptionCount".to_owned(), json!(declared_count));
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: record.provider_account_id.clone(),
                kind: DriverDiagnosticKind::InteractiveRequestOptionSetDropped,
                raw_wire_type: Some(method.to_owned()),
                disposition_reason: reason.to_owned(),
                details,
            });
            None
        }
    })
}

fn send_decision(decision: CodexAskDecisionSender, decided: CodexServerRequestDecision) {
    // The connection that asked closed first; nothing waits for the decision.
    let _unheard = decision.send(Ok(decided));
}
