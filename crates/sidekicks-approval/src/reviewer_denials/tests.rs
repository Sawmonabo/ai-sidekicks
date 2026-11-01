//! Reviewer blocks over a test database: a session with a queued run bound to a provider whose
//! driver is a stand-in, the blocks taken through the port and pressed through `Allow once`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::approval::{ApprovalDenialOverrideRequest, ReviewerDenialId};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_providers,
};
use sidekicks_provider::port::reviewer_denial::ProviderReviewerDenial;
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_session::run::projection::insert_queued_run_statement;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::followers::FollowerAttachment;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{
    DenialOverrideError, REVIEWER_DENIALS_STATEMENT_CAPACITY, ReviewerDenialError, ReviewerDenials,
};
use crate::schema::schema_parts;

mod blocks;
mod presses;

/// Bounds a call the test expects to answer, so one that hangs fails the test.
const ANSWER_WAIT: Duration = Duration::from_secs(5);

/// The provider's own record of every test block.
const PROVIDER_RECORD: &str = r#"{"id":"review-1","status":"denied","action":{"command":"curl"}}"#;

/// A session with a queued run of one agent, the blocks' service following its log.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    events: Arc<SessionEventAppender>,
    denials: Arc<ReviewerDenials>,
    attachment: Option<FollowerAttachment>,
    session_id: SessionId,
    run_id: RunId,
    // The binding of the run to the first provider.
    binding_id: RuntimeBindingId,
}

