//! The fixture a session's provider session is tested over: a session an earlier daemon left, its
//! provider sessions and its changes. The openings and the bindings they record are tested in
//! `opening`, a closed or purging session's refusals in `ended_session`, a restart and a process
//! gone in `restart`, the controls that act on the process in `controls`, and a run bound after a
//! resume and the idle sleep's wake in `resume`; a start whose provider is missing posts the
//! session's `providerMissing` notice in `opening`, `resume` and `ended_session`.

mod controls;
mod ended_session;
mod opening;
mod restart;
mod resume;

use std::io;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::wsl_place;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::error_causes::ExecutableUnresolvable;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
    SessionToolServer, answer_every_run_gone,
};
use sidekicks_provider::driver::test_registry::{
    first_provider, new_run_id, registry_of_first_provider,
};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_provider::runtime_binding::store::{CreateRuntimeBindingInput, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
use sidekicks_session::directory::provider_port::OpeningToolServers;
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
use sidekicks_session::idle_sleep::openings::SessionProcessFollower;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::engine::test_fixture::insert_run;
use sidekicks_session::run::epochs::ExecutionEpochs;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    SessionAppendRefusal,
};
use sidekicks_store::events::session::appender::{SessionEventAppender, UnsequencedEventEnvelope};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::test_opening::{
    OrphanedAnswersStandIn, RecordedProcessFollowing, RecordedResumedRuns,
    record_first_provider_capabilities, test_execution_postures, test_opening_composer,
};
use super::{
    GitFolderReadError, ProviderSessionGitFolderReader, ProviderSessionOpeningComposer,
    ProviderSessions, ProviderSessionsDeps,
};

/// The statements the test's read pool prepares.
const READ_STATEMENT_CAPACITY: usize = 16;

/// Bounds the open, which waits on its own lock forever when it takes it twice.
const WAIT: Duration = Duration::from_secs(5);

/// How long a resume that would land inside a close is given to land there.
const CLOSE_HELD: Duration = Duration::from_millis(500);

/// The place the fixture's session runs in, `wsl_place("Ubuntu")`, as its directory row stores it.
const TEST_PLACE: &str = r#"{"distro":"Ubuntu"}"#;

/// What runs inside the fixture's driver resume, given the params it was handed.
type ResumeHook = Box<dyn Fn(&ResumeSessionParams) + Send + Sync>;

/// What runs as the close's `session.closed` is appended, before its write is queued.
type ClosedAppendHook = Box<dyn Fn() + Send + Sync>;

// A session an earlier daemon ran on its binding, its provider sessions and its changes sharing the
// transition lock, over a driver that resumes the conversation on the binding the queue minted, or
// on `came_up_on` once a test sets it, checking that binding's cursor is open as it runs, and
// closes at once, counting each close; each event changes the session's directory row, so a close
// leaves the session reading closed. Once a test sets `is_row_taken`, a resume first records a row
// under the binding it runs on, so the queue's own record of it fails; once it sets `is_deferred`,
// a resume starts no process and answers every run waiting; once it sets `git_folder`, an opening
// names that git folder, and once it sets `provider`, that provider; once it sets `is_refused`, a
// resume fails; once it sets `is_provider_missing`, a resume or restart answers the provider not
// installed. A resume carrying a continue answers its lead still running, but once a test sets
// `is_continue_dropped`, gone. The session runs in `TEST_PLACE`. The resumed runs' stand-in records
// each resume's runs, and whether the binding last handed out had a row as they reached it; the
// orphaned answers' stand-ins owe what a test gives them.
struct Opening {
    database: TestDatabase,
    session_id: SessionId,
    earlier_run_id: RunId,
    run_id: RunId,
    predecessor_id: RuntimeBindingId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    handed_ids: Arc<Mutex<Vec<RuntimeBindingId>>>,
    stored_sets: Arc<Mutex<Vec<StoredSet>>>,
    came_up_on: Arc<Mutex<Option<RuntimeBindingId>>>,
    is_row_taken: Arc<AtomicBool>,
    is_deferred: Arc<AtomicBool>,
    is_refused: Arc<AtomicBool>,
    is_continue_dropped: Arc<AtomicBool>,
    git_folder: Arc<Mutex<Option<FilesystemPath>>>,
    provider: Arc<Mutex<Option<ProviderId>>>,
    is_provider_missing: Arc<AtomicBool>,
    closes: Arc<AtomicUsize>,
    sessions: Arc<ProviderSessions>,
    execution_postures: Arc<ExecutionPostureService>,
    changes: Arc<SessionChanges>,
    following: Arc<RecordedProcessFollowing>,
    resumed_runs: Arc<RecordedResumedRuns>,
    handed_rows_at_take: Arc<Mutex<Vec<bool>>>,
    orphaned_approvals: Arc<OrphanedAnswersStandIn<ApprovalRequestId>>,
}

