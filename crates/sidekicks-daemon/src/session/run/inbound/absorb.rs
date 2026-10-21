//! The report of a delivery the inbound dispatch absorbed: one driver diagnostic naming why, the
//! delivery and where it was attributed, while nothing of the delivery is written.

use serde_json::{Map, Value};
use sidekicks_contracts::run::state::RunState;

use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::session::run::epochs::{DeliveryAttribution, EpochBinding};
use crate::session::run::inbound::{AbsorbedDelivery, InboundOutcome, LateEventAbsorbReason};

impl LateEventAbsorbReason {
    // The reason as the diagnostic's details name it.
    fn as_str(self) -> &'static str {
        match self {
            Self::BeforeCut => "beforeCut",
            Self::RunEnded => "runEnded",
            Self::RunResumed => "runResumed",
        }
    }

    // Why the delivery was disposed of, in the diagnostic's words.
    fn sentence(self) -> &'static str {
        match self {
            Self::BeforeCut => {
                "the delivery belongs to the execution before an undo's cut, so it is absorbed at \
                 the epoch check and nothing is written"
            }
            Self::RunEnded => {
                "the delivery's run had already ended, so its write was refused and nothing is \
                 written"
            }
            Self::RunResumed => {
                "the delivery reported a pause or a turn under way after a resume had already set \
                 the run running, so its write was refused and nothing is written"
            }
        }
    }
}

// Reports a delivery absorbed for `reason`, on `binding`, and answers that nothing was written.
pub(super) fn absorb(
    binding: &EpochBinding,
    absorbed: &AbsorbedDelivery,
    reason: LateEventAbsorbReason,
    attribution: DeliveryAttribution,
) -> InboundOutcome {
    let before_cut = match attribution {
        DeliveryAttribution::BeforeCut { source } => Some(source),
        DeliveryAttribution::Current | DeliveryAttribution::Unknown { .. } => None,
    };
    let run_id = absorbed.run_id.unwrap_or(binding.run_id);
    let mut details = Map::new();
    details.insert("reason".to_owned(), Value::from(reason.as_str()));
    details.insert("deliveryKind".to_owned(), Value::from(absorbed.kind));
    details.insert("bindingId".to_owned(), Value::from(binding.id.as_str()));
    details.insert("runId".to_owned(), Value::from(run_id.text().as_str()));
    details.insert(
        "newState".to_owned(),
        absorbed.new_state.map_or(Value::Null, |state| {
            Value::from(<&'static str>::from(RunState::from(state)))
        }),
    );
    details.insert(
        "sourceEpoch".to_owned(),
        before_cut.map_or(Value::Null, |source| Value::from(source.epoch.0.get())),
    );
    details.insert(
        "sourcePosition".to_owned(),
        before_cut.map_or(Value::Null, |source| Value::from(source.position.0.get())),
    );
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: binding.provider_name.clone(),
        provider_account_id: binding.provider_account_id.clone(),
        kind: DriverDiagnosticKind::LateEventAbsorbed,
        raw_wire_type: None,
        disposition_reason: reason.sentence().to_owned(),
        details,
    });
    InboundOutcome::Absorbed { reason }
}