impl Fixture {
    /// A fixture whose run is bound to the table's first provider, answered by `first`, beside
    /// the second answered by `second`.
    async fn new(first: MockProviderDriver, second: MockProviderDriver) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let events = Arc::new(SessionEventAppender::new(
            Arc::clone(&log.service),
            SESSION_EVENT_VERSION.clone(),
        ));
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let denials = reviewer_denials(&database, &events, first, second);
        let attachment = Some(denials.start(&log.followers));
        let mut fixture = Self {
            database,
            log,
            events,
            denials,
            attachment,
            session_id,
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            binding_id: RuntimeBindingId::new("unbound".to_owned()).expect("a binding id"),
        };
        fixture.run_id = fixture.queue_run().await;
        fixture.binding_id = bind_run_to_first_provider(&fixture.database, fixture.run_id);
        fixture
    }

    /// Stops the blocks' service and drops it, then builds and starts another over the same
    /// database, as the daemon's next start does, its overrides reaching `first` and `second`.
    fn restart(&mut self, first: MockProviderDriver, second: MockProviderDriver) {
        let attachment = self.attachment.take().expect("the fixture follows the log");
        self.denials.stop(attachment);
        let stopped = Arc::downgrade(&self.denials);
        self.denials = reviewer_denials(&self.database, &self.events, first, second);
        assert!(
            stopped.upgrade().is_none(),
            "the stopped service is dropped"
        );
        self.attachment = Some(self.denials.start(&self.log.followers));
    }

    /// Queues a new run of one agent in the session.
    async fn queue_run(&self) -> RunId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
            session_id: self.session_id,
            run_id,
            run_version: SafeInt::ZERO,
            new_state: AgentRunQueuedNewState::Value,
            agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
            resolved_agent: None,
            parent_run_id: None,
            reached_by: None,
            effective_run_config: None,
            admitted_model_family: None,
            admitted_provider_account_id: test_provider_account_id(),
        });
        let insert_run = insert_queued_run_statement(&queued);
        self.append(
            SessionEvent::AgentRunQueued(queued),
            SessionEventLinkage {
                transactional_prelude: vec![insert_run],
                ..SessionEventLinkage::default()
            },
        )
        .await;
        run_id
    }

    async fn append(&self, event: SessionEvent, linkage: SessionEventLinkage) {
        self.events
            .append(
                SessionEventDraft::of_session(self.session_id, &event)
                    .expect("the test's event drafts"),
                linkage,
            )
            .await
            .expect("the test's event is appended");
    }

    /// Opens `tool_call_id` in `run_id`, as its `agent.toolCall.invoked` row, and returns the
    /// row's event id.
    async fn open_call(&self, run_id: RunId, tool_call_id: &str) -> String {
        let invoked = serde_json::from_value(json!({
            "type": "agent.toolCall.invoked",
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "toolName": "Bash",
                "toolCallId": tool_call_id,
            },
        }))
        .expect("the test writes an agent.toolCall.invoked event");
        self.append(invoked, SessionEventLinkage::default()).await;
        self.database
            .reader()
            .query_row(
                "SELECT id FROM session_events WHERE type = 'agent.toolCall.invoked'
                 ORDER BY sequence DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("the test reads the call's row")
    }

    /// Ends `run_id` with its `agent.run.completed`.
    async fn end_run(&self, run_id: RunId) {
        let completed = serde_json::from_value(json!({
            "type": "agent.run.completed",
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "previousState": "running",
                "newState": "completed",
            },
        }))
        .expect("the test writes an agent.run.completed event");
        self.append(completed, SessionEventLinkage::default()).await;
    }

    /// A block on `tool_call_id` of `run_id`.
    fn block(&self, run_id: RunId, tool_call_id: &str) -> ProviderReviewerDenial {
        ProviderReviewerDenial {
            session_id: self.session_id,
            run_id,
            tool_call_id: Some(tool_call_id.to_owned()),
            reason: Some("[Data Exfiltration]".to_owned()),
            is_overridable: true,
            provider_denial: RawValue::from_string(PROVIDER_RECORD.to_owned())
                .expect("the record is JSON"),
        }
    }

    /// Takes `block` in a task of its own, held once its read found no row; answers once it is
    /// held there.
    async fn take_until_waiting(
        &self,
        block: ProviderReviewerDenial,
    ) -> (
        tokio::task::JoinHandle<Result<(), ReviewerDenialError>>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let pause = self.denials.row_read_pause.arm();
        let denials = Arc::clone(&self.denials);
        let taken = tokio::spawn(async move { denials.take(block).await });
        tokio::time::timeout(ANSWER_WAIT, pause.reached)
            .await
            .expect("the block reads no row and waits")
            .expect("the block reaches its wait");
        (taken, pause.release)
    }

    /// Takes `block` and answers how it went.
    async fn take(&self, block: ProviderReviewerDenial) -> Result<(), ReviewerDenialError> {
        tokio::time::timeout(ANSWER_WAIT, self.denials.take(block))
            .await
            .expect("the block is answered")
    }

    /// The row each recorded block names, in record order.
    fn recorded_rows(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT json_extract(payload, '$.eventId') FROM session_events
                 WHERE type = 'approval.reviewer.denied' ORDER BY sequence",
            )
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads the blocks")
            .collect::<Result<_, _>>()
            .expect("each block reads")
    }

    /// The one recorded block's id.
    fn denial_id(&self) -> ReviewerDenialId {
        let text: String = self
            .database
            .reader()
            .query_row("SELECT denial_id FROM reviewer_denials", [], |row| {
                row.get(0)
            })
            .expect("the test reads the block's id");
        ReviewerDenialId::new(&text).expect("a stored block id")
    }

    /// Presses `Allow once` on `denial_id`.
    async fn press(&self, denial_id: ReviewerDenialId) -> Result<WireInstant, DenialOverrideError> {
        tokio::time::timeout(
            ANSWER_WAIT,
            self.denials
                .override_denial(&ApprovalDenialOverrideRequest {
                    session_id: self.session_id,
                    denial_id,
                }),
        )
        .await
        .expect("the press is answered")
        .map(|answered| answered.overridden_at)
    }

    /// Records one block on a committed row of the fixture's run and answers its id.
    async fn recorded_block(&self) -> ReviewerDenialId {
        self.open_call(self.run_id, "call-1").await;
        self.take(self.block(self.run_id, "call-1"))
            .await
            .expect("the block is recorded");
        self.denial_id()
    }

    /// The instants the log's overrides of the session record.
    fn overrides(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT occurred_at FROM session_events
                 WHERE type = 'approval.denial.overridden' ORDER BY sequence",
            )
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads the overrides")
            .collect::<Result<_, _>>()
            .expect("each override reads")
    }
}

/// A blocks' service over `database`, recording through `events`, whose overrides reach `first`
/// for the table's first provider and `second` for the next.
fn reviewer_denials(
    database: &TestDatabase,
    events: &Arc<SessionEventAppender>,
    first: MockProviderDriver,
    second: MockProviderDriver,
) -> Arc<ReviewerDenials> {
    Arc::new(ReviewerDenials::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            REVIEWER_DENIALS_STATEMENT_CAPACITY,
        )),
        Arc::clone(events),
        Arc::new(registry_of_first_providers(vec![
            Arc::new(first),
            Arc::new(second),
        ])),
    ))
}