impl Opening {
    // `on_resume` runs inside the driver's resume, `on_closed_append` as the close's
    // `session.closed` is appended, before its write is queued, and `expect` adds the test's own
    // expectations to the driver, which may watch the cursors and the bindings handed out.
    async fn new(
        on_resume: ResumeHook,
        on_closed_append: ClosedAppendHook,
        expect: impl FnOnce(&mut MockProviderDriver, &OpeningWatch),
    ) -> Self {
        let database = TestDatabase::new(
            schema_parts().with_parts(sidekicks_session::agent_tree::schema::schema_parts()),
        );
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let session_id = test_session_id();
        let earlier_run_id = new_run_id();
        let run_id = new_run_id();
        insert_session_row(
            &database.reader(),
            session_id.text().as_str(),
            None,
            Some(TEST_PLACE),
        );
        insert_run(&database, session_id, earlier_run_id, "running");
        insert_run(&database, session_id, run_id, "running");
        queue_on_test_account(&database, session_id, run_id);
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(|envelope: &UnsequencedEventEnvelope| {
                Ok(directory_statements_for(&DirectoryEvent::from(envelope))?)
            })),
            refuse_session_write: Some(Box::new(
                move |_session_id: &SessionId, event_type: &str| {
                    if event_type == SessionEventType::SessionClosed.as_str() {
                        on_closed_append();
                    }
                    Ok::<(), SessionAppendRefusal>(())
                },
            )),
            read_damaged_from_sequence: None,
        }));
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        )));
        let store = Arc::new(RuntimeBindingStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
        ));
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::new(|_: &SessionId| None),
            Arc::clone(&store),
            Arc::clone(&epochs),
        ));
        let predecessor_id = binding_cursors
            .create(
                session_id,
                CreateRuntimeBindingInput {
                    run_id: earlier_run_id,
                    ..binding_input(
                        spawn_config_on(test_provider_account_id()),
                        spawned_build("1.0.0", "/opt/provider/bin"),
                    )
                },
            )
            .await
            .expect("the earlier daemon's binding is recorded")
            .id;
        let handed_ids = Arc::new(Mutex::new(Vec::new()));
        let stored_sets = Arc::new(Mutex::new(Vec::new()));
        let came_up_on = Arc::new(Mutex::new(None::<RuntimeBindingId>));
        let is_row_taken = Arc::new(AtomicBool::new(false));
        let is_deferred = Arc::new(AtomicBool::new(false));
        let is_refused = Arc::new(AtomicBool::new(false));
        let is_continue_dropped = Arc::new(AtomicBool::new(false));
        let closes = Arc::new(AtomicUsize::new(0));
        let git_folder = Arc::new(Mutex::new(None));
        let provider = Arc::new(Mutex::new(None));
        let is_provider_missing = Arc::new(AtomicBool::new(false));
        let execution_postures = test_execution_postures();
        let on_resume: Arc<dyn Fn(&ResumeSessionParams) + Send + Sync> = Arc::from(on_resume);
        // The resume and the restart answer alike.
        let answer_relaunch = || {
            let (epochs, store) = (Arc::clone(&epochs), Arc::clone(&store));
            let (came_up_on, is_row_taken) = (Arc::clone(&came_up_on), Arc::clone(&is_row_taken));
            let (on_resume, is_deferred, is_provider_missing) = (
                Arc::clone(&on_resume),
                Arc::clone(&is_deferred),
                Arc::clone(&is_provider_missing),
            );
            let is_refused = Arc::clone(&is_refused);
            let is_continue_dropped = Arc::clone(&is_continue_dropped);
            move |params: ResumeSessionParams| {
                assert_eq!(params.resume_handle, "conversation-1");
                assert!(
                    lock(&epochs).binding(&params.binding_id).is_ok(),
                    "the resume's cursor is open before the process runs"
                );
                if is_provider_missing.load(Ordering::SeqCst) {
                    return async { Err(unresolvable_provider(false)) }.boxed();
                }
                on_resume(&params);
                if is_refused.load(Ordering::SeqCst) {
                    return async {
                        Ok(DriverResumeResult::Failed {
                            recovery_condition: RecoveryCondition::RecoveryNeeded,
                            provider_failure_detail: FreeFormText::new(
                                "the conversation could not be read".to_owned(),
                            )
                            .expect("a failure detail"),
                        })
                    }
                    .boxed();
                }
                if is_deferred.load(Ordering::SeqCst) {
                    let runs = params
                        .live_runs
                        .iter()
                        .map(|run| ResumedRunAnswer {
                            run_id: run.run_id,
                            turn: ProviderTurnAnswer::Waiting,
                        })
                        .collect();
                    return async move { Ok(DriverResumeResult::Deferred { runs }) }.boxed();
                }
                let binding_id = lock(&came_up_on)
                    .clone()
                    .unwrap_or_else(|| params.binding_id.clone());
                let taken = is_row_taken
                    .load(Ordering::SeqCst)
                    .then(|| params.binding_id.clone());
                let store = Arc::clone(&store);
                let mut runs = answer_every_run_gone(&params.live_runs);
                if let Some(held_run_continue) = &params.held_run_continue
                    && !is_continue_dropped.load(Ordering::SeqCst)
                {
                    for answer in &mut runs {
                        if answer.run_id == held_run_continue.lead_run_id {
                            answer.turn = ProviderTurnAnswer::StillRunning;
                        }
                    }
                }
                async move {
                    if let Some(taken) = taken {
                        take_row(&store, taken, earlier_run_id).await;
                    }
                    Ok(DriverResumeResult::Resumed {
                        binding_id,
                        session_position: SafeInt::new(1).expect("a position"),
                        resume_handle: NonEmptyText::new("conversation-1".to_owned())
                            .expect("a resume handle"),
                        spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
                        runs,
                    })
                }
                .boxed()
            }
        };
        let mut driver = MockProviderDriver::new();
        driver.expect_resume_session().returning(answer_relaunch());
        driver.expect_restart_session().returning(answer_relaunch());
        driver.expect_close_session().returning({
            let closes = Arc::clone(&closes);
            move |_params| {
                closes.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }.boxed()
            }
        });
        expect(
            &mut driver,
            &OpeningWatch {
                epochs: Arc::clone(&epochs),
                handed_ids: Arc::clone(&handed_ids),
                store: Arc::clone(&store),
            },
        );
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        record_first_provider_capabilities(&providers, true);
        let changes = Arc::new(SessionChanges::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CHANGES_STATEMENT_CAPACITY,
            )),
            Arc::clone(&event_log),
            Arc::clone(&providers),
        ));
        let following = Arc::new(RecordedProcessFollowing::default());
        let handed_rows_at_take = Arc::new(Mutex::new(Vec::new()));
        let resumed_runs = Arc::new(RecordedResumedRuns::new(Box::new({
            let (path, handed_ids) = (database.path(), Arc::clone(&handed_ids));
            let handed_rows_at_take = Arc::clone(&handed_rows_at_take);
            move |_resumed| {
                let handed_id = lock(&handed_ids)
                    .last()
                    .cloned()
                    .expect("a resume handed its process a binding");
                let has_row: bool = rusqlite::Connection::open(&path)
                    .expect("the stand-in opens the test database")
                    .query_row(
                        "SELECT EXISTS (SELECT 1 FROM runtime_bindings WHERE id = ?1)",
                        [handed_id.as_str()],
                        |row| row.get(0),
                    )
                    .expect("the stand-in reads the bindings");
                lock(&handed_rows_at_take).push(has_row);
            }
        })));
        let orphaned_approvals = Arc::new(OrphanedAnswersStandIn::default());
        let sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
            pool,
            appender: Arc::new(SessionEventAppender::new(
                event_log,
                SESSION_EVENT_VERSION.clone(),
            )),
            binding_cursors,
            providers,
            compose_opening: recording_composer(&handed_ids, &stored_sets, &git_folder, &provider),
            read_git_folder: recording_git_folder(&git_folder),
            transition_lock: Arc::clone(changes.transition_lock()),
            process_follower: Arc::clone(&following) as Arc<dyn SessionProcessFollower>,
            execution_postures: Arc::clone(&execution_postures),
            resumed_runs: resumed_runs.registered(),
            orphaned_approvals: Arc::clone(&orphaned_approvals) as Arc<_>,
            orphaned_questions: Arc::new(OrphanedAnswersStandIn::<QuestionId>::default()),
        }));
        execution_postures
            .set_stored_postures(Arc::downgrade(&sessions) as Weak<_>)
            .expect("a new posture service reads no stored level yet");
        Self {
            database,
            session_id,
            earlier_run_id,
            run_id,
            predecessor_id,
            epochs,
            handed_ids,
            stored_sets,
            came_up_on,
            is_row_taken,
            is_deferred,
            is_refused,
            is_continue_dropped,
            git_folder,
            provider,
            is_provider_missing,
            closes,
            sessions,
            execution_postures,
            changes,
            following,
            resumed_runs,
            handed_rows_at_take,
            orphaned_approvals,
        }
    }

    // The binding the latest opening's process was handed to run under.
    fn handed_id(&self) -> RuntimeBindingId {
        lock(&self.handed_ids)
            .last()
            .cloned()
            .expect("an opening handed its process a binding")
    }

    // The one notice a start on `provider` posts for the session in `TEST_PLACE`.
    fn provider_missing_notice(&self, provider: ProviderId) -> SessionNotice {
        SessionNotice::ProviderMissing {
            session_id: self.session_id,
            provider,
            place: Some(wsl_place("Ubuntu")),
        }
    }
}

