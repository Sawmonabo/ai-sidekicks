//! Which turn is live on each thread of a session's stream, when it began, and whether it made a
//! model request; and each thread's turn that settled last, which a reading released after its
//! completion still marks.

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
    pub(crate) turn: Option<FrameTurn>,
}

/// The turn a turn frame carries.
#[derive(Deserialize)]
pub(crate) struct FrameTurn {
    /// The turn's id.
    pub(crate) id: Option<String>,
}

/// The live turn of each thread a session's stream carries, and the turn each settled last.
#[derive(Default)]
pub(crate) struct CodexThreadTurns {
    live: HashMap<String, CodexLiveTurn>,
    // Until the thread's next turn starts.
    last_settled: HashMap<String, CodexLastSettledTurn>,
}

// One thread's live turn: its id, when it began, and whether it made a model request.
struct CodexLiveTurn {
    turn_id: String,
    started_at: Instant,
    made_request: bool,
}

// A thread's turn that settled last, and whether its settle was handed to the export status.
struct CodexLastSettledTurn {
    turn_id: String,
    started_at: Instant,
    made_request: bool,
    is_handed_off: bool,
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
            self.last_settled.remove(&thread_id);
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
        self.last_settled.insert(
            thread_id.clone(),
            CodexLastSettledTurn {
                turn_id: turn_id.clone(),
                started_at: settled.started_at,
                made_request: settled.made_request,
                is_handed_off: false,
            },
        );
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
        self.last_settled.clear();
        self.live
            .drain()
            .map(|(thread_id, live)| (thread_id, live.turn_id))
    }

    /// Ends `thread_id`'s live turn, whose completion will never come, answering its id.
    pub(crate) fn end_live_turn(&mut self, thread_id: &str) -> Option<String> {
        self.live.remove(thread_id).map(|live| live.turn_id)
    }

    /// A request was metered on `thread_id`: its live turn made a model request, else the turn
    /// that settled last there did, its reading released after its completion. Answers that
    /// settled turn where its settle was already handed off without a request, to hand off again.
    pub(crate) fn request_made(&mut self, thread_id: &str) -> Option<CodexSettledTurn> {
        if let Some(live) = self.live.get_mut(thread_id) {
            live.made_request = true;
            return None;
        }
        let settled = self.last_settled.get_mut(thread_id)?;
        if settled.made_request {
            return None;
        }
        settled.made_request = true;
        settled.is_handed_off.then(|| CodexSettledTurn {
            thread_id: thread_id.to_owned(),
            turn_id: settled.turn_id.clone(),
            started_at: settled.started_at,
            made_request: true,
        })
    }

    /// Hands off the settle of `thread_id`'s turn `turn_id`, which settled last there, as it now
    /// stands, once the frames its completion released were applied; `None` for another turn.
    pub(crate) fn hand_off_settled(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Option<CodexSettledTurn> {
        let settled = self
            .last_settled
            .get_mut(thread_id)
            .filter(|settled| settled.turn_id == turn_id)?;
        settled.is_handed_off = true;
        Some(CodexSettledTurn {
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.to_owned(),
            started_at: settled.started_at,
            made_request: settled.made_request,
        })
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::to_raw_value;
    use tokio::time::Instant;

    use super::{CodexEndedTurn, CodexThreadTurns};
    use crate::driver::codex::event_normalizer::{
        CODEX_TURN_COMPLETED_METHOD, CODEX_TURN_STARTED_METHOD,
    };

    const THREAD: &str = "helper-thread";
    const TURN: &str = "helper-turn";

    /// When the reading a held helper's frames carried is released.
    enum Release {
        /// With the frame that completes the turn, before its settle is handed off.
        WithTheCompletion,
        /// On a later frame, after the settle was handed off with no request.
        AfterTheHandOff,
    }

    // A turn whose reading the router held until after its completion still counts as a request
    // turn, so its launch's export check is armed: handed off with the request where the reading
    // applied first, else armed again by the reading. Killed by a hand-off that reads the request
    // as the completion found it (`with_the_completion`) and by a reading that marks only a live
    // turn (`after_the_hand_off`).
    #[rstest]
    #[case::with_the_completion(Release::WithTheCompletion)]
    #[case::after_the_hand_off(Release::AfterTheHandOff)]
    fn a_reading_released_after_its_turn_completed_marks_that_turn_a_request(
        #[case] release: Release,
    ) {
        let mut turns = CodexThreadTurns::default();
        let params = to_raw_value(&json!({"threadId": THREAD, "turn": {"id": TURN}}))
            .expect("the params are JSON");
        let now = Instant::now();
        assert!(
            turns
                .observe(CODEX_TURN_STARTED_METHOD, &params, now)
                .is_none()
        );
        let Some(CodexEndedTurn::Settled(settled)) =
            turns.observe(CODEX_TURN_COMPLETED_METHOD, &params, now)
        else {
            panic!("the live turn settles");
        };
        assert!(!settled.made_request);
        let armed = match release {
            Release::WithTheCompletion => {
                assert!(turns.request_made(THREAD).is_none());
                turns.hand_off_settled(THREAD, TURN)
            }
            Release::AfterTheHandOff => {
                let handed_off = turns
                    .hand_off_settled(THREAD, TURN)
                    .expect("the turn settled last on its thread");
                assert!(!handed_off.made_request);
                turns.request_made(THREAD)
            }
        };
        let armed = armed.expect("the request turn is armed");
        assert!(armed.made_request);
        assert_eq!(armed.turn_id, TURN);
        // Marked once: a second reading arms nothing more.
        assert!(turns.request_made(THREAD).is_none());
    }
}
