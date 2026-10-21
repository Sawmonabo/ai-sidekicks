//! Every process start answered by a script instead of a Claude Code program: a session's process
//! is the next scripted channel, a one-turn process the next scripted reply, and each start is
//! recorded with the conversation it asked for and the listener its frames and exit go to.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::{Notify, oneshot};

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
    /// Where its frames, requests and exit go.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
}

#[derive(Default)]
struct ScriptedStartTables {
    sessions: VecDeque<Result<Arc<ScriptedChannel>, String>>,
    session_holds: VecDeque<oneshot::Receiver<()>>,
    catalogs: VecDeque<Value>,
    started: Vec<ScriptedStartRecord>,
    one_turns_run: usize,
    next_process_id: u32,
}

/// Every start answered as scripted; a start with nothing scripted fails as a spawn would.
#[derive(Default)]
pub(crate) struct ScriptedStarts {
    tables: Mutex<ScriptedStartTables>,
    started: Notify,
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

    /// Holds the next session start, once recorded, until the returned sender fires or drops.
    pub(crate) fn hold_next_session_start(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        self.lock().session_holds.push_back(held);
        release
    }

    /// Scripts the next model catalog read to answer `initialize` as its `initialize` reply.
    pub(crate) fn script_catalog(&self, initialize: Value) {
        self.lock().catalogs.push_back(initialize);
    }

    /// Takes every session start recorded so far.
    pub(crate) fn take_started(&self) -> Vec<ScriptedStartRecord> {
        std::mem::take(&mut self.lock().started)
    }

    /// Takes the count of one-turn processes run so far.
    pub(crate) fn take_one_turn_count(&self) -> usize {
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
            let (channel, process_id, hold) = {
                let mut tables = self.lock();
                let channel = match tables.sessions.pop_front() {
                    Some(Ok(channel)) => channel,
                    Some(Err(reason)) => return Err(spawn_failure(&reason)),
                    None => return Err(spawn_failure("no session scripted")),
                };
                tables.next_process_id += 1;
                tables.started.push(ScriptedStartRecord {
                    conversation: request.conversation,
                    listener: request.listener,
                });
                (
                    channel,
                    tables.next_process_id,
                    tables.session_holds.pop_front(),
                )
            };
            self.started.notify_one();
            if let Some(hold) = hold {
                // A dropped sender releases the start too.
                hold.await.unwrap_or(());
            }
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
                    ultracode: None,
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
        _request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeOneTurnReply, ClaudeLaunchError>> {
        self.lock().one_turns_run += 1;
        async { Err(spawn_failure("no one-turn reply scripted")) }.boxed()
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
        let initialize = self.lock().catalogs.pop_front();
        async move {
            let initialize = initialize.ok_or_else(|| spawn_failure("no catalog scripted"))?;
            Ok(ClaudeModelCatalogReading {
                initialize: Some(
                    serde_json::value::to_raw_value(&initialize)
                        .expect("a scripted reply serializes"),
                ),
                context_usage: None,
            })
        }
        .boxed()
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