// The failure a driver answers when the provider's command names no build: a bare name no search
// found, the provider not installed, or a path the person typed that does not run.
fn unresolvable_provider(is_typed_path: bool) -> DriverError {
    DriverError::from(ExecutableUnresolvable {
        provider: first_provider(),
        requested_command: if is_typed_path {
            "/opt/provider/missing".to_owned()
        } else {
            "missing".to_owned()
        },
        is_typed_path,
        is_build_found: false,
        cause: io::Error::from(io::ErrorKind::NotFound),
    })
}

// A provider no driver of the fixture answers.
fn unregistered_provider() -> ProviderId {
    ProviderId::new("unregistered".to_owned()).expect("a provider id")
}

// Writes `run_id`'s `agent.run.queued` admitted against the test's account, as its admission
// would, so a create reads the account it runs on.
fn queue_on_test_account(database: &TestDatabase, session_id: SessionId, run_id: RunId) {
    let queued = SessionEventType::AgentRunQueued;
    database
        .reader()
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, run_id, run_version)
             VALUES (?1, ?2, 0, ?3, 0, ?4, ?5, ?6, ?7, 1)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                WireInstant::now().as_str(),
                queued.category().as_str(),
                queued.as_str(),
                json!({
                    "runId": run_id.text().as_str(),
                    "admittedProviderAccountId": test_provider_account_id().as_str(),
                })
                .to_string(),
                run_id.text().as_str(),
            ],
        )
        .expect("the test queues the run");
}

