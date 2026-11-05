//! The engine's interrupt hands: the tasks that carry a run's interrupt out apart from the call
//! that asked for it, owned by the engine so the daemon's stop cuts each where it stands and waits
//! for it within its bound. A hand cut leaves its row pending, as a failed hand does.

use sidekicks_contracts::run::id::RunId;
use tokio::task::JoinHandle;
use tracing::Instrument as _;

use crate::run::engine::RunEngine;

impl RunEngine {
    /// Spawns `hand`, the carrying out of an interrupt of `run_id`, under the caller's span on the
    /// engine's interrupt hands. Answers its task, whose output is `None` where the daemon's stop
    /// cut it, which is logged; answers `None` once the stop has come, when no hand is spawned.
    pub(crate) fn hand_interrupt(
        &self,
        run_id: RunId,
        hand: impl Future<Output = ()> + Send + 'static,
    ) -> Option<JoinHandle<Option<()>>> {
        // Holds the stop's wait until the hand is spawned or, the hands closed, none is, so no hand
        // starts past the stop's wait.
        let _spawning = self.interrupt_hands.token();
        if self.interrupt_hands.is_closed() {
            tracing::info!(%run_id, "the daemon is stopping, so an interrupt is not handed");
            return None;
        }
        let stop = self.interrupt_hands_stop.clone();
        let cut_or_handed = async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => {
                    tracing::info!(
                        %run_id,
                        "the daemon's stop cut an interrupt's hand; its row stays pending"
                    );
                    None
                }
                () = hand => Some(()),
            }
        };
        Some(
            self.interrupt_hands
                .spawn(cut_or_handed.instrument(tracing::Span::current())),
        )
    }

    /// Cuts every interrupt hand where it stands and returns once each has ended; no hand is
    /// spawned after.
    pub async fn stop_interrupt_hands(&self) {
        self.interrupt_hands_stop.cancel();
        self.interrupt_hands.close();
        self.interrupt_hands.wait().await;
    }
}
