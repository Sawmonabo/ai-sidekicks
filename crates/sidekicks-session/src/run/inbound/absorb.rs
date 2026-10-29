//! The report of a delivery the inbound dispatch absorbed: one driver diagnostic naming why, the
//! delivery and where it was attributed, while nothing of the delivery is written. A helper the
//! daemon refused at its setup after its provider started it runs on in its provider, so what it
//! delivers to its ended run is expected and absorbed with a debug line alone.

use std::collections::VecDeque;

use serde_json::{Map, Value};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_provider::run::delivery::{InboundOutcome, LateEventAbsorbReason};

use crate::run::epochs::{DeliveryAttribution, EpochBinding};
use crate::run::inbound::AbsorbedDelivery;

// The reason as the diagnostic's details name it.
fn reason_name(reason: LateEventAbsorbReason) -> &'static str {
    match reason {
        LateEventAbsorbReason::BeforeCut => "beforeCut",
        LateEventAbsorbReason::RunEnded => "runEnded",
        LateEventAbsorbReason::RunResumed => "runResumed",
    }
}

// Why the delivery was disposed of, in the diagnostic's words.
fn reason_sentence(reason: LateEventAbsorbReason) -> &'static str {
    match reason {
        LateEventAbsorbReason::BeforeCut => {
            "the delivery belongs to the execution before an undo's cut, so it is absorbed at the \
             epoch check and nothing is written"
        }
        LateEventAbsorbReason::RunEnded => {
            "the delivery's run had already ended, so its write was refused and nothing is written"
        }
        LateEventAbsorbReason::RunResumed => {
            "the delivery reported a pause or a turn under way after a resume had already set the \
             run running, so its write was refused and nothing is written"
        }
    }
}

/// How many refused helpers' runs the dispatch remembers; past it the oldest is forgotten, so a
/// delivery of its that comes later is reported as any late one is.
const REFUSED_CHILD_RUNS_KEPT: usize = 64;

/// The runs of the helpers the daemon refused at their setup whose provider has not yet reported
/// their end, the oldest first.
#[derive(Default)]
pub(super) struct RefusedChildRuns {
    runs: VecDeque<RunId>,
}

impl RefusedChildRuns {
    /// Remembers `run_id`, a helper's run refused at its setup, forgetting the oldest past the
    /// bound.
    pub(super) fn note(&mut self, run_id: RunId) {
        if self.runs.len() == REFUSED_CHILD_RUNS_KEPT {
            self.runs.pop_front();
        }
        self.runs.push_back(run_id);
    }

    /// Whether `absorbed` is a delivery to a refused helper's ended run; the run is forgotten once
    /// its provider reports its end.
    pub(super) fn is_refused_run(&mut self, absorbed: &AbsorbedDelivery) -> bool {
        let Some(run_id) = absorbed.run_id else {
            return false;
        };
        let Some(index) = self.runs.iter().position(|refused| *refused == run_id) else {
            return false;
        };
        if absorbed
            .new_state
            .is_some_and(|state| RunState::from(state).is_terminal())
        {
            self.runs.remove(index);
        }
        true
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
    details.insert("reason".to_owned(), Value::from(reason_name(reason)));
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
        provider_account_id: Some(binding.provider_account_id.clone()),
        kind: DriverDiagnosticKind::LateEventAbsorbed,
        raw_wire_type: None,
        disposition_reason: reason_sentence(reason).to_owned(),
        details,
    });
    InboundOutcome::Absorbed { reason }
}