// What a test's own driver expectations watch: the cursors, and each binding an opening handed its
// process.
struct OpeningWatch {
    epochs: Arc<Mutex<ExecutionEpochs>>,
    handed_ids: Arc<Mutex<Vec<RuntimeBindingId>>>,
    store: Arc<RuntimeBindingStore>,
}

// What one composition's opening was handed: the set a resume's leg stored, `None` where the
// opening composed its own.
type StoredSet = Option<Option<Vec<SessionToolServer>>>;

// The test composer's opening, its callbacks recording each binding they are bound to and each
// composition's stored set, on `git_folder` and `provider` once each is set.
fn recording_composer(
    handed_ids: &Arc<Mutex<Vec<RuntimeBindingId>>>,
    stored_sets: &Arc<Mutex<Vec<StoredSet>>>,
    git_folder: &Arc<Mutex<Option<FilesystemPath>>>,
    provider: &Arc<Mutex<Option<ProviderId>>>,
) -> ProviderSessionOpeningComposer {
    let composer = test_opening_composer();
    let (handed_ids, git_folder) = (Arc::clone(handed_ids), Arc::clone(git_folder));
    let (provider, stored_sets) = (Arc::clone(provider), Arc::clone(stored_sets));
    Arc::new(move |session_id, provider_account_id, tool_servers| {
        let (composer, handed_ids) = (Arc::clone(&composer), Arc::clone(&handed_ids));
        lock(&stored_sets).push(match &tool_servers {
            OpeningToolServers::Stored(stored) => Some(stored.clone()),
            OpeningToolServers::Composed => None,
        });
        let (git_folder, provider) = (lock(&git_folder).clone(), lock(&provider).clone());
        async move {
            let mut opening = composer(session_id, provider_account_id, tool_servers).await?;
            if let Some(git_folder) = git_folder {
                opening.git_folder = git_folder;
            }
            if let Some(provider) = provider {
                opening.provider = provider;
            }
            opening.function_legs_for = Arc::new(move |binding_id| {
                lock(&handed_ids).push(binding_id.clone());
                ResumeFunctionLegs::default()
            });
            Ok(opening)
        }
        .boxed()
    })
}

