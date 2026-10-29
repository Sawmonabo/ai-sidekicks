//! What keeps a session's process up, each read where its owner keeps it: a turn the run engine
//! has in flight, a message waiting in the session's queue, a command the running set holds, and
//! the holds the session's provider keeps (its open requests, a side question and its timed fires).
//! The holds the daemon's own parts register are counted by the idle sleep itself.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use sidekicks_contracts::run::queue::QueueItemState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::command::running_set::RunningCommandSets;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use crate::idle_sleep::IdleSleepError;
use crate::idle_sleep::kept_schedules::holds_awake;
use crate::queue_store::QueueItemReader;
use crate::run::live_count::is_live;
use crate::run::read::RunStateReader;

/// Where a session's holds are read.
pub(super) struct HoldSources<'sources> {
    /// The read pool the runs and the queue are read on.
    pub(super) pool: &'sources DatabaseReadPool,
    /// The sessions' running commands.
    pub(super) running_commands: &'sources RunningCommandSets,
    /// The session's driver.
    pub(super) driver: &'sources dyn ProviderDriver,
}

/// What one read of a session's holds found: whether one holds the session awake, and the timed
/// fires its provider keeps, which the idle sleep stores for the session.
pub(super) struct SessionHolds {
    /// Whether anything holds the session awake.
    pub(super) is_held: bool,
    /// The timed fires the provider keeps.
    pub(super) schedules: Vec<KeptSchedule>,
}

/// Reads every hold on `session_id` at `now`, its timed fires matched in `zone`. Fails as the
/// driver's read, the pool or the read fails.
pub(super) async fn read_session_holds(
    sources: &HoldSources<'_>,
    session_id: SessionId,
    now: Timestamp,
    zone: &TimeZone,
) -> Result<SessionHolds, IdleSleepError> {
    let provider_holds = sources.driver.idle_sleep_holds(session_id).await?;
    let is_held_in_store = sources
        .pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<bool, IdleSleepError> {
                let is_turn_in_flight = RunStateReader::new(reader)
                    .list_live_runs(Some(&session_id))?
                    .iter()
                    .any(|live| is_live(live.run.state));
                // A message the run has not taken yet; one not delivered is the person's to resend.
                let is_message_waiting = !QueueItemReader::new(reader)
                    .list(&session_id, None, Some(QueueItemState::Queued))?
                    .is_empty();
                Ok(is_turn_in_flight || is_message_waiting)
            },
        )
        .await?;
    let is_held = is_held_in_store
        || sources.running_commands.has_running_commands(session_id)
        || provider_holds.open_requests > 0
        || provider_holds.is_side_question_running
        || provider_holds
            .schedules
            .iter()
            .any(|schedule| holds_awake(schedule, now, zone));
    Ok(SessionHolds {
        is_held,
        schedules: provider_holds.schedules,
    })
}
