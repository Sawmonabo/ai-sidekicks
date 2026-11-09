//! The opening tests open a session's provider session with: the table's first provider at a
//! read-only posture over the root, an idle sleep standing in that records each opening, a resumed
//! runs' ingress standing in that records each resume's runs, and orphaned answers standing in that
//! owe what a test gives them, and the provider sessions tests build on these stand-ins; the
//! queue's own tests also record that provider's contract version.

use std::collections::HashSet;
use std::error::Error;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::Map;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
#[cfg(test)]
use sidekicks_contracts::wire::text::FreeFormText;
#[cfg(test)]
use sidekicks_provider::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::{CreateSessionParams, SessionAccountPin};
use sidekicks_provider::driver::test_registry::first_provider;
use sidekicks_provider::run::posture::{ExecutionPostureService, compose_execution_posture};
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
use sidekicks_session::directory::provider_port::OpeningToolServers;
use sidekicks_session::idle_sleep::openings::SessionProcessFollower;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::epochs::ExecutionEpochs;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::provider_session::ProviderSessionsDeps;
use crate::provider_session::held_run_continue::{
    OrphanedAnswerFuture, OrphanedAnswerSource, OwedAnswer,
};
use crate::provider_session::resumed_runs::{ResumedRuns, ResumedRunsIngress};
use crate::provider_session::{
    OpenedSession, ProviderSessionGitFolderReader, ProviderSessionOpening,
    ProviderSessionOpeningComposer, ProviderSessions,
};

/// Each `providerMissing` notice posted in the database `reader` reads, in the order posted.
#[cfg(test)]
pub(crate) fn read_provider_missing_notices(
    reader: &rusqlite::Connection,
) -> Vec<sidekicks_contracts::session::controls::events::SessionNotice> {
    use sidekicks_contracts::session::controls::events::SessionNotice;

    read_notices(reader)
        .into_iter()
        .filter(|notice| matches!(notice, SessionNotice::ProviderMissing { .. }))
        .collect()
}

/// Each session notice of the common kinds posted in the database `reader` reads, in the order
/// posted.
#[cfg(test)]
pub(crate) fn read_notices(
    reader: &rusqlite::Connection,
) -> Vec<sidekicks_contracts::session::controls::events::SessionNotice> {
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::session::controls::events::SessionNoticePostedPayload;

    reader
        .prepare("SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence")
        .expect("the test reads the notices")
        .query_map([SessionEventType::SessionNoticePosted.as_str()], |row| {
            row.get::<_, String>(0)
        })
        .expect("the notices read")
        .map(|payload| {
            serde_json::from_str::<SessionNoticePostedPayload>(&payload.expect("each notice reads"))
                .expect("a stored notice parses")
        })
        .filter_map(|posted| {
            if let SessionNoticePostedPayload::Notice(notice) = posted {
                Some(notice)
            } else {
                None
            }
        })
        .collect()
}

/// Composes every session's opening on the table's first provider, read-only over the root, on
/// the account it is given, with the stored tool servers it is handed and none composed.
pub fn test_opening_composer() -> ProviderSessionOpeningComposer {
    Arc::new(|session_id, provider_account_id, tool_servers| {
        async move {
            let root = FilesystemPath::new("/".to_owned()).expect("the root is a path");
            Ok(ProviderSessionOpening {
                provider: first_provider(),
                git_folder: root.clone(),
                create_params: CreateSessionParams {
                    session_id,
                    agent_id: AgentId::new(&mint_uuid_v7().to_string())
                        .expect("a minted UUID is an agent id"),
                    config: Map::new(),
                    model: ProviderToken::new("test-model".to_owned()).expect("a model token"),
                    effort: None,
                    larger_window: None,
                    execution_posture: Some(compose_execution_posture(
                        PermissionLevel::Readonly,
                        root,
                    )),
                    mode: SessionMode::Build,
                    output_speed: None,
                    options: Vec::new(),
                    row_values: ProviderRowValues::default(),
                    callback_tools: None,
                    subagent_policy: None,
                    tool_servers: match tool_servers {
                        OpeningToolServers::Stored(stored) => stored,
                        OpeningToolServers::Composed => None,
                    },
                    output_schema: None,
                    provider_account_id,
                    account_pin: SessionAccountPin::Pinned,
                    on_mcp_server_status: None,
                },
                function_legs_for: Arc::new(|_| ResumeFunctionLegs::default()),
            })
        }
        .boxed()
    })
}

