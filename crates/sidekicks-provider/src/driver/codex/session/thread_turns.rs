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

/// A turn that settled: when it began, and whether it made a model request.
pub(crate) struct CodexSettledTurn {
    /// When its `turn/started` arrived.
    pub(crate) started_at: Instant,
    /// Whether a usage reading metered a request during it.
    pub(crate) made_request: bool,
}

impl CodexThreadTurns {
    /// Reads a frame arriving at `now`: a `turn/started` naming a thread and a turn opens that
    /// thread's live turn, replacing one that never settled; a `turn/completed` naming the
    /// thread's live turn answers it settled. Any other frame answers `None`.
    pub(crate) fn observe(
        &mut self,
        method: &str,
        params: &RawValue,
        now: Instant,
    ) -> Option<CodexSettledTurn> {
        let is_start = match method {
            CODEX_TURN_STARTED_METHOD => true,
            CODEX_TURN_COMPLETED_METHOD => false,
            _ => return None,
        };
        let frame = read_codex_object::<TurnFrame>(params.get())?;
        let thread_id = frame.thread_id?;
        let turn_id = frame.turn?.id.filter(|turn_id| !turn_id.is_empty())?;
        if is_start {
            self.live.insert(
                thread_id,
                CodexLiveTurn {
                    turn_id,
                    started_at: now,
                    made_request: false,
                },
            );
            return None;
        }
        if self
            .live
            .get(&thread_id)
            .is_none_or(|live| live.turn_id != turn_id)
        {
            return None;
        }
        let settled = self.live.remove(&thread_id)?;
        Some(CodexSettledTurn {
            started_at: settled.started_at,
            made_request: settled.made_request,
        })
    }

    /// A request was metered on `thread_id`: its live turn made a model request.
    pub(crate) fn request_made(&mut self, thread_id: &str) {
        if let Some(live) = self.live.get_mut(thread_id) {
            live.made_request = true;
        }
    }
}
