//! The turns running on one service: on every conversation its routed connection carries, read
//! from their `turn/started` and `turn/completed` frames in arrival order, and on each copy whose
//! turn the daemon starts, counted from just before its start is sent until the copy is done.
//! A change of the service's sign-in waits until none runs, since it cuts every request in flight.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use serde_json::value::RawValue;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use crate::driver::codex::event_normalizer::{
    CODEX_TURN_COMPLETED_METHOD, CODEX_TURN_STARTED_METHOD,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::CodexServiceRouting;
use crate::driver::codex::session::thread_turns::TurnFrame;
use crate::driver::codex::transport::connection::read_codex_object;

/// The turns running on a service, kept with its routing.
#[derive(Default)]
pub(super) struct CodexRunningTurns {
    // The id of the live turn of each conversation the routed connection carries, by thread.
    live: HashMap<String, String>,
    // The copies' turns counted by their leases.
    leased: usize,
    // `true` while any turn runs.
    is_running: watch::Sender<bool>,
}

impl CodexRunningTurns {
    /// Reads a frame of the routed connection: a turn's start or end on any of its conversations.
    pub(super) fn observe(&mut self, method: &str, params: &RawValue) {
        let is_start = match method {
            CODEX_TURN_STARTED_METHOD => true,
            CODEX_TURN_COMPLETED_METHOD => false,
            _ => return,
        };
        let Some(frame) = read_codex_object::<TurnFrame>(params.get()) else {
            return;
        };
        let turn_id = frame
            .turn
            .and_then(|turn| turn.id)
            .filter(|id| !id.is_empty());
        let (Some(thread_id), Some(turn_id)) = (frame.thread_id, turn_id) else {
            return;
        };
        if is_start {
            self.live.insert(thread_id, turn_id);
        } else if self.live.get(&thread_id) == Some(&turn_id) {
            // A completion of a turn the thread has since replaced ends nothing.
            self.live.remove(&thread_id);
        }
        self.publish();
    }

    /// Ends `thread_id`'s live turn, its conversation unloaded, or every live turn where `None`,
    /// its connection ended.
    pub(super) fn end(&mut self, thread_id: Option<&str>) {
        match thread_id {
            Some(thread_id) => {
                self.live.remove(thread_id);
            }
            None => self.live.clear(),
        }
        self.publish();
    }

    fn publish(&self) {
        let is_running = self.leased > 0 || !self.live.is_empty();
        self.is_running.send_if_modified(|was_running| {
            let is_changed = *was_running != is_running;
            *was_running = is_running;
            is_changed
        });
    }
}

/// A copy's turn counted among its service's running turns until dropped.
pub(crate) struct CodexTurnLease {
    routing: Weak<Mutex<CodexServiceRouting>>,
}

impl Drop for CodexTurnLease {
    fn drop(&mut self) {
        if let Some(routing) = self.routing.upgrade() {
            let turns = &mut lock(&routing).running_turns;
            turns.leased -= 1;
            turns.publish();
        }
    }
}

impl CodexService {
    /// Counts a copy's turn among the service's running turns until the lease is dropped.
    pub(crate) fn lease_turn(&self) -> CodexTurnLease {
        let turns = &mut self.lock_routing().running_turns;
        turns.leased += 1;
        turns.publish();
        CodexTurnLease {
            routing: Arc::downgrade(&self.routing),
        }
    }

    /// Whether a turn runs on the service.
    pub(crate) fn is_turn_running(&self) -> bool {
        *self.lock_routing().running_turns.is_running.borrow()
    }

    /// Waits until no turn runs on the service.
    pub(crate) async fn wait_for_no_running_turn(&self) {
        let mut is_running = self.lock_routing().running_turns.is_running.subscribe();
        // The sender lives with the service's routing, which outlives this wait.
        drop(is_running.wait_for(|is_running| !*is_running).await);
    }
}