impl ProviderSessions {
    /// Records `session_id`'s process opened in this daemon on the table's first provider,
    /// read-only over the root, as a test's live lead stands once its process opened.
    pub fn record_test_opening(&self, session_id: SessionId) {
        let root = FilesystemPath::new("/".to_owned()).expect("the root is a path");
        self.record_opened(
            session_id,
            OpenedSession {
                provider: first_provider(),
                execution_posture: compose_execution_posture(
                    PermissionLevel::Readonly,
                    root.clone(),
                ),
                git_folder: root,
            },
        );
    }
}

/// Reads every session's git folder as the root, as [`test_opening_composer`] composes it.
pub fn test_git_folder_reader() -> ProviderSessionGitFolderReader {
    Arc::new(|_session_id| {
        async { Ok(FilesystemPath::new("/".to_owned()).expect("the root is a path")) }.boxed()
    })
}

/// An idle sleep standing in for the provider sessions' tests, recording each session it was told
/// opened; a close it is told of changes nothing the tests read.
#[derive(Default)]
pub struct RecordedProcessFollowing {
    followed: Mutex<Vec<SessionId>>,
}

impl RecordedProcessFollowing {
    /// Each session it was told opened, in order.
    pub fn followed(&self) -> Vec<SessionId> {
        lock(&self.followed).clone()
    }
}

impl SessionProcessFollower for RecordedProcessFollowing {
    fn follow_awake(&self, session_id: SessionId) {
        lock(&self.followed).push(session_id);
    }

    fn forget_closed(&self, _session_id: SessionId) {}
}

/// A posture service for the provider sessions' tests, whose credential list no test resolves.
pub fn test_execution_postures() -> Arc<ExecutionPostureService> {
    Arc::new(ExecutionPostureService::new(
        Path::new("/home"),
        PathBuf::from("/home/daemon.token"),
    ))
}

/// What a resumed runs' stand-in runs as each resume's runs are handed to it.
pub type ResumedRunsHook = Box<dyn Fn(&ResumedRuns) + Send + Sync>;

/// A resumed runs' ingress standing in for the provider sessions' tests, settling nothing and
/// recording each resume's runs it was handed, after running its hook on them, and each run it
/// was asked to move on from an answered wait; while refused, it fails each take instead.
pub struct RecordedResumedRuns {
    taken: Mutex<Vec<ResumedRuns>>,
    continued: Mutex<Vec<(RunId, RunState)>>,
    on_take: ResumedRunsHook,
    is_refused: AtomicBool,
}

impl RecordedResumedRuns {
    /// A stand-in that runs `on_take` as each resume's runs are handed to it.
    pub fn new(on_take: ResumedRunsHook) -> Self {
        Self {
            taken: Mutex::new(Vec::new()),
            continued: Mutex::new(Vec::new()),
            on_take,
            is_refused: AtomicBool::new(false),
        }
    }

    /// Fails every take from now on while `is_refused`, as a settle whose write fails.
    pub fn set_refused(&self, is_refused: bool) {
        self.is_refused.store(is_refused, Ordering::SeqCst);
    }

    /// Each resume's runs it was handed, in order.
    pub fn taken(&self) -> Vec<ResumedRuns> {
        lock(&self.taken).clone()
    }

    /// Each run it was asked to move on from an answered wait, with the wait, in order.
    pub fn continued(&self) -> Vec<(RunId, RunState)> {
        lock(&self.continued).clone()
    }

    /// The resumed runs' port with this stand-in registered on it.
    pub fn registered(self: &Arc<Self>) -> Arc<PortRegistration<Arc<dyn ResumedRunsIngress>>> {
        let port = PortRegistration::new("resumed runs");
        port.register(Arc::clone(self) as Arc<dyn ResumedRunsIngress>)
            .expect("a new port holds no ingress yet");
        Arc::new(port)
    }
}

impl Default for RecordedResumedRuns {
    fn default() -> Self {
        Self::new(Box::new(|_| {}))
    }
}

impl ResumedRunsIngress for RecordedResumedRuns {
    fn take_resumed_runs(
        &self,
        resumed: ResumedRuns,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        if self.is_refused.load(Ordering::SeqCst) {
            return async { Err("the resumed runs' settle failed".into()) }.boxed();
        }
        (self.on_take)(&resumed);
        lock(&self.taken).push(resumed);
        async { Ok(()) }.boxed()
    }

    fn continue_answered_runs(
        &self,
        runs: Vec<(RunId, RunState)>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.continued).extend(runs);
        async { Ok(()) }.boxed()
    }
}

