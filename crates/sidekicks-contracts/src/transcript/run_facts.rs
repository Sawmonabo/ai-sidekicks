//! The facts a run's header and controls read: who acts for it, the account it is billed to, the
//! state it last entered and whether a rewind came after that state. One fold over the run's own
//! events in log order: the daemon folds the whole log and serves the result with every window that
//! names the run, and a client folds what its stream delivers onto what it was served.
//!
//! A run's own events are the ones whose payload names it as `runId`. An intervention names the
//! run it targets as `targetRunId` and is not the run's own, and neither is a person's message
//! steering it.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use strum::VariantArray;

use crate::event::registry::SessionEventType;
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::account::record::ProviderAccountId;
use crate::run::id::RunId;
use crate::run::state::{RUN_INITIAL_STATE, RunState};
use crate::schema::doc_description;
use crate::session::event_cursor::START_OF_LOG_POSITION;
use crate::transcript::row::TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
use crate::wire::integer::{BoundedInt, MAX_SAFE_SIGNED_INTEGER, SafeInt};
use crate::wire::text::FreeFormText;

/// What [`RunStateEventType`]'s schema says it is.
const RUN_STATE_EVENT_TYPE_DOC: &str =
    "An event type that moves a run into a state: `agent.run.<state>`, one per state.";

/// An event type that moves a run into a state, written as the [`SessionEventType`] it maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, VariantArray)]
#[serde(into = "SessionEventType", try_from = "SessionEventType")]
pub enum RunStateEventType {
    /// The run is queued.
    Queued,
    /// The run is starting.
    Starting,
    /// The run is running.
    Running,
    /// The run waits for an approval.
    WaitingForApproval,
    /// The run waits for input.
    WaitingForInput,
    /// The run is pausing.
    Pausing,
    /// The run is paused.
    Paused,
    /// The run completed.
    Completed,
    /// The run was interrupted.
    Interrupted,
    /// The run was stopped.
    Stopped,
    /// The run failed.
    Failed,
}

/// Every `agent.run.<state>` event type, in the order the states are declared.
pub const RUN_STATE_EVENT_TYPES: &[RunStateEventType] = RunStateEventType::VARIANTS;

impl From<RunStateEventType> for SessionEventType {
    fn from(event_type: RunStateEventType) -> Self {
        event_type.session_event_type()
    }
}

/// A session event type that moves no run into a state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{} moves no run into a state", .0.as_str())]
pub struct NotARunStateEventType(
    /// The refused type.
    pub SessionEventType,
);

impl TryFrom<SessionEventType> for RunStateEventType {
    type Error = NotARunStateEventType;

    fn try_from(event_type: SessionEventType) -> Result<Self, Self::Error> {
        RUN_STATE_EVENT_TYPES
            .iter()
            .copied()
            .find(|candidate| candidate.session_event_type() == event_type)
            .ok_or(NotARunStateEventType(event_type))
    }
}

impl JsonSchema for RunStateEventType {
    fn schema_name() -> Cow<'static, str> {
        "RunStateEventType".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let names: Vec<&str> = RUN_STATE_EVENT_TYPES
            .iter()
            .map(|event_type| event_type.session_event_type().as_str())
            .collect();
        json_schema!({
            "description": doc_description(RUN_STATE_EVENT_TYPE_DOC),
            "type": "string",
            "enum": names,
        })
    }
}

/// The type of a person's message, which is never a run's own event even when it steers one.
pub const USER_MESSAGE_EVENT_TYPE: &str = SessionEventType::UserMessageSent.as_str();

impl RunStateEventType {
    /// The session event type this is.
    pub const fn session_event_type(self) -> SessionEventType {
        match self {
            Self::Queued => SessionEventType::AgentRunQueued,
            Self::Starting => SessionEventType::AgentRunStarting,
            Self::Running => SessionEventType::AgentRunRunning,
            Self::WaitingForApproval => SessionEventType::AgentRunWaitingForApproval,
            Self::WaitingForInput => SessionEventType::AgentRunWaitingForInput,
            Self::Pausing => SessionEventType::AgentRunPausing,
            Self::Paused => SessionEventType::AgentRunPaused,
            Self::Completed => SessionEventType::AgentRunCompleted,
            Self::Interrupted => SessionEventType::AgentRunInterrupted,
            Self::Stopped => SessionEventType::AgentRunStopped,
            Self::Failed => SessionEventType::AgentRunFailed,
        }
    }

