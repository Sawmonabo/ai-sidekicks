//! Which turn of its run an event belongs to: the rules the daemon stamps every event of a run by,
//! so a reader stamping a log follows the daemon's rules. A turn boundary moves the run to its next
//! position, an accepted rollback ends the epoch it rewound and opens the next at its point, and a
//! row stamped late or belonging to a tool call takes the turn it was made in. Each accepted
//! rollback cuts the epoch it rewound; a turn above its epoch's cut is superseded, and a later cut
//! below an earlier epoch's point supersedes that epoch's turns down to it too, because the earlier
//! epoch's surviving prefix is part of the history the later cut rewound.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::envelope::{
    EventCategory, SOURCE_EPOCH_PAYLOAD_KEY, SOURCE_POSITION_PAYLOAD_KEY,
};
use crate::run::id::RunId;
use crate::transcript::row::{SupersededMarker, TranscriptRunStamp};
use crate::typescript::TypeScriptModule;
use crate::wire::integer::SafeInt;

/// The event type of a turn boundary, which moves its run to its next turn.
pub const TURN_STARTED_EVENT_TYPE: &str = "run.turn_started";

/// The event type that opens a tool call; the call's later rows take the turn it opened in.
pub const TOOL_CALL_OPENING_EVENT_TYPE: &str = "tool.invoked";

/// An execution epoch and a turn position within it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EpochPosition {
    /// The execution epoch: `0` before any rollback.
    pub epoch: SafeInt<0>,
    /// The turn position within the epoch.
    pub position: SafeInt<0>,
}

/// The first epoch, and the position before a run's first turn.
const ZERO: SafeInt<0> = SafeInt::new(0).expect("0 lies in the range");

/// Where every run starts: the first epoch, before its first turn.
pub const RUN_START_POSITION: EpochPosition = EpochPosition {
    epoch: ZERO,
    position: ZERO,
};

/// One epoch's cut: the point its turns above are superseded from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersedingCut {
    /// The epoch the rollback rewound.
    pub source_epoch: SafeInt<0>,
    /// The point its turns above are superseded from.
    pub point: SafeInt<0>,
}

/// A run's superseded turns: one cut per epoch an accepted rollback rewound, oldest first. The
/// k-th rollback rewound epoch k, so `cuts[epoch]` is that epoch's cut.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersededTurns {
    /// The run.
    pub run_id: RunId,
    /// The cuts, one per rewound epoch, oldest first.
    pub cuts: Vec<SupersedingCut>,
}

/// Adds the run's next accepted rollback, which rewound epoch `turns.cuts.len()` to `point`. An
/// earlier epoch's point drops to it when it lies lower.
pub fn add_superseding_cut(turns: &SupersededTurns, point: SafeInt<0>) -> SupersededTurns {
    let next_epoch = SafeInt::new(turns.cuts.len() as u64).unwrap_or(ZERO);
    let mut cuts: Vec<SupersedingCut> = turns
        .cuts
        .iter()
        .map(|cut| SupersedingCut {
            source_epoch: cut.source_epoch,
            point: cut.point.min(point),
        })
        .collect();
    cuts.push(SupersedingCut {
        source_epoch: next_epoch,
        point,
    });
    SupersededTurns {
        run_id: turns.run_id.clone(),
        cuts,
    }
}

/// The stamp a row of the run made at `source` carries, superseded when its epoch's cut lies
/// below it.
pub fn transcript_run_stamp_at(
    turns: &SupersededTurns,
    source: EpochPosition,
) -> TranscriptRunStamp {
    let superseded = usize::try_from(source.epoch.get())
        .ok()
        .and_then(|epoch| turns.cuts.get(epoch))
        .filter(|cut| source.position > cut.point)
        .map(|cut| SupersededMarker {
            target_position: cut.point,
        });
    TranscriptRunStamp {
        position: source.position,
        epoch: source.epoch,
        superseded,
    }
}

/// Where a turn boundary moves its run: to the position the provider supplied, else the next.
pub fn standing_after_turn_started(
    standing: EpochPosition,
    payload: &Map<String, Value>,
) -> EpochPosition {
    let supplied = payload.get("position").and_then(whole_number_of);
    let position = supplied
        .or_else(|| SafeInt::new(standing.position.get() + 1))
        .unwrap_or(standing.position);
    EpochPosition {
        epoch: standing.epoch,
        position,
    }
}

