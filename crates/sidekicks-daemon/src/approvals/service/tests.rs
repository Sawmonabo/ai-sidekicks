//! The approval service over a test database: a session with one running run, an event log whose
//! session check refuses an answer's write when a test says so, and a run engine the run holds
//! move. The fixture is shared with the run holds', the permission check's and the permission
//! asks' tests.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use rstest::rstest;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalResolutionInvalidReason, ApprovalResolveRequest,
    ApprovalScope, ApprovalState, RememberedRuleSense, RememberedScope, RememberedScopeKind,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::WallClockTimer;
use tempfile::TempDir;

use super::{
    ApprovalService, ApprovalServiceError, RaisedCard, RaisedRequestSettlement, ResolveAnswer,
    refuse_unfit_answer,
};
use crate::approvals::request_create::{
    ApprovalRequestCreateRequest, ApprovalRequestOrigin, ApprovalResourceDescriptor,
};
use crate::approvals::run_blocking::ApprovalRunHolds;
use crate::approvals::store::{APPROVAL_REQUEST_READER_STATEMENT_CAPACITY, StoredApprovalRequest};
use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::git::process::test_git_runner;
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps};
use crate::ipc::domain_error::DomainError;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{stored_run_state, test_engine};
use crate::session::run::projection::insert_queued_run_statement;

/// Bounds a wait the test expects to settle, so one that never does fails the test.
pub(crate) const SETTLE_WAIT: Duration = Duration::from_secs(5);

/// A session with one running run, the approval service over it, and the run engine its holds
/// move.
pub(crate) struct ApprovalFixture {
    /// The test's database.
    pub(crate) database: TestDatabase,
    /// Where the engine's posture files go.
    _home: TempDir,
    /// The writer every append goes through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The approval events' appender.
    pub(crate) events: Arc<SessionEventAppender>,
    /// The run engine the holds move, kept alive here since they reach it weakly.
    _engine: Arc<RunEngine>,
    /// The run holds.
    pub(crate) run_holds: Arc<ApprovalRunHolds>,
    /// The service under test.
    pub(crate) service: Arc<ApprovalService>,
    /// While set, the session refuses an answer's write with `session.rebuilding`.
    pub(crate) refuses_answers: Arc<AtomicBool>,
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its running run.
    pub(crate) run_id: RunId,
}

impl ApprovalFixture {
    /// The fixture, its run `running` at version 1.
    pub(crate) async fn new() -> Self {
        Self::build(true).await
    }

    /// The fixture with holds that reach no engine, so no reconcile moves its run.
    pub(crate) async fn without_holds() -> Self {
        Self::build(false).await
    }

