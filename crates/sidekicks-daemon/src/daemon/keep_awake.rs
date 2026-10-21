//! Keep-awake's owner: one hold at a time, chosen from the two switches, the live-run count and
//! the power source. `Keep awake while an agent works` holds the machine and its screen awake
//! while a run is live, whatever the power source; `Keep awake for other devices` holds the
//! machine awake while it is on power. The stronger hold covers the weaker, so moving between
//! them never holds two, and a second run takes nothing more. A hold the system refuses is logged
//! at that change and tried again at the next; nothing on screen claims a hold. The person can
//! still sleep the machine by its lid or its menu under either.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_platforms::{KeepAwakeHold, KeepAwakePurpose};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// The system's keep-awake hold, as the owner moves it.
pub(crate) trait KeepAwakeTarget: Send + 'static {
    /// Holds the machine awake for `purpose`, keeping whatever was held when the system refuses.
    fn take(
        &self,
        purpose: KeepAwakePurpose,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Lets go of the hold.
    fn release(&self);
}

impl KeepAwakeTarget for KeepAwakeHold {
    fn take(
        &self,
        purpose: KeepAwakePurpose,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        KeepAwakeHold::take(self, purpose)
            .map(|taken| taken.map_err(Into::into))
            .boxed()
    }

    fn release(&self) {
        KeepAwakeHold::release(self);
    }
}

/// What keep-awake follows.
pub(crate) struct KeepAwakeDeps<Target> {
    /// The hold it moves.
    pub(crate) hold: Target,
    /// The live-run count.
    pub(crate) live_runs: watch::Receiver<u32>,
    /// The machine's settings, for the two switches.
    pub(crate) settings: watch::Receiver<MachineSettings>,
    /// Whether the machine is on power; a source that cannot be read reads as not.
    pub(crate) is_on_power: watch::Receiver<bool>,
    /// The service's stop, which lets go of the hold.
    pub(crate) stop: CancellationToken,
}

/// Moves the hold as its inputs change until the service stops, then lets go of it. An input
/// whose sender is gone keeps its last value.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start runs keep-awake over the hold and the power source"
    )
)]
pub(crate) async fn keep_machine_awake(deps: KeepAwakeDeps<impl KeepAwakeTarget>) {
    let KeepAwakeDeps {
        hold,
        mut live_runs,
        mut settings,
        mut is_on_power,
        stop,
    } = deps;
    let mut held = None;
    loop {
        let wanted = wanted_hold(
            &settings.borrow_and_update(),
            *live_runs.borrow_and_update(),
            *is_on_power.borrow_and_update(),
        );
        if wanted != held {
            if let Some(purpose) = wanted {
                match hold.take(purpose).await {
                    Ok(()) => held = wanted,
                    Err(refusal) => tracing::warn!(
                        ?purpose,
                        error = &*refusal as &(dyn Error + 'static),
                        "The system refused to keep the machine awake; the hold is tried again \
                         at the next change"
                    ),
                }
            } else {
                hold.release();
                held = None;
            }
        }
        // A closed input's branch is skipped for this pass; the stop's never is.
        tokio::select! {
            () = stop.cancelled() => break,
            Ok(()) = live_runs.changed() => {}
            Ok(()) = settings.changed() => {}
            Ok(()) = is_on_power.changed() => {}
        }
    }
    hold.release();
}

// The hold the switches, the live runs and the power source call for.
fn wanted_hold(
    settings: &MachineSettings,
    live_runs: u32,
    is_on_power: bool,
) -> Option<KeepAwakePurpose> {
    if settings.keep_awake_while_agent_works && live_runs > 0 {
        Some(KeepAwakePurpose::AgentWorks)
    } else if settings.keep_awake_for_other_devices && is_on_power {
        Some(KeepAwakePurpose::OtherDevices)
    } else {
        None
    }
}

#[cfg(test)]
mod tests;