/// Where an accepted rollback to `target_position` moves its run: the next epoch, at that turn.
pub fn standing_after_rollback(
    standing: EpochPosition,
    target_position: SafeInt<0>,
) -> EpochPosition {
    EpochPosition {
        epoch: SafeInt::new(standing.epoch.get() + 1).unwrap_or(standing.epoch),
        position: target_position,
    }
}

/// The epoch and turn a row appended after a cut is stamped with, or `None` for a row delivered
/// in time, which carries neither.
pub fn stamped_source_of(payload: &Map<String, Value>) -> Option<EpochPosition> {
    Some(EpochPosition {
        epoch: payload
            .get(SOURCE_EPOCH_PAYLOAD_KEY)
            .and_then(whole_number_of)?,
        position: payload
            .get(SOURCE_POSITION_PAYLOAD_KEY)
            .and_then(whole_number_of)?,
    })
}

/// The tool call a row of `category` belongs to, or `None` for a row of no tool call.
pub fn transcript_tool_call_id_of<'payload>(
    category: Option<EventCategory>,
    payload: &'payload Map<String, Value>,
) -> Option<&'payload str> {
    if category == Some(EventCategory::ToolActivity) {
        payload.get("toolCallId")?.as_str()
    } else {
        None
    }
}

/// A JSON number that is a whole number from 0 to 2^53 − 1.
fn whole_number_of(value: &Value) -> Option<SafeInt<0>> {
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|number| number.fract() == 0.0 && *number >= 0.0)
                .map(|number| {
                    #[expect(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        reason = "a whole, non-negative double; SafeInt bounds it below"
                    )]
                    let whole = number as u64;
                    whole
                })
        })
        .and_then(SafeInt::new)
}

