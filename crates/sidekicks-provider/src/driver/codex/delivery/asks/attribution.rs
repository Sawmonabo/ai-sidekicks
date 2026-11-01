//! The run each routed Codex ask belongs to, named on the session's task before the ask is handed
//! on: a helper's ask to the helper's child run, else the run of the turn it names, else, where it
//! names none and needs none, the session's sole active run. A named turn no live route resolves is
//! refused, never attributed to the sole active run, which would decide it for a run that did not
//! ask. An attributed approval or question is held for its card; a dynamic tool's call is refused,
//! since the daemon declares no tool for Codex to call.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use tokio::sync::oneshot;

use crate::driver::codex::delivery::asks::{CodexAskHandOff, refuse};
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::server_requests::{
    CodexAskKind, CodexAskOwner, CodexInboundServerRequest, CodexRoutedAskAttribution,
    CodexRoutedAskTurnId, CodexServerRequestDecision, compose_routed_ask_refusal_reason,
    read_routed_ask_turn_id,
};
use crate::driver::codex::service::supervisor::routing::read_codex_ask_thread_id;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::contract::error::DriverError;

/// Where a decided ask's decision goes; a dropped sender refuses the ask.
pub(crate) type CodexAskDecisionSender =
    oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>;

/// What the session's task hands each routed ask to: the run routes it attributes by and the
/// hand-off that holds an approval or a question.
pub(crate) struct CodexAskIntake {
    /// The hand-off that holds an approval or a question for its card.
    pub(crate) hand_off: Arc<CodexAskHandOff>,
    /// The driver's run routes, which name a run's binding.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
}

impl CodexAskIntake {
    /// Decides one ask of `record`'s session on its task and sends the decision on `decision`: a
    /// dynamic tool's call is refused, since the daemon declares no tool, an ask that cannot be
    /// attributed is refused, and an approval or a question is held once its card is dispatched.
    /// The task never waits for the person.
    pub(crate) async fn take(
        &self,
        record: &CodexSessionRecord,
        request: CodexInboundServerRequest,
        decision: CodexAskDecisionSender,
    ) {
        if request.ask_kind == CodexAskKind::CallbackTool {
            let reason = format!(
                "The daemon serves no tool for the provider's \"{}\" request.",
                request.method.method()
            );
            send_decision(decision, refuse(reason));
            return;
        }
        let owner = match attribute_codex_ask(record, &self.run_routes, &request) {
            CodexRoutedAskAttribution::Refused { reason } => {
                send_decision(decision, refuse(reason));
                return;
            }
            CodexRoutedAskAttribution::Attributed { owner } => Some(owner),
            CodexRoutedAskAttribution::Unattributed { owner } => owner,
        };
        let held = self.hand_off.hold(record, owner, &request).await;
        send_decision(decision, held);
    }
}

/// Names the run `request` of `record`'s session belongs to and the binding its permission ask
/// goes on, or refuses it: a helper's ask is its child run's, a named turn its live run's, and an
/// ask that names no turn and needs none the sole active run's. A named turn no live route
/// resolves is refused and reported.
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
        return match &child.bound {
            Some(bound) => CodexRoutedAskAttribution::Attributed {
                owner: CodexAskOwner {
                    run_id: bound.child_run_id,
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
    if turn_id == CodexRoutedAskTurnId::Absent {
        return CodexRoutedAskAttribution::Unattributed {
            owner: record.sole_active_run().and_then(owner_of),
        };
    }
    report_turn_unresolved(request, &turn_id);
    CodexRoutedAskAttribution::Refused {
        reason: compose_routed_ask_refusal_reason(request.method, &turn_id),
    }
}

// Reports a refused ask whose named turn no live route resolves.
fn report_turn_unresolved(request: &CodexInboundServerRequest, turn_id: &CodexRoutedAskTurnId) {
    let (recorded, is_turn_id_cut) = match turn_id {
        CodexRoutedAskTurnId::Absent => (None, false),
        CodexRoutedAskTurnId::Resolvable(turn_id) => (Some(turn_id.clone()), false),
        CodexRoutedAskTurnId::Unresolvable { recorded } => (Some(recorded.clone()), true),
    };
    CodexTransportDiagnostic::RoutedAskTurnUnresolved {
        method: request.method.method().to_owned(),
        turn_id: recorded,
        is_turn_id_cut,
    }
    .report();
}

fn send_decision(decision: CodexAskDecisionSender, decided: CodexServerRequestDecision) {
    // The connection that asked closed first; nothing waits for the decision.
    let _unheard = decision.send(Ok(decided));
}
