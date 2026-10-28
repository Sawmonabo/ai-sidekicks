//! The latest turn readings of each run, as its driver publishes them: the tokens the run's current
//! turn has received and the agent's task list, a new turn's reading replacing the last turn's. A
//! subscriber reads the held reading at once and then only the newest after each change, so a slow
//! one never reads a queue of stale readings. A run's readings go once the run ends, and any left
//! with its session once the session closes.

use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::{TurnTasksUpdate, TurnUsageUpdate};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_provider::port::turn_reading_publisher::TurnReadingPublisher;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_workspace::run_setup_gates::{
    RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext,
};

use super::latest::LatestReadings;
use super::{ReadingFollowError, follow_closed_sessions, refuse_unknown_session};
use crate::run::read::RunStateReader;
use crate::run::refusals::RunRefusal;

// A run under its session, so a closed session's runs go together.
type RunKey = (SessionId, RunId);

/// Each run's latest turn readings and their subscribers: the turn readings' intake that the
/// daemon registers for the drivers, and the run setup gate whose terminal hook lets a run's
/// readings go.
pub struct TurnReadings {
    pool: Arc<DatabaseReadPool>,
    usage: Arc<LatestReadings<RunKey, TurnUsageUpdate>>,
    tasks: Arc<LatestReadings<RunKey, TurnTasksUpdate>>,
    // Lets a closed session's readings go, a reading published after its run ended among them;
    // dropped with the readings.
    _session_closes: FollowerAttachment,
}

impl TurnReadings {
    /// Readings that hold none until a driver publishes one, reading runs on `pool`, and letting a
    /// session's readings go once `followers` hears the session closed.
    pub fn new(pool: Arc<DatabaseReadPool>, followers: &Arc<SessionEventFollowers>) -> Self {
        let usage = Arc::new(LatestReadings::default());
        let tasks = Arc::new(LatestReadings::default());
        let released_usage = Arc::clone(&usage);
        let released_tasks = Arc::clone(&tasks);
        let session_closes = follow_closed_sessions(followers, move |session_id| {
            let is_session_run = |(run_session_id, _): &RunKey| *run_session_id == session_id;
            released_usage.release_where(is_session_run);
            released_tasks.release_where(is_session_run);
        });
        Self {
            pool,
            usage,
            tasks,
            _session_closes: session_closes,
        }
    }

    /// Sends the tokens `run_id`'s current turn has received through `outlet` at once, if read,
    /// then each newer figure, until the answered detach runs or the run ends. Refused as
    /// [`Self::follow_tasks`] is.
    pub async fn follow_usage(
        &self,
        session_id: SessionId,
        run_id: RunId,
        outlet: LatestValueOutlet<TurnUsageUpdate>,
    ) -> Result<impl FnOnce() + Send + use<>, ReadingFollowError> {
        self.require_run(session_id, run_id).await?;
        Ok(self.usage.follow((session_id, run_id), outlet))
    }

    /// Sends `run_id`'s current task list through `outlet` at once, if read, then each newer list,
    /// until the answered detach runs or the run ends. Refused `session.notFound` for a session
    /// this daemon holds no row for and `agent.run.notFound` for a run it holds none for in that
    /// session, following nothing; fails when the run or session cannot be read.
    pub async fn follow_tasks(
        &self,
        session_id: SessionId,
        run_id: RunId,
        outlet: LatestValueOutlet<TurnTasksUpdate>,
    ) -> Result<impl FnOnce() + Send + use<>, ReadingFollowError> {
        self.require_run(session_id, run_id).await?;
        Ok(self.tasks.follow((session_id, run_id), outlet))
    }

    // Refuses a run this daemon holds no row for in `session_id`, naming the session when it holds
    // none for the session either.
    async fn require_run(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), ReadingFollowError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let run = RunStateReader::new(reader).read_run(&run_id)?;
                if run.is_some_and(|run| run.session_id == session_id) {
                    return Ok(());
                }
                refuse_unknown_session(reader, &session_id)?;
                Err(DomainError::from(RunRefusal::NotFound { run_id }).into())
            })
            .await
    }
}

impl TurnReadingPublisher for TurnReadings {
    fn publish_turn_usage(&self, session_id: SessionId, update: TurnUsageUpdate) {
        self.usage.publish((session_id, update.run_id), update);
    }

    fn publish_turn_tasks(&self, session_id: SessionId, update: TurnTasksUpdate) {
        self.tasks.publish((session_id, update.run_id), update);
    }
}

impl RunSetupGate for TurnReadings {
    fn assert_run_ready<'a>(
        &'a self,
        _context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn on_run_terminal<'a>(
        &'a self,
        context: &'a RunTerminalContext,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        let run = (context.session_id, context.run_id);
        self.usage.release(&run);
        self.tasks.release(&run);
        Box::pin(std::future::ready(Ok(())))
    }
}