    async fn build(is_engine_reached: bool) -> Self {
        let database = TestDatabase::new();
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let refuses_answers = Arc::new(AtomicBool::new(false));
        let refusing = Arc::clone(&refuses_answers);
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: None,
            refuse_session_write: Some(Box::new(move |_session_id, event_type| {
                let is_answer =
                    event_type == "approval.approved" || event_type == "approval.rejected";
                if is_answer && refusing.load(Ordering::SeqCst) {
                    Err(DomainError::new(
                        "rebuilding",
                        RefusalCode::SessionRebuilding,
                    ))
                } else {
                    Ok(())
                }
            })),
            read_damaged_from_sequence: None,
        }));
        let events = Arc::new(SessionEventAppender::new(
            Arc::clone(&event_log),
            SESSION_EVENT_VERSION.clone(),
        ));
        let home = tempfile::tempdir().expect("a home folder");
        let engine = test_engine(&database, Arc::clone(&event_log), home.path());
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            APPROVAL_REQUEST_READER_STATEMENT_CAPACITY,
        ));
        let reached = if is_engine_reached {
            Arc::downgrade(&engine)
        } else {
            Weak::new()
        };
        let run_holds = Arc::new(ApprovalRunHolds::new(reached, Arc::clone(&reads)));
        let watcher_reads = Arc::new(DatabaseReadPool::new(database.path(), 8));
        let working_folders = Arc::new(WorkingFolderWatcher::new(WorkingFolderWatcherDeps {
            git: test_git_runner(),
            reads: Arc::clone(&watcher_reads),
            occupancy: MountOccupancyReader::new(watcher_reads),
            events: Arc::new(WorktreeEventEmitter::new(event_log)),
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
            )),
            read_watch_ceiling: || Ok(None),
            slow_tick_interval: Duration::from_secs(180),
        }));
        let service = Arc::new(ApprovalService::new(
            reads,
            Arc::clone(&events),
            Arc::clone(&writer),
            working_folders,
            Arc::clone(&run_holds),
        ));
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        // Queued by its agent, as the log names who asks on a card, then running.
        let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
            session_id,
            run_id,
            run_version: SafeInt::ZERO,
            new_state: AgentRunQueuedNewState::Value,
            agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
            resolved_agent: None,
            parent_run_id: None,
            reached_by: None,
            is_apart: None,
            effective_run_config: None,
            admitted_model_family: None,
            admitted_provider_account_id: None,
        });
        let insert_run = insert_queued_run_statement(&queued);
        events
            .append(
                SessionEventDraft::of_session(session_id, &SessionEvent::AgentRunQueued(queued))
                    .expect("the run's queue event drafts"),
                SessionEventLinkage {
                    transactional_prelude: vec![insert_run],
                    ..SessionEventLinkage::default()
                },
            )
            .await
            .expect("the run is queued");
        database
            .reader()
            .execute(
                "UPDATE runs SET state = 'running', run_version = 1 WHERE run_id = ?1",
                [run_id.text().as_str()],
            )
            .expect("the run runs");
        Self {
            database,
            _home: home,
            writer,
            events,
            _engine: engine,
            run_holds,
            service,
            refuses_answers,
            session_id,
            run_id,
        }
    }

    /// Raises a card on the run about `subject`, a command that may be corrected and remembered.
    pub(crate) async fn raise(&self, subject: &str) -> Result<RaisedCard, ApprovalServiceError> {
        self.service
            .create(
                ApprovalRequestCreateRequest {
                    session_id: self.session_id,
                    run_id: self.run_id,
                    requested_by: from_json(json!("agent")),
                    category: ApprovalCategory::ToolExecution,
                    scope: from_json(json!("Bash")),
                    resource_descriptor: from_json(json!({
                        "subject": subject,
                        "standingAllowOffered": true,
                        "projectScopeOffered": false,
                        "editable": true,
                    })),
                },
                ApprovalRequestOrigin::default(),
            )
            .await
    }

    /// Runs `sql` on the test's database.
    pub(crate) fn execute(&self, sql: &str) {
        self.database
            .reader()
            .execute_batch(sql)
            .expect("the test's statement runs");
    }

    /// The stored state of `run_id`.
    pub(crate) fn run_state(&self, run_id: RunId) -> String {
        stored_run_state(&self.database, &run_id).0
    }
}

/// A value read from `value`, as a client or the daemon would send it.
pub(crate) fn from_json<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("the test's value reads as its type")
}

/// An answer to `card`, approving or declining it as `decision` says, under `client_resolution_id`.
fn answer(
    card: &RaisedCard,
    decision: ApprovalDecision,
    client_resolution_id: &str,
    extra: Value,
) -> ApprovalResolveRequest {
    let mut request = json!({
        "decision": decision,
        "approvalRequestId": card.approval_request_id,
        "clientResolutionId": client_resolution_id,
    });
    if let (Some(members), Value::Object(extra)) = (request.as_object_mut(), extra) {
        members.extend(extra);
    }
    from_json(request)
}

fn device() -> DeviceId {
    from_json(json!("device-1"))
}

fn client_id() -> String {
    mint_uuid_v7().to_string()
}

fn refusal(error: ApprovalServiceError) -> DomainError {
    match error {
        ApprovalServiceError::Refused(refusal) => refusal,
        other @ (ApprovalServiceError::Read(_)
        | ApprovalServiceError::Pool(_)
        | ApprovalServiceError::Draft(_)
        | ApprovalServiceError::Cancel(_)) => {
            panic!("the call failed rather than refused: {other}")
        }
    }
}

// A create after its session closed or its run ended raises no ask and names which. Killed by
// swapping the two guards' indexes and by mapping either to persistence-unavailable.
#[rstest]
#[case::closed_session("UPDATE sessions SET state = 'closed'", "sessionClosed")]
#[case::ended_run("UPDATE runs SET state = 'completed'", "runEnded")]
#[tokio::test]
async fn a_late_create_names_what_ended(#[case] end: &str, #[case] reason: &str) {
    let fixture = ApprovalFixture::without_holds().await;
    fixture.execute(end);
    let refused = refusal(
        fixture
            .raise("git push")
            .await
            .err()
            .expect("the create is refused"),
    );
    assert_eq!(refused.code, RefusalCode::ApprovalRequestCanceled);
    assert_eq!(
        refused
            .detail
            .and_then(|detail| detail.get("reason").cloned()),
        Some(json!(reason))
    );
    let rows: i64 = fixture
        .database
        .reader()
        .query_row("SELECT count(*) FROM approval_requests", [], |row| {
            row.get(0)
        })
        .expect("the test counts the asks");
    assert_eq!(rows, 0);
}

