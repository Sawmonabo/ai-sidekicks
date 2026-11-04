//! What the Claude Code driver does with a run across its turns: its start, its controls, the words
//! a continue owes after the restart cut its pause, the stops of one helper, the prompts it wrote,
//! the route each run takes to its session, a turn's settlement, a cut of the conversation, and a
//! turn Claude Code starts by itself.

pub(super) mod continuation_words;
pub(super) mod controls;
pub(super) mod helpers;
pub(super) mod prompts;
pub(super) mod rewind;
pub(super) mod routes;
pub(super) mod self_started_turns;
pub(super) mod settlement;
pub(super) mod start;
