//! A turn as the run engine opened it for a driver, and the end of a turn a driver reports.

use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

/// A turn's end its provider's end frame reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderTurnEnd {
    /// The turn's number within its run, as its start was numbered.
    pub turn_number: SafeInt<1>,
    /// How it ended, with the cause the delivery knows from the frame; a limit stop's cut of the
    /// turn replaces it.
    pub outcome: TurnOutcome,
}

/// A turn the engine opened: its number within its run and the id of its `run.turn_started` event,
/// which a flag about the whole turn points at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartedTurn {
    /// The turn's number within its run.
    pub turn_number: SafeInt<1>,
    /// The id of the event that started it.
    pub event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// How a turn ended, with why where the daemon knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    /// `agent.turn.completed`.
    Completed,
    /// `agent.turn.interrupted`.
    Interrupted(Option<TurnEndCause>),
    /// `agent.turn.failed`.
    Failed(Option<TurnEndCause>),
}