/// What a second answer meets after the first.
#[derive(Clone, Copy, Debug)]
enum SecondAnswer {
    /// The same answer sent again under its client resolution id.
    Replay,
    /// Another answer under another id.
    Another,
    /// Any answer once the run's end canceled the card.
    AfterCancel,
    /// The first answer, with the session refusing its write.
    SessionRefusing,
}

// One answer settles a card: the same answer sent again is answered with what was saved and
// records nothing; any other is refused; a canceled card takes no answer; a session refusing the
// write is answered by its own code. Killed by dropping the pending guard, the replay's compare,
// and the session refusal's mapping.
#[rstest]
#[case::replay(SecondAnswer::Replay, None)]
#[case::another(SecondAnswer::Another, Some(RefusalCode::ApprovalAlreadyResolved))]
#[case::after_cancel(SecondAnswer::AfterCancel, Some(RefusalCode::ApprovalRequestCanceled))]
#[case::session_refusing(SecondAnswer::SessionRefusing, Some(RefusalCode::SessionRebuilding))]
#[tokio::test]
async fn one_answer_settles_a_card(
    #[case] second: SecondAnswer,
    #[case] code: Option<RefusalCode>,
) {
    let fixture = ApprovalFixture::without_holds().await;
    let card = fixture.raise("git push").await.expect("the card is raised");
    let first_id = client_id();
    let first = answer(&card, ApprovalDecision::Approved, &first_id, json!({}));
    let saved = match second {
        SecondAnswer::SessionRefusing => {
            fixture.refuses_answers.store(true, Ordering::SeqCst);
            None
        }
        SecondAnswer::AfterCancel => {
            fixture
                .service
                .cancel_pending_for_run(fixture.run_id, None)
                .await
                .expect("the run's asks are canceled");
            None
        }
        SecondAnswer::Replay | SecondAnswer::Another => {
            let resolved = fixture
                .service
                .resolve(&first, device())
                .await
                .expect("the first answer is recorded");
            assert!(resolved.was_recorded);
            Some(resolved.response)
        }
    };
    let again = match second {
        SecondAnswer::Replay | SecondAnswer::AfterCancel | SecondAnswer::SessionRefusing => first,
        SecondAnswer::Another => answer(&card, ApprovalDecision::Rejected, &client_id(), json!({})),
    };
    let outcome = fixture.service.resolve(&again, device()).await;
    match code {
        None => {
            let replayed = outcome.expect("the replay is answered");
            assert!(!replayed.was_recorded);
            assert_eq!(Some(replayed.response), saved);
        }
        Some(code) => {
            let refused = refusal(outcome.expect_err("the answer is refused"));
            assert_eq!(refused.code, code);
        }
    }
}

