//! The provider-neutral reading of how a model turn ended, which each driver's classifier fills
//! from its own settling frame.

/// The closed set of typed evidence that a model turn happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnEvidenceClass {
    /// The model wrote output.
    ModelOutput,
    /// The provider accounted the turn's usage.
    TurnAccounting,
    /// The turn ended for a stated reason (quota, context window) with no output or accounting.
    DeclaredTurnFailure,
}

/// One driver's reading of a settling frame. `recognized: false` means the frame was not one the
/// classifier knows, which is not the same as a turn with no evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TurnEvidenceClassification {
    /// Whether the classifier knows the frame.
    pub(crate) recognized: bool,
    /// The evidence the frame carries, each class once, in the order first seen.
    pub(crate) observations: Vec<TurnEvidenceClass>,
}

/// A recognized settling frame carrying `observations`, each class kept once in the order first
/// seen.
pub(crate) fn observed_turn_evidence(
    observations: &[TurnEvidenceClass],
) -> TurnEvidenceClassification {
    let mut distinct = Vec::with_capacity(observations.len());
    for &observation in observations {
        if !distinct.contains(&observation) {
            distinct.push(observation);
        }
    }
    TurnEvidenceClassification {
        recognized: true,
        observations: distinct,
    }
}

/// A settling frame the driver's classifier does not recognize.
pub(crate) const UNRECOGNIZED_TURN_EVIDENCE: TurnEvidenceClassification =
    TurnEvidenceClassification {
        recognized: false,
        observations: Vec::new(),
    };
