//! Every process start answered by a script instead of a Claude Code program: a session's process
//! is the next scripted channel, declaring the next scripted `initialize` reply; a one-turn process
//! answers the next scripted reply; a catalog or figures read answers the next scripted reading.
//! Each start is recorded with what it asked for.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::{Notify, oneshot};

use super::channel::ScriptedChannel;
use crate::driver::claude::session::answered_commands::ClaudeAttachedAdvisor;
use crate::driver::claude::session::process::ClaudeProcessListener;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeModelCatalogReading, ClaudeReplyReserveReads,
    ClaudeSessionFolderReadRequest,
};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSettingsReadback,
};
use crate::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnReply, ClaudeOneTurnRequest};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::{DriverError, GetCapabilitiesResult};
use crate::process_identity::ProviderProcessIdentity;
use crate::runtime_binding::test_store::spawned_build;

/// The build every scripted process reports.
pub(super) const SCRIPTED_BUILD_VERSION: &str = "2.1.0";

/// One session start the driver asked for.
pub(crate) struct ScriptedStartRecord {
    /// The conversation it asked to start.
    pub(crate) conversation: ClaudeConversationStart,
    /// Where its frames, requests and exit go.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
    /// The advisor it starts with.
    pub(crate) advisor: ClaudeSessionAdvisor,
    /// The step bound it starts with.
    pub(crate) step_bound: Option<u32>,
    /// The mode it starts in in place of its level's own.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
    /// The environment it starts with.
    pub(crate) environment: Vec<(String, String)>,
}

/// One one-turn process the driver asked for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScriptedOneTurnRecord {
    /// The model it runs on.
    pub(crate) model: String,
    /// The conversation it copies.
    pub(crate) resume_handle: Option<String>,
    /// The mode it runs in in place of its level's own.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
}

#[derive(Default)]
struct ScriptedStartTables {
    sessions: VecDeque<Result<Arc<ScriptedChannel>, String>>,
    initializes: VecDeque<ClaudeInitializeDeclaration>,
    resolved_advisors: VecDeque<ClaudeSessionAdvisor>,
    session_holds: VecDeque<oneshot::Receiver<()>>,
    catalogs: VecDeque<Value>,
    catalog_environments: Vec<Vec<(String, String)>>,
    creation_figures: VecDeque<ClaudeCreationFiguresReading>,
    creation_reads: usize,
    one_turn_replies: VecDeque<ClaudeOneTurnReply>,
    one_turns: Vec<ScriptedOneTurnRecord>,
    one_turn_environments: Vec<Vec<(String, String)>>,
    started: Vec<ScriptedStartRecord>,
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

    /// Scripts the next session start's process to declare `initialize`, in place of an empty
    /// declaration.
    pub(crate) fn script_initialize(&self, initialize: ClaudeInitializeDeclaration) {
        self.lock().initializes.push_back(initialize);
    }

    /// Scripts the next session start's settings to read back `advisor` as the one its settings
    /// resolve, in place of no effective settings.
    pub(crate) fn script_resolved_advisor(&self, advisor: ClaudeSessionAdvisor) {
        self.lock().resolved_advisors.push_back(advisor);
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

    /// Scripts the next creation-time figures read to answer `reading`.
    pub(crate) fn script_creation_figures(&self, reading: ClaudeCreationFiguresReading) {
        self.lock().creation_figures.push_back(reading);
    }

    /// Scripts the next one-turn process to answer `reply`.
    pub(crate) fn script_one_turn(&self, reply: ClaudeOneTurnReply) {
        self.lock().one_turn_replies.push_back(reply);
    }

    /// Takes the environment of each model catalog read so far.
    pub(crate) fn take_catalog_environments(&self) -> Vec<Vec<(String, String)>> {
        std::mem::take(&mut self.lock().catalog_environments)
    }

    /// Takes the count of creation-time figures reads so far.
    pub(crate) fn take_creation_read_count(&self) -> usize {
        std::mem::take(&mut self.lock().creation_reads)
    }

    /// Takes every session start recorded so far.
    pub(crate) fn take_started(&self) -> Vec<ScriptedStartRecord> {
        std::mem::take(&mut self.lock().started)
    }

    /// Takes every one-turn process run so far.
    pub(crate) fn take_one_turns(&self) -> Vec<ScriptedOneTurnRecord> {
        std::mem::take(&mut self.lock().one_turns)
    }

    /// Takes the environment of each one-turn process run so far.
    pub(crate) fn take_one_turn_environments(&self) -> Vec<Vec<(String, String)>> {
        std::mem::take(&mut self.lock().one_turn_environments)
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
        sidekicks_std::mutex_lock::lock(&self.tables)
    }
}

impl ClaudeProcessStarts for ScriptedStarts {
    fn start_session<'a>(
        &'a self,
        request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>> {
        async move {
            let (channel, initialize, resolved_advisor, process_id, hold) = {
                let mut tables = self.lock();
                let channel = match tables.sessions.pop_front() {
                    Some(Ok(channel)) => channel,
                    Some(Err(reason)) => return Err(spawn_failure(&reason)),
                    None => return Err(spawn_failure("no session scripted")),
                };
                tables.next_process_id += 1;
                channel.hand_exit_to(Arc::clone(&request.listener));
                tables.started.push(ScriptedStartRecord {
                    conversation: request.conversation,
                    listener: request.listener,
                    advisor: request.spawn.legs.advisor.clone(),
                    step_bound: request.spawn.step_bound,
                    permission_mode: request.permission_mode,
                    environment: request.spawn.legs.spawn_environment.clone(),
                });
                (
                    channel,
                    tables.initializes.pop_front().unwrap_or_default(),
                    tables
                        .resolved_advisors
                        .pop_front()
                        .unwrap_or(ClaudeSessionAdvisor::Unpicked),
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
                initialize,
                settings_readback: ClaudeSettingsReadback {
                    cleanup_period_days: None,
                    attached_advisor: ClaudeAttachedAdvisor::Unreported,
                    resolved_advisor,
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
        let reading = {
            let mut tables = self.lock();
            tables.creation_reads += 1;
            tables.creation_figures.pop_front()
        };
        async move { reading.ok_or_else(|| spawn_failure("no figures scripted")) }.boxed()
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
        let reply = {
            let mut tables = self.lock();
            tables.one_turns.push(ScriptedOneTurnRecord {
                model: request.spawn.legs.model.clone(),
                resume_handle: request.resume_handle,
                permission_mode: request.permission_mode,
            });
            tables
                .one_turn_environments
                .push(request.spawn.legs.spawn_environment.clone());
            tables.one_turn_replies.pop_front()
        };
        async move { reply.ok_or_else(|| spawn_failure("no one-turn reply scripted")) }.boxed()
    }

    fn probe_sign_in(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>> {
        async { Err(spawn_failure("no sign-in scripted")) }.boxed()
    }

    fn read_model_catalog(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>> {
        let initialize = {
            let mut tables = self.lock();
            tables.catalog_environments.push(environment);
            tables.catalogs.pop_front()
        };
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