/// Records the first provider's capabilities in `providers`, so its contract version reads and,
/// where `is_resumable`, it resumes.
#[cfg(test)]
pub(crate) fn record_first_provider_capabilities(providers: &ProviderRegistry, is_resumable: bool) {
    providers
        .record_capabilities(
            &first_provider(),
            DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    is_resumable && flag == DriverCapabilityFlag::Resume
                }),
                contract_version: FreeFormText::new("1.0.0".to_owned())
                    .expect("a contract version"),
            },
        )
        .expect("the first provider is registered");
}

/// Provider sessions reading through `pool`, appending to `event_log` and recording bindings
/// through `writer`, that open on `providers` with the stand-ins above, each resume's runs settled
/// by the ingress `resumed_runs` holds and the cards' orphaned answers read from
/// `orphaned_approvals`.
pub fn test_provider_sessions(
    pool: Arc<DatabaseReadPool>,
    event_log: Arc<EventLogService>,
    writer: Arc<DatabaseWriter>,
    providers: Arc<ProviderRegistry>,
    resumed_runs: Arc<PortRegistration<Arc<dyn ResumedRunsIngress>>>,
    orphaned_approvals: Arc<dyn OrphanedAnswerSource<ApprovalRequestId>>,
) -> Arc<ProviderSessions> {
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&pool),
        Arc::new(|_: &SessionId| None),
        Arc::new(RuntimeBindingStore::new(Arc::clone(&pool), writer)),
        Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        ))),
    ));
    Arc::new(ProviderSessions::new(ProviderSessionsDeps {
        pool,
        appender: Arc::new(SessionEventAppender::new(
            event_log,
            SESSION_EVENT_VERSION.clone(),
        )),
        binding_cursors,
        providers,
        compose_opening: test_opening_composer(),
        read_git_folder: test_git_folder_reader(),
        transition_lock: Arc::new(KeyedLock::new()),
        process_follower: Arc::new(RecordedProcessFollowing::default()),
        execution_postures: test_execution_postures(),
        resumed_runs,
        orphaned_approvals,
        orphaned_questions: Arc::new(OrphanedAnswersStandIn::<QuestionId>::default()),
    }))
}

/// Orphaned answers standing in for the provider sessions' tests: they owe each answer a test gives
/// them until a continue claims it, and owe it again once that continue gives it back; a run holds
/// an open ask while a test says so.
pub struct OrphanedAnswersStandIn<Id> {
    owed: Mutex<Vec<OwedAnswer<Id>>>,
    claimed: Mutex<Vec<Id>>,
    open_asks: Mutex<HashSet<RunId>>,
}

impl<Id> OrphanedAnswersStandIn<Id> {
    /// Owes `answer` after every answer owed before it.
    pub fn owe(&self, answer: OwedAnswer<Id>) {
        lock(&self.owed).push(answer);
    }

    /// Has `run_id` hold an open ask while `is_open`.
    pub fn set_open_ask(&self, run_id: RunId, is_open: bool) {
        let mut open_asks = lock(&self.open_asks);
        if is_open {
            open_asks.insert(run_id);
        } else {
            open_asks.remove(&run_id);
        }
    }
}

impl<Id> Default for OrphanedAnswersStandIn<Id> {
    fn default() -> Self {
        Self {
            owed: Mutex::new(Vec::new()),
            claimed: Mutex::new(Vec::new()),
            open_asks: Mutex::new(HashSet::new()),
        }
    }
}

impl<Id: Clone + PartialEq + Send + Sync> OrphanedAnswerSource<Id> for OrphanedAnswersStandIn<Id> {
    fn owed_continues(
        &self,
        _session_id: SessionId,
    ) -> OrphanedAnswerFuture<'_, Vec<OwedAnswer<Id>>> {
        let claimed = lock(&self.claimed).clone();
        let owed = lock(&self.owed)
            .iter()
            .filter(|owed| !claimed.contains(&owed.id))
            .cloned()
            .collect();
        async { Ok(owed) }.boxed()
    }

    fn claim_continue(&self, id: Id) -> OrphanedAnswerFuture<'_, bool> {
        let mut claimed = lock(&self.claimed);
        let is_claimed = !claimed.contains(&id);
        if is_claimed {
            claimed.push(id);
        }
        async move { Ok(is_claimed) }.boxed()
    }

    fn release_continue(&self, id: Id) -> OrphanedAnswerFuture<'_, ()> {
        lock(&self.claimed).retain(|claimed| *claimed != id);
        async { Ok(()) }.boxed()
    }

    fn has_open_ask(&self, run_id: RunId) -> OrphanedAnswerFuture<'_, bool> {
        let is_open = lock(&self.open_asks).contains(&run_id);
        async move { Ok(is_open) }.boxed()
    }
}