/// The module has no TypeScript face: the client keeps its own copy of these rules.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/turn-attribution",
    doc: "Which turn of its run an event belongs to.",
    definitions: &[],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    /// The cases, one per line.
    const CASES: &str = r#"[
{"step":"addSupersedingCut","note":"the first rollback cuts epoch 0","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[]},"point":2,"expected":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":2}]}},
{"step":"addSupersedingCut","note":"a later cut below an earlier epoch's point lowers that point","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":4},{"sourceEpoch":1,"point":6}]},"point":3,"expected":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":3},{"sourceEpoch":1,"point":3},{"sourceEpoch":2,"point":3}]}},
{"step":"addSupersedingCut","note":"a later cut above an earlier epoch's point leaves it","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":1}]},"point":5,"expected":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":1},{"sourceEpoch":1,"point":5}]}},
{"step":"transcriptRunStampAt","note":"a turn above its epoch's cut is superseded","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":2}]},"source":{"epoch":0,"position":3},"expected":{"position":3,"epoch":0,"superseded":{"targetPosition":2}}},
{"step":"transcriptRunStampAt","note":"a turn at its epoch's cut stands","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":2}]},"source":{"epoch":0,"position":2},"expected":{"position":2,"epoch":0}},
{"step":"transcriptRunStampAt","note":"a turn of an epoch no rollback rewound stands","turns":{"runId":"0190f2a0-0000-7000-8000-000000000001","cuts":[{"sourceEpoch":0,"point":2}]},"source":{"epoch":1,"position":9},"expected":{"position":9,"epoch":1}},
{"step":"standingAfterTurnStarted","note":"the provider's position wins","standing":{"epoch":1,"position":2},"payload":{"position":7},"expected":{"epoch":1,"position":7}},
{"step":"standingAfterTurnStarted","note":"no position moves to the next","standing":{"epoch":1,"position":2},"payload":{},"expected":{"epoch":1,"position":3}},
{"step":"standingAfterTurnStarted","note":"a negative position moves to the next","standing":{"epoch":0,"position":2},"payload":{"position":-1},"expected":{"epoch":0,"position":3}},
{"step":"standingAfterTurnStarted","note":"a fractional position moves to the next","standing":{"epoch":0,"position":2},"payload":{"position":1.5},"expected":{"epoch":0,"position":3}},
{"step":"standingAfterTurnStarted","note":"a text position moves to the next","standing":{"epoch":0,"position":2},"payload":{"position":"4"},"expected":{"epoch":0,"position":3}},
{"step":"standingAfterRollback","note":"a rollback opens the next epoch at its point","standing":{"epoch":1,"position":6},"targetPosition":2,"expected":{"epoch":2,"position":2}},
{"step":"stampedSourceOf","note":"a late row carries both stamps","payload":{"sourceEpoch":1,"sourcePosition":4,"text":"late"},"expected":{"epoch":1,"position":4}},
{"step":"stampedSourceOf","note":"a row delivered in time carries neither","payload":{"text":"on time"},"expected":null},
{"step":"stampedSourceOf","note":"one stamp alone is no source","payload":{"sourceEpoch":1},"expected":null},
{"step":"transcriptToolCallIdOf","note":"a tool row belongs to its call","category":"tool_activity","payload":{"toolCallId":"call-1"},"expected":"call-1"},
{"step":"transcriptToolCallIdOf","note":"a row of another category belongs to no call","category":"run_lifecycle","payload":{"toolCallId":"call-1"},"expected":null},
{"step":"transcriptToolCallIdOf","note":"a tool row with no call id belongs to no call","category":"tool_activity","payload":{"toolCallId":7},"expected":null},
{"step":"transcriptToolCallIdOf","note":"a row with no category belongs to no call","category":null,"payload":{"toolCallId":"call-1"},"expected":null}
]"#;

    use serde::Deserialize;
    use serde_json::{Map, Value};

    use super::{
        EpochPosition, SupersededTurns, add_superseding_cut, stamped_source_of,
        standing_after_rollback, standing_after_turn_started, transcript_run_stamp_at,
        transcript_tool_call_id_of,
    };
    use crate::event::envelope::EventCategory;
    use crate::transcript::row::TranscriptRunStamp;
    use crate::wire::integer::SafeInt;

    /// The step a case takes, as the cases write it.
    #[derive(Deserialize)]
    #[serde(
        tag = "step",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    enum TurnCase {
        AddSupersedingCut {
            note: String,
            turns: SupersededTurns,
            point: SafeInt<0>,
            expected: SupersededTurns,
        },
        TranscriptRunStampAt {
            note: String,
            turns: SupersededTurns,
            source: EpochPosition,
            expected: TranscriptRunStamp,
        },
        StandingAfterTurnStarted {
            note: String,
            standing: EpochPosition,
            payload: Map<String, Value>,
            expected: EpochPosition,
        },
        StandingAfterRollback {
            note: String,
            standing: EpochPosition,
            target_position: SafeInt<0>,
            expected: EpochPosition,
        },
        StampedSourceOf {
            note: String,
            payload: Map<String, Value>,
            expected: Option<EpochPosition>,
        },
        TranscriptToolCallIdOf {
            note: String,
            category: Option<EventCategory>,
            payload: Map<String, Value>,
            expected: Option<String>,
        },
    }

    #[test]
    fn a_run_stamps_its_turns_as_the_client_stamps_them() {
        let cases: Vec<TurnCase> = serde_json::from_str(CASES).expect("the cases read");
        for case in cases {
            match case {
                TurnCase::AddSupersedingCut {
                    note,
                    turns,
                    point,
                    expected,
                } => {
                    assert_eq!(add_superseding_cut(&turns, point), expected, "{note}");
                }
                TurnCase::TranscriptRunStampAt {
                    note,
                    turns,
                    source,
                    expected,
                } => {
                    assert_eq!(transcript_run_stamp_at(&turns, source), expected, "{note}");
                }
                TurnCase::StandingAfterTurnStarted {
                    note,
                    standing,
                    payload,
                    expected,
                } => {
                    assert_eq!(
                        standing_after_turn_started(standing, &payload),
                        expected,
                        "{note}"
                    );
                }
                TurnCase::StandingAfterRollback {
                    note,
                    standing,
                    target_position,
                    expected,
                } => {
                    assert_eq!(
                        standing_after_rollback(standing, target_position),
                        expected,
                        "{note}"
                    );
                }
                TurnCase::StampedSourceOf {
                    note,
                    payload,
                    expected,
                } => {
                    assert_eq!(stamped_source_of(&payload), expected, "{note}");
                }
                TurnCase::TranscriptToolCallIdOf {
                    note,
                    category,
                    payload,
                    expected,
                } => {
                    assert_eq!(
                        transcript_tool_call_id_of(category, &payload),
                        expected.as_deref(),
                        "{note}"
                    );
                }
            }
        }
    }
}