/// One case of an answer's fit to its ask.
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one independent fact of the ask or the answer a case varies"
)]
struct Fit {
    category: ApprovalCategory,
    is_editable: bool,
    is_standing_allow_offered: bool,
    is_project_scope_offered: bool,
    is_scope_widened: bool,
    is_edited: bool,
    rule: Option<(RememberedScopeKind, RememberedRuleSense, &'static str)>,
}

const FITTING: Fit = Fit {
    category: ApprovalCategory::NetworkAccess,
    is_editable: true,
    is_standing_allow_offered: true,
    is_project_scope_offered: true,
    is_scope_widened: false,
    is_edited: false,
    rule: Some((
        RememberedScopeKind::Session,
        RememberedRuleSense::Allow,
        "git push",
    )),
};

// Each case breaks its own check and every later one it can, so a check run out of its order, or
// dropped, answers another reason. Killed by reordering or dropping a check.
#[rstest]
#[case::scope_widened(
    Fit { is_scope_widened: true, is_editable: false, is_edited: true, ..FITTING },
    Some(ApprovalResolutionInvalidReason::EffectiveScopeBroader)
)]
#[case::edit_not_offered(
    Fit { is_editable: false, is_edited: true, ..FITTING },
    Some(ApprovalResolutionInvalidReason::EditNotOffered)
)]
#[case::edit_with_rule(
    Fit {
        category: ApprovalCategory::ToolExecution,
        is_edited: true,
        rule: Some((RememberedScopeKind::Session, RememberedRuleSense::Block, "curl")),
        ..FITTING
    },
    Some(ApprovalResolutionInvalidReason::EditWithRule)
)]
#[case::block_outside_network(
    Fit {
        category: ApprovalCategory::ToolExecution,
        is_standing_allow_offered: false,
        rule: Some((RememberedScopeKind::Session, RememberedRuleSense::Block, "curl")),
        ..FITTING
    },
    Some(ApprovalResolutionInvalidReason::BlockOutsideNetworkAccess)
)]
#[case::rule_not_offered(
    Fit {
        is_standing_allow_offered: false,
        rule: Some((RememberedScopeKind::Session, RememberedRuleSense::Allow, "curl")),
        ..FITTING
    },
    Some(ApprovalResolutionInvalidReason::RuleNotOffered)
)]
#[case::project_not_offered(
    Fit {
        is_project_scope_offered: false,
        rule: Some((RememberedScopeKind::Project, RememberedRuleSense::Allow, "curl")),
        ..FITTING
    },
    Some(ApprovalResolutionInvalidReason::RuleNotOffered)
)]
#[case::subject_mismatch(
    Fit {
        rule: Some((RememberedScopeKind::Session, RememberedRuleSense::Allow, "curl")),
        ..FITTING
    },
    Some(ApprovalResolutionInvalidReason::SubjectMismatch)
)]
#[case::fits(FITTING, None)]
fn an_answer_that_does_not_fit_names_the_first_check_it_breaks(
    #[case] fit: Fit,
    #[case] reason: Option<ApprovalResolutionInvalidReason>,
) {
    let scope: ApprovalScope = from_json(json!("Bash"));
    let stored = StoredApprovalRequest {
        approval_request_id: from_json(json!(mint_uuid_v7())),
        session_id: test_session_id(),
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        requested_by: from_json(json!("agent")),
        category: fit.category,
        scope: scope.clone(),
        resource_descriptor: from_json::<ApprovalResourceDescriptor>(json!({
            "subject": "git push",
            "standingAllowOffered": fit.is_standing_allow_offered,
            "projectScopeOffered": fit.is_project_scope_offered,
            "editable": fit.is_editable,
        })),
        ask_id: None,
        state: ApprovalState::Pending,
        created_at: WireInstant::now(),
        updated_at: WireInstant::now(),
        standing_allow_offered: fit.is_standing_allow_offered,
        project_scope_offered: fit.is_project_scope_offered,
        resolution: None,
    };
    let widened: ApprovalScope = from_json(json!("Bash and more"));
    let effective_scope = if fit.is_scope_widened { widened } else { scope };
    let edited_action: NonEmptyText = from_json(json!("git push --dry-run"));
    let remembered_scope = fit.rule.map(|(kind, sense, pattern)| RememberedScope {
        kind,
        pattern: from_json(json!(pattern)),
        sense,
    });
    let client_resolution_id = ClientUuid::new(client_id()).expect("a minted UUID");
    let answer = ResolveAnswer {
        approval_request_id: stored.approval_request_id,
        client_resolution_id: &client_resolution_id,
        decision: ApprovalDecision::Approved,
        effective_scope: Some(&effective_scope),
        edited_action: fit.is_edited.then_some(&edited_action),
        decline_reason: None,
        remembered_scope: remembered_scope.as_ref(),
    };
    let refused = refuse_unfit_answer(&stored, &answer, &effective_scope).err();
    assert_eq!(
        refused.map(|refusal| refusal
            .detail
            .and_then(|detail| detail.get("reason").cloned())),
        reason.map(|reason| Some(json!(reason)))
    );
}

// Whoever raised a card hears a decline's words, which no record keeps, and a run's end settles
// every wait on the run's cards, one whose row a rebuild dropped among them. Killed by dropping
// `decline_reason` and by settling a run's waits by the rows it read.
#[tokio::test]
async fn a_raised_card_hears_how_it_settled() {
    let fixture = ApprovalFixture::without_holds().await;
    let declined = fixture.raise("git push").await.expect("the card is raised");
    let decline = answer(
        &declined,
        ApprovalDecision::Rejected,
        &client_id(),
        json!({ "declineReason": "not on main" }),
    );
    fixture
        .service
        .resolve(&decline, device())
        .await
        .expect("the decline is recorded");
    assert_eq!(
        tokio::time::timeout(SETTLE_WAIT, declined.settled.settled())
            .await
            .expect("the decline settles its waiter"),
        RaisedRequestSettlement::Rejected {
            decline_reason: Some(from_json(json!("not on main"))),
        }
    );
    let dropped = fixture
        .raise("cargo publish")
        .await
        .expect("the card is raised");
    fixture.execute("DELETE FROM approval_requests WHERE state = 'pending'");
    fixture
        .service
        .cancel_pending_for_run(fixture.run_id, None)
        .await
        .expect("the run's asks are canceled");
    assert_eq!(
        tokio::time::timeout(SETTLE_WAIT, dropped.settled.settled())
            .await
            .expect("the run's end settles its waiter"),
        RaisedRequestSettlement::Canceled
    );
}