// Reads every session's git folder as `git_folder` names it once one is set, else the root; a
// folder deleted since is unavailable, as git finds no repository there.
fn recording_git_folder(
    git_folder: &Arc<Mutex<Option<FilesystemPath>>>,
) -> ProviderSessionGitFolderReader {
    let git_folder = Arc::clone(git_folder);
    Arc::new(move |_session_id| {
        let git_folder = lock(&git_folder)
            .clone()
            .unwrap_or_else(|| FilesystemPath::new("/".to_owned()).expect("the root is a path"));
        async move {
            if !Path::new(git_folder.as_str()).exists() {
                return Err(GitFolderReadError::Unavailable(
                    "the repository folder is gone".into(),
                ));
            }
            Ok(git_folder)
        }
        .boxed()
    })
}

// Records a row under `binding_id` ahead of the queue, so the queue's own record of it fails.
async fn take_row(store: &RuntimeBindingStore, binding_id: RuntimeBindingId, run_id: RunId) {
    store
        .create(CreateRuntimeBindingInput {
            id: binding_id,
            run_id,
            ..binding_input(
                spawn_config_on(test_provider_account_id()),
                spawned_build("1.0.0", "/opt/provider/bin"),
            )
        })
        .await
        .expect("the test takes the binding's row");
}