    /// The state the event type announces.
    pub const fn state(self) -> RunState {
        match self {
            Self::Queued => RunState::Queued,
            Self::Starting => RunState::Starting,
            Self::Running => RunState::Running,
            Self::WaitingForApproval => RunState::WaitingForApproval,
            Self::WaitingForInput => RunState::WaitingForInput,
            Self::Pausing => RunState::Pausing,
            Self::Paused => RunState::Paused,
            Self::Completed => RunState::Completed,
            Self::Interrupted => RunState::Interrupted,
            Self::Stopped => RunState::Stopped,
            Self::Failed => RunState::Failed,
        }
    }

    /// The `agent.run.<state>` event type `event_type` names, or `None` for any other type.
    pub fn of(event_type: &str) -> Option<Self> {
        SessionEventType::from_wire_name(event_type)
            .and_then(|event_type| Self::try_from(event_type).ok())
    }
}

/// The payload member naming the account a run was admitted under, carried by its creation.
const ADMITTED_PROVIDER_ACCOUNT_MEMBER: &str = "admittedProviderAccountId";

/// A log position, from [`START_OF_LOG_POSITION`] up.
pub type FoldedThroughSequence = BoundedInt<START_OF_LOG_POSITION, MAX_SAFE_SIGNED_INTEGER>;

/// One run's facts as a `transcript.read` window serves them, folded over the log through
/// `foldedThroughSequence`. The header's state word is `stateEventType` unless a rewind came after
/// it; the run has ended when that state is a terminal one and no rewind came after it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptRunFacts {
    /// The run.
    pub run_id: RunId,
    /// Who the run's first event naming anyone names, wire-verbatim.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The account the run was admitted under, as its creation named it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderAccountId")]
    pub admitted_provider_account_id: Option<ProviderAccountId>,
    /// The newest `agent.run.<state>` type the run entered, kept across a rewind.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunStateEventType")]
    pub state_event_type: Option<RunStateEventType>,
    /// Whether an `agent.run.rolledBack` came after `stateEventType`.
    pub is_rewound: bool,
    /// The sequence the facts hold through: an event at or below it is already in them.
    pub folded_through_sequence: FoldedThroughSequence,
}

/// A run's facts while a fold holds them, keyed by the run outside them: [`TranscriptRunFacts`]
/// without its `runId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptRunFactsFold {
    /// Who the run's first event naming anyone names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The account the run was admitted under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_provider_account_id: Option<ProviderAccountId>,
    /// The newest `agent.run.<state>` type the run entered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_event_type: Option<RunStateEventType>,
    /// Whether a rewind came after that state.
    pub is_rewound: bool,
    /// The sequence the facts hold through.
    pub folded_through_sequence: FoldedThroughSequence,
}

/// The facts of a run no event has been folded into yet.
pub const UNFOLDED_TRANSCRIPT_RUN_FACTS: TranscriptRunFactsFold = TranscriptRunFactsFold {
    actor: None,
    admitted_provider_account_id: None,
    state_event_type: None,
    is_rewound: false,
    folded_through_sequence: FoldedThroughSequence::new(START_OF_LOG_POSITION)
        .expect("the start of the log lies in the range"),
};

/// One event as the fold reads it: what the daemon's log and a client's stream both carry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TranscriptRunBeat<'event> {
    /// The event's type.
    pub event_type: &'event str,
    /// The event's session sequence.
    pub sequence: SafeInt<0>,
    /// Who acted, when the event names anyone.
    pub actor: Option<&'event FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The event's payload.
    pub payload: Option<&'event Map<String, Value>>,
}

/// Whether a beat is a state change whose payload names another state than its type announces, or
/// none. The fold takes no state from such a beat.
pub fn is_misstated_state_change(event_type: &str, payload: Option<&Map<String, Value>>) -> bool {
    RunStateEventType::of(event_type).is_some_and(|announced| {
        let announced_state = announced.state();
        announced_state != RUN_INITIAL_STATE
            && payload
                .and_then(|payload| payload.get("newState"))
                .and_then(|new_state| RunState::deserialize(new_state).ok())
                != Some(announced_state)
    })
}

