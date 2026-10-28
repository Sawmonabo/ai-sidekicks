//! The one path every provider driver's deliveries take to the run engine. Each is handed to the
//! inbound dispatch at once, in the order the driver produced them, because the dispatch
//! attributes a delivery when it is called; a refusal is logged as a driver diagnostic, never
//! dropped unrecorded.

use std::future::Future;

use serde_json::{Map, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;

use crate::driver::contract::bound_failure_detail;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::{InboundDelivery, InboundOutcome, SessionScopedRow};

/// Where a delivery came from, as a refusal's diagnostic names it.
pub(crate) struct DeliveryOrigin<'a> {
    /// The provider whose driver produced it.
    pub(crate) provider: ProviderId,
    /// The account the provider runs on; `None` where no account owns the delivery, such as one
    /// from the service on the person's own provider folder.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The provider frame it came from; `None` for the driver's own.
    pub(crate) raw_wire_type: Option<&'a str>,
}

/// Dispatches `delivery` through `dispatch` now, before the returned future is first polled, and
/// answers its outcome, or `None` once a refusal is logged as `DeliveryDispatchFailed` naming its
/// origin, its kind and its session or binding.
pub(crate) fn dispatch_delivery<'d>(
    dispatch: &'d dyn InboundDispatch,
    origin: DeliveryOrigin<'_>,
    delivery: InboundDelivery<'_>,
) -> impl Future<Output = Option<InboundOutcome>> + Send + 'd {
    let mut details = Map::new();
    details.insert("deliveryKind".to_owned(), json!(delivery.kind_name()));
    match &delivery {
        InboundDelivery::SessionNotice { session_id, .. } => {
            details.insert("sessionId".to_owned(), json!(session_id.to_string()));
        }
        InboundDelivery::SessionEvent { row } => {
            details.insert(
                "sessionId".to_owned(),
                json!(scoped_row_session(row).to_string()),
            );
        }
        InboundDelivery::TurnBoundary { binding_id } => {
            details.insert("bindingId".to_owned(), json!(binding_id.as_str()));
        }
        // About the machine: no session or binding to name.
        InboundDelivery::MachineEvent { .. } => {}
        InboundDelivery::RunLifecycle { binding, .. }
        | InboundDelivery::RunContinued { binding, .. }
        | InboundDelivery::ChildRun { binding, .. }
        | InboundDelivery::RunMarker { binding, .. }
        | InboundDelivery::LiveRunState { binding, .. }
        | InboundDelivery::ThinkingUpdate { binding, .. }
        | InboundDelivery::PermissionAsk { binding }
        | InboundDelivery::SessionRow { binding, .. }
        | InboundDelivery::UnstampedRow { binding, .. } => {
            details.insert("bindingId".to_owned(), json!(binding.binding_id.as_str()));
        }
    }
    let DeliveryOrigin {
        provider,
        provider_account_id,
        raw_wire_type,
    } = origin;
    let raw_wire_type = raw_wire_type.map(str::to_owned);
    // Called before any await, so the dispatch attributes it in this call's order.
    let dispatched = dispatch.dispatch(delivery);
    async move {
        match dispatched.await {
            Ok(outcome) => Some(outcome),
            Err(error) => {
                let disposition_reason = bound_failure_detail(
                    &describe_error(&*error),
                    UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                );
                emit_driver_diagnostic(&DriverDiagnosticRecord {
                    provider,
                    provider_account_id,
                    kind: DriverDiagnosticKind::DeliveryDispatchFailed,
                    raw_wire_type,
                    disposition_reason: disposition_reason.into_string(),
                    details,
                });
                None
            }
        }
    }
}

// The session a row on no binding is about.
fn scoped_row_session(row: &SessionScopedRow) -> SessionId {
    match row {
        SessionScopedRow::SideQuestionAnswered(payload) => payload.session_id,
        SessionScopedRow::UsageTokenCountRecorded(payload) => payload.session_id,
        SessionScopedRow::AdvisorChanged(payload) => payload.session_id,
        SessionScopedRow::OutputStyleChanged(payload) => payload.session_id,
    }
}
