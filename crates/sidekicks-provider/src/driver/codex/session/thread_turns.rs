//! Which turn is live on each thread of a session's stream, when it began, and whether it made a
//! model request.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::time::Instant;

use crate::driver::codex::event_normalizer::{
    CODEX_TURN_COMPLETED_METHOD, CODEX_TURN_STARTED_METHOD,
};
use crate::driver::codex::transport::connection::read_codex_object;

/// The members of a frame a turn id is read from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnFrame {
    /// The thread the frame is on.
    pub(crate) thread_id: Option<String>,
    /// The turn an item frame names.
    pub(crate) turn_id: Option<String>,
    /// The turn a `turn/started` or `turn/completed` carries.
    pub(crate) turn: Option<EndedTurn>,
}

/// The turn a turn frame carries.
#[derive(Deserialize)]
pub(crate) struct EndedTurn {
    /// The turn's id.
    pub(crate) id: Option<String>,
}

/// The live turn of each thread a session's stream carries.
#[derive(Default)]
pub(crate) struct CodexThreadTurns {
    live: HashMap<String, CodexLiveTurn>,
}

// One thread's live turn: its id, when it began, and whether it made a model request.
struct CodexLiveTurn {
    turn_id: String,
    started_at: Instant,
    made_request: bool,
}

/// A turn that settled: its thread and id, when it began, and whether it made a model request.
pub(crate) struct CodexSettledTurn {
    /// The thread it ran on.
    pub(crate) thread_id: String,
    /// Its id.
    pub(crate) turn_id: String,
    /// When its `turn/started` arrived.
    pub(crate) started_at: Instant,
    /// Whether a usage reading metered a request during it.
    pub(crate) made_request: bool,
}

/// A live turn a frame ended.
pub(crate) enum CodexEndedTurn {
    /// Its `turn/completed` arrived.
    Settled(CodexSettledTurn),
    /// A `turn/started` on its thread replaced it before it settled.
    Replaced {
        /// The thread it ran on.
        thread_id: String,
        /// Its id.
        turn_id: String,
    },
}

impl CodexThreadTurns {
    /// Reads a frame arriving at `now`: a `turn/started` naming a thread and a turn opens that
    /// thread's live turn, answering the one it replaced that never settled; a `turn/completed`
    /// naming the thread's live turn answers it settled. Any other frame answers `None`.
    pub(crate) fn observe(
        &mut self,
        method: &str,
        params: &RawValue,
        now: Instant,
    ) -> Option<CodexEndedTurn> {
        let is_start = match method {
            CODEX_TURN_STARTED_METHOD => true,
            CODEX_TURN_COMPLETED_METHOD => false,
            _ => return None,
        };
        let frame = read_codex_object::<TurnFrame>(params.get())?;
        let thread_id = frame.thread_id?;
        let turn_id = frame.turn?.id.filter(|turn_id| !turn_id.is_empty())?;
        if is_start {
            let replaced = self.live.insert(
                thread_id.clone(),
                CodexLiveTurn {
                    turn_id: turn_id.clone(),
                    started_at: now,
                    made_request: false,
                },
            );
            // A start repeated for the live turn ends nothing.
            return replaced
                .filter(|replaced| replaced.turn_id != turn_id)
                .map(|replaced| CodexEndedTurn::Replaced {
                    thread_id,
                    turn_id: replaced.turn_id,
                });
        }
        if self
            .live
            .get(&thread_id)
            .is_none_or(|live| live.turn_id != turn_id)
        {
            return None;
        }
        let settled = self.live.remove(&thread_id)?;
        Some(CodexEndedTurn::Settled(CodexSettledTurn {
            thread_id,
            turn_id,
            started_at: settled.started_at,
            made_request: settled.made_request,
        }))
    }

    /// The turn live on `thread_id`, `None` where none is.
    pub(crate) fn live_turn(&self, thread_id: &str) -> Option<&str> {
        self.live.get(thread_id).map(|live| live.turn_id.as_str())
    }

    /// Takes every live turn, each as its thread and turn id, for a process that ended with them.
    pub(crate) fn take_live_turns(&mut self) -> impl Iterator<Item = (String, String)> + '_ {
        self.live
            .drain()
            .map(|(thread_id, live)| (thread_id, live.turn_id))
    }

    /// A request was metered on `thread_id`: its live turn made a model request.
    pub(crate) fn request_made(&mut self, thread_id: &str) {
        if let Some(live) = self.live.get_mut(thread_id) {
            live.made_request = true;
        }
    }
}
