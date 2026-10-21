//! Every process start answered by a script instead of a Claude Code program: a session's process
//! is the next scripted channel, a one-turn process the next scripted reply, and each start is
//! recorded with the conversation it asked for and the listener its frames and exit go to.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::sync::Notify;

use super::channel::ScriptedChannel;
use crate::provider::driver::claude::session::answered_commands::ClaudeAttachedAdvisor;
use crate::provider::driver::claude::session::process::ClaudeProcessListener;
use crate::provider::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::provider::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeModelCatalogReading, ClaudeReplyReserveReads,
    ClaudeSessionFolderReadRequest,
};
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSettingsReadback,
};
use crate::provider::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::provider::driver::claude::spawn::launch::one_turn::{
    ClaudeOneTurnReply, ClaudeOneTurnRequest,
};
use crate::provider::driver::contract::{DriverError, GetCapabilitiesResult};
use crate::provider::runtime_binding::test_store::spawned_build;
use crate::queue::delivery::ProviderProcessIdentity;

/// The build every scripted process reports.
pub(crate) const SCRIPTED_BUILD_VERSION: &str = "2.1.0";

/// One session start the driver asked for.
pub(crate) struct ScriptedStartRecord {
    /// The conversation it asked to start.
    pub(crate) conversation: ClaudeConversationStart,
    /// The model it started on.
    pub(crate) model: String,
    /// The step bound it started with.
    pub(crate) step_bound: Option<u32>,
    /// Where its frames, requests and exit go.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
    /// The scripted process it got.
    pub(crate) channel: Arc<ScriptedChannel>,
}

/// One one-turn process the driver ran.
pub(crate) struct ScriptedOneTurnRecord {
    /// The conversation it copied.
    pub(crate) resume_handle: Option<String>,
    /// The folder it ran in.
    pub(crate) working_directory: std::path::PathBuf,
    /// The words it sent.
    pub(crate) text: String,
}

#[derive(Default)]
struct ScriptedStartTables {
    sessions: VecDeque<Result<Arc<ScriptedChannel>, String>>,
    one_turns: VecDeque<Result<ClaudeOneTurnReply, String>>,
    started: Vec<ScriptedStartRecord>,
    one_turns_run: Vec<ScriptedOneTurnRecord>,
    next_process_id: u32,
}

/// Every start answered as scripted; a start with nothing scripted fails as a spawn would.
#[derive(Default)]
pub(crate) struct ScriptedStarts {
    tables: Mutex<ScriptedStartTables>,
    started: Notify,
    // Holds each one-turn process until a test lets it go.
    pub(crate) hold_one_turn: Mutex<Option<Arc<Notify>>>,
}

impl ScriptedStarts {
    /// Scripts the next session start to bring up `channel`.
    pub(crate) fn script_session(&self, channel: Arc<ScriptedChannel>) {
        self.lock().sessions.push_back(Ok(channel));
    }

    /// Scripts the next session start to fail with `reason`.
    pub(crate) fn script_failed_session(&self, reason: &str) {
        self.lock().sessions.push_back(Err(reason.to_owned()));
    }

    /// Scripts the next one-turn process to answer `reply`, or fail with the reason.
    pub(crate) fn script_one_turn(&self, reply: Result<ClaudeOneTurnReply, String>) {
        self.lock().one_turns.push_back(reply);
    }

    /// Takes every session start recorded so far.
    pub(crate) fn take_started(&self) -> Vec<ScriptedStartRecord> {
        std::mem::take(&mut self.lock().started)
    }

    /// Takes every one-turn process recorded so far.
    pub(crate) fn take_one_turns(&self) -> Vec<ScriptedOneTurnRecord> {
        std::mem::take(&mut self.lock().one_turns_run)
    }

    /// Waits until at least `count` session starts were recorded since the last take.
    pub(crate) async fn wait_for_starts(&self, count: usize) {
        loop {
            let notified = self.started.notified();
            if self.lock().started.len() >= count {
                return;
            }
            notified.await;
        }
    }

    fn lock(&self) -> MutexGuard<'_, ScriptedStartTables> {
        self.tables.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ClaudeProcessStarts for ScriptedStarts {
    fn start_session<'a>(
        &'a self,
        request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>> {
        async move {
            let mut tables = self.lock();
            let channel = match tables.sessions.pop_front() {
                Some(Ok(channel)) => channel,
                Some(Err(reason)) => return Err(spawn_failure(&reason)),
                None => return Err(spawn_failure("no session scripted")),
            };
            tables.next_process_id += 1;
            let process_id = tables.next_process_id;
            tables.started.push(ScriptedStartRecord {
                conversation: request.conversation,
                model: request.spawn.legs.model.clone(),
                step_bound: request.spawn.step_bound,
                listener: request.listener,
                channel: Arc::clone(&channel),
            });
            drop(tables);
            self.started.notify_one();
            Ok(ClaudeStartedSession {
                channel,
                identity: ProviderProcessIdentity {
                    process_id,
                    spawn_sequence: u64::from(process_id),
                },
                initialize: ClaudeInitializeDeclaration::default(),
                settings_readback: ClaudeSettingsReadback {
                    cleanup_period_days: None,
                    attached_advisor: ClaudeAttachedAdvisor::Unreported,
                },
                spawned_version: spawned_build(SCRIPTED_BUILD_VERSION, "/scripted/claude"),
            })
        }
        .boxed()
    }

    fn read_creation_figures(
        &self,
        _place: ClaudeSessionFolderReadRequest,
        _read_models: HashSet<String>,
    ) -> BoxFuture<'static, Result<ClaudeCreationFiguresReading, ClaudeLaunchError>> {
        async { Err(spawn_failure("no figures scripted")) }.boxed()
    }

    fn read_reply_reserve(
        &self,
        _place: ClaudeSessionFolderReadRequest,
    ) -> BoxFuture<'static, Result<ClaudeReplyReserveReads, ClaudeLaunchError>> {
        async { Err(spawn_failure("no reserve scripted")) }.boxed()
    }

    fn run_one_turn<'a>(
        &'a self,
        request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeOneTurnReply, ClaudeLaunchError>> {
        async move {
            let hold = self
                .hold_one_turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            {
                let mut tables = self.lock();
                tables.one_turns_run.push(ScriptedOneTurnRecord {
                    resume_handle: request.resume_handle.clone(),
                    working_directory: request.spawn.legs.working_directory.clone(),
                    text: request.text.text.clone(),
                });
            }
            if let Some(hold) = hold {
                tokio::select! {
                    () = hold.notified() => {}
                    () = request.stop.cancelled() => return Err(ClaudeLaunchError::TurnStopped),
                }
            }
            match self.lock().one_turns.pop_front() {
                Some(Ok(reply)) => Ok(reply),
                Some(Err(reason)) => Err(spawn_failure(&reason)),
                None => Err(spawn_failure("no one-turn reply scripted")),
            }
        }
        .boxed()
    }

    fn probe_sign_in(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>> {
        async { Err(spawn_failure("no sign-in scripted")) }.boxed()
    }

    fn read_model_catalog(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>> {
        async { Err(spawn_failure("no catalog scripted")) }.boxed()
    }

    fn read_capabilities(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        async { Err(DriverError::Internal("no capabilities scripted".into())) }.boxed()
    }

    fn stop_every_process(&self) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

// A start that fails as a spawn the system refused.
fn spawn_failure(reason: &str) -> ClaudeLaunchError {
    ClaudeLaunchError::Spawn(std::io::Error::other(reason.to_owned()))
}