/// Folds one of the run's own events into its facts. An event at or below
/// `folded_through_sequence`, or one that changes no fact, answers the same facts. The first actor
/// wins, and the account is the one the run's creation names. An `agent.run.<state>` event sets
/// the state and ends a rewind, unless its payload misstates the state; an `agent.run.rolledBack`
/// marks the state rewound.
pub fn fold_transcript_run_facts(
    facts: &TranscriptRunFactsFold,
    beat: &TranscriptRunBeat<'_>,
) -> TranscriptRunFactsFold {
    let sequence = FoldedThroughSequence::new(beat.sequence.get().cast_signed())
        .expect("a safe sequence lies in the fold's range");
    if sequence <= facts.folded_through_sequence || beat.event_type == USER_MESSAGE_EVENT_TYPE {
        return facts.clone();
    }
    let actor = facts.actor.clone().or_else(|| beat.actor.cloned());
    let admitted_provider_account_id = facts.admitted_provider_account_id.clone().or_else(|| {
        (RunStateEventType::of(beat.event_type).map(RunStateEventType::state)
            == Some(RUN_INITIAL_STATE))
        .then(|| admitted_provider_account_id_of(beat.payload))
        .flatten()
    });
    let mut state_event_type = facts.state_event_type;
    let mut is_rewound = facts.is_rewound;
    if beat.event_type == TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE {
        is_rewound = true;
    } else if let Some(announced) = RunStateEventType::of(beat.event_type)
        && !is_misstated_state_change(beat.event_type, beat.payload)
    {
        state_event_type = Some(announced);
        is_rewound = false;
    }
    let folded = TranscriptRunFactsFold {
        actor,
        admitted_provider_account_id,
        state_event_type,
        is_rewound,
        folded_through_sequence: facts.folded_through_sequence,
    };
    if folded == *facts {
        return facts.clone();
    }
    TranscriptRunFactsFold {
        folded_through_sequence: sequence,
        ..folded
    }
}

/// The state the run's controls read: the state it last entered, a rewind notwithstanding.
pub fn transcript_run_state_of(facts: &TranscriptRunFactsFold) -> Option<RunState> {
    facts.state_event_type.map(RunStateEventType::state)
}

/// The state word the run's header shows: its newest state type, none after a rewind.
pub fn transcript_run_header_state_of(facts: &TranscriptRunFactsFold) -> Option<RunStateEventType> {
    if facts.is_rewound {
        None
    } else {
        facts.state_event_type
    }
}

/// Whether the run has ended: its newest state is a terminal one and no rewind came after it.
pub fn is_transcript_run_ended(facts: &TranscriptRunFactsFold) -> bool {
    !facts.is_rewound && transcript_run_state_of(facts).is_some_and(RunState::is_terminal)
}

/// The account a run's creation names, when it names a well-formed one.
fn admitted_provider_account_id_of(
    payload: Option<&Map<String, Value>>,
) -> Option<ProviderAccountId> {
    payload?
        .get(ADMITTED_PROVIDER_ACCOUNT_MEMBER)
        .and_then(|value| ProviderAccountId::deserialize(value).ok())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{Map, Value};

    use super::{
        TranscriptRunBeat, TranscriptRunFactsFold, UNFOLDED_TRANSCRIPT_RUN_FACTS,
        fold_transcript_run_facts, is_transcript_run_ended, transcript_run_header_state_of,
        transcript_run_state_of,
    };
    use crate::event::version::EVENT_FIELD_MAX_LEN;
    use crate::run::state::RunState;
    use crate::transcript::run_facts::RunStateEventType;
    use crate::wire::integer::SafeInt;
    use crate::wire::text::FreeFormText;

    /// The table the client's run-facts suite reads too.
    const CASES: &str = include_str!("../../tests/fixtures/transcript/run-facts.json");

    /// One event of a case, as the cases write it.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BeatCase {
        #[serde(rename = "type")]
        event_type: String,
        sequence: SafeInt<0>,
        actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        payload: Option<Map<String, Value>>,
    }

    /// One case: the beats folded in order onto unfolded facts, and what the facts then read.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RunFactsCase {
        note: String,
        beats: Vec<BeatCase>,
        facts: TranscriptRunFactsFold,
        state: Option<RunState>,
        header_state: Option<RunStateEventType>,
        is_ended: bool,
    }

    #[test]
    fn a_run_folds_its_events_as_the_client_folds_them() {
        let cases: Vec<RunFactsCase> = serde_json::from_str(CASES).expect("the cases read");
        for case in cases {
            let facts = case
                .beats
                .iter()
                .fold(UNFOLDED_TRANSCRIPT_RUN_FACTS, |facts, beat| {
                    fold_transcript_run_facts(
                        &facts,
                        &TranscriptRunBeat {
                            event_type: &beat.event_type,
                            sequence: beat.sequence,
                            actor: beat.actor.as_ref(),
                            payload: beat.payload.as_ref(),
                        },
                    )
                });
            assert_eq!(facts, case.facts, "{}", case.note);
            assert_eq!(transcript_run_state_of(&facts), case.state, "{}", case.note);
            assert_eq!(
                transcript_run_header_state_of(&facts),
                case.header_state,
                "{}",
                case.note
            );
            assert_eq!(
                is_transcript_run_ended(&facts),
                case.is_ended,
                "{}",
                case.note
            );
        }
    }
}
