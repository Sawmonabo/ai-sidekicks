//! The session goal service: a goal set on or cleared from one agent is checked against the
//! session, the agent, the session's lead and the provider's goal capability, the session is woken
//! where its process sleeps, and the change goes to the provider on the lead's conversation; a set
//! on a session that never ran goes to the lead's provider, which opens the session's process for
//! it. It appends nothing: each goal event comes from what the provider writes.

use std::error::Error;
use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FALLBACK_ACTION_MAX_LEN;
use sidekicks_contracts::session::controls::methods::SessionAcknowledgment;
use sidekicks_contracts::session::goal::{
    SessionGoalClearRequest, SessionGoalUpdateRequest, SessionGoalUpdateResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::agent::agent_not_found;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::{ProviderRegistry, provider_capability_unsupported};
use sidekicks_provider::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams,
};
use sidekicks_provider::port::session_wake::SessionWaker;
use sidekicks_provider::runtime_binding::store::{RuntimeBinding, RuntimeBindingStoreError};
use sidekicks_session::agents::projection::{AgentRow, read_agent_row};
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_session::run::agent::{RunAgentReadError, read_lead_agent_through};
use sidekicks_session::run::stored_leg::read_agent_leg;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

/// The goal service, one for the daemon; see the module doc.
pub(crate) struct SessionGoals {
    /// The daemon's read connections, which read the session, the agent, the lead and the leg.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The drivers, whose capability snapshot gates a goal and whose legs carry it.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The idle sleep, which wakes a sleeping session before its goal is sent.
    pub(crate) session_wakes: Arc<dyn SessionWaker>,
}

/// Why a goal change was not made: refused, failed by the provider, or its reads or wake failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionGoalError {
    /// The session, the agent or the provider refused the change.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The driver or its provider failed the change.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// No read connection could be had.
    #[error("no connection could read the session")]
    Read(#[from] DatabaseReadError),
    /// The session's or the agent's row could not be read.
    #[error("the session's rows could not be read")]
    Query(#[from] rusqlite::Error),
    /// The session's lead could not be read from its log.
    #[error(transparent)]
    Lead(#[from] RunAgentReadError),
    /// The session's leg could not be read.
    #[error(transparent)]
    Leg(#[from] RuntimeBindingStoreError),
    /// The sleeping session could not be woken.
    #[error("the session could not be woken for its goal")]
    Wake(#[source] Box<dyn Error + Send + Sync>),
}

impl From<SessionGoalError> for HandlerError {
    /// A refusal answers by its code and a driver's failure as the driver's own conversion does;
    /// a failed read or wake is a fault inside the daemon.
    fn from(error: SessionGoalError) -> Self {
        match error {
            SessionGoalError::Refused(refusal) => Self::Refused(refusal),
            SessionGoalError::Driver(error) => error.into(),
            fault @ (SessionGoalError::Read(_)
            | SessionGoalError::Query(_)
            | SessionGoalError::Lead(_)
            | SessionGoalError::Leg(_)
            | SessionGoalError::Wake(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl SessionGoals {
    /// Sets `request`'s goal on its agent and echoes it once the provider took it. Refused
    /// `session.notFound`, `agent.notFound`, `provider.capability.unsupported` for an agent other
    /// than the lead or a provider without goals, and `session.goal.notApplied` when the provider
    /// did not take it. On a session that never ran, the lead's provider opens the session's
    /// process for the goal, so nothing is woken first.
    pub(crate) async fn update(
        &self,
        request: SessionGoalUpdateRequest,
    ) -> Result<SessionGoalUpdateResponse, SessionGoalError> {
        let SessionGoalUpdateRequest {
            session_id,
            agent_id,
            goal,
        } = request;
        let (row, leg) = self.reach_lead(session_id, agent_id).await?;
        let driver = match leg {
            Some(leg) => self.wake_leg(session_id, &leg).await?,
            None => self.providers.lookup(&row.binding.provider_name)?,
        };
        let params = SetSessionGoalParams::new(session_id, goal.text.as_str().to_owned());
        applied(driver.set_session_goal(params).await?)?;
        Ok(SessionGoalUpdateResponse { session_id, goal })
    }

    /// Clears `request`'s agent's goal, refused as [`Self::update`] is; a session that never ran
    /// holds no goal, so its clear succeeds with nothing sent.
    pub(crate) async fn clear(
        &self,
        request: SessionGoalClearRequest,
    ) -> Result<SessionAcknowledgment, SessionGoalError> {
        let SessionGoalClearRequest {
            session_id,
            agent_id,
        } = request;
        if let (_row, Some(leg)) = self.reach_lead(session_id, agent_id).await? {
            let driver = self.wake_leg(session_id, &leg).await?;
            let params = ClearSessionGoalParams::new(session_id);
            applied(driver.clear_session_goal(params).await?)?;
        }
        Ok(SessionAcknowledgment { session_id })
    }

    // Checks the session, the agent and that it is the lead, reads the lead's own leg, `None` for a
    // session that never ran, then checks that the provider whose driver carries the goal keeps
    // goals: the leg's, else the row's. Answers the lead's row and the leg. No lock is held past
    // the reads, as a goal sent as a turn opens the binding under the session's own hold.
    async fn reach_lead(
        &self,
        session_id: SessionId,
        agent_id: AgentId,
    ) -> Result<(AgentRow, Option<RuntimeBinding>), SessionGoalError> {
        let row = self.read_agent_of_session(session_id, agent_id).await?;
        let lead: AgentId =
            read_lead_agent_through::<SessionGoalError>(&self.pool, session_id).await?;
        if lead != agent_id {
            return Err(not_the_lead(&row).into());
        }
        let leg = read_agent_leg(&self.pool, session_id, agent_id).await?;
        let provider = leg
            .as_ref()
            .map_or(&row.binding.provider_name, |leg| &leg.provider_name);
        self.providers
            .check_capability(provider, DriverCapabilityFlag::SessionGoals)?;
        Ok((row, leg))
    }

    // Wakes the session where its process sleeps and answers the driver of its leg.
    async fn wake_leg(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
    ) -> Result<Arc<dyn ProviderDriver>, SessionGoalError> {
        self.session_wakes
            .wake_for_message(session_id)
            .await
            .map_err(SessionGoalError::Wake)?;
        Ok(self.providers.lookup(&leg.provider_name)?)
    }

    // The row of `agent_id` in `session_id`, refused `session.notFound` for a session with no row
    // and `agent.notFound` for an agent with no row in it.
    async fn read_agent_of_session(
        &self,
        session_id: SessionId,
        agent_id: AgentId,
    ) -> Result<AgentRow, SessionGoalError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                if !session_exists(reader, &session_id)? {
                    return Err(session_not_found(&session_id).into());
                }
                read_agent_row(reader, &agent_id)?
                    .filter(|row| row.session_id == session_id)
                    .ok_or_else(|| agent_not_found(&agent_id).into())
            })
            .await
    }
}

// Passes a goal change the provider took; one it did not is refused `session.goal.notApplied`.
fn applied(result: DriverGoalResult) -> Result<(), DomainError> {
    match result {
        DriverGoalResult::Applied {} => Ok(()),
        DriverGoalResult::Degraded { fallback_action } => Err(not_applied(fallback_action)),
    }
}

// `session.goal.notApplied`, carrying the provider's words where it gave any.
fn not_applied(
    fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
) -> DomainError {
    let refusal = DomainError::new(
        "The session's provider did not take the goal change.",
        RefusalCode::SessionGoalNotApplied,
    );
    match fallback_action {
        Some(words) => refusal.with_detail(json!({ "fallbackAction": words.as_str() })),
        None => refusal,
    }
}

// `provider.capability.unsupported` for an agent other than the session's lead: every provider
// carries a goal only on the session's own conversation.
fn not_the_lead(row: &AgentRow) -> DomainError {
    let mut refusal = provider_capability_unsupported(
        &row.binding.provider_name,
        DriverCapabilityFlag::SessionGoals,
    );
    refusal
        .detail
        .get_or_insert_default()
        .insert("agentId".to_owned(), json!(row.agent_id));
    refusal
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::goal::{
        SessionGoal, SessionGoalClearRequest, SessionGoalUpdateRequest, SessionGoalUpdateResponse,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
    use sidekicks_provider::driver::test_registry::{
        bind_run_to_first_provider, first_provider, new_agent_id, new_run_id,
        registry_of_first_provider,
    };
    use sidekicks_provider::port::session_wake::SessionWaker;
    use sidekicks_session::agents::projection::test_fixture::{
        binding, project, resolved_run_queued, session_created, write_log_row,
    };
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_session_id,
    };

    use super::{SessionGoalError, SessionGoals};
    use crate::daemon::schema::schema_parts;

    /// The model every agent's binding names.
    const MODEL: &str = "model-a";

    /// The goal every set sends.
    const GOAL: &str = "Ship the release notes";

    // What the waker and the driver were asked, in the order they were asked.
    type Calls = Arc<Mutex<Vec<&'static str>>>;

    // A waker that records each wake and answers at once, as for an awake session.
    struct RecordingWaker(Calls);

    impl SessionWaker for RecordingWaker {
        fn wake_for_message(
            &self,
            _session_id: SessionId,
        ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
            lock(&self.0).push("wake");
            async { Ok(()) }.boxed()
        }
    }

    // A session on the first provider, its lead, a helper of it, and the lead of another session.
    struct Fixture {
        database: TestDatabase,
        session_id: SessionId,
        lead: AgentId,
        helper: AgentId,
        stranger: AgentId,
        calls: Calls,
    }

    impl Fixture {
        // The session after its lead ran once.
        fn new() -> Self {
            let fixture = Self::never_ran();
            let reader = fixture.database.reader();
            // The lead's run, which the session's log names, bound to a conversation.
            let leg_run_id = new_run_id();
            write_log_row(
                &reader,
                fixture.session_id,
                1,
                (
                    SessionEventType::AgentRunQueued,
                    &json!({ "agentId": fixture.lead }),
                ),
                Some(leg_run_id),
                "2026-10-28T09:02:00.000Z",
            );
            let leg_id = bind_run_to_first_provider(&fixture.database, leg_run_id);
            reader
                .execute(
                    "UPDATE runtime_bindings SET resume_handle = 'conversation-1' WHERE id = ?1",
                    [leg_id.as_str()],
                )
                .expect("the test gives the lead's binding a conversation");
            fixture
        }

        // The session before any run, so it has no leg.
        fn never_ran() -> Self {
            let database = TestDatabase::new(schema_parts());
            // The daemon's own open creates the file and its schema, which every later read needs.
            let reader = database.opener()().expect("the test creates its database");
            let agent_binding = binding(PROVIDERS[0].id, MODEL);
            let session_id = test_session_id();
            insert_session_row(&reader, session_id.text().as_str(), None, None);
            let lead = insert_lead(&database, session_id, PROVIDERS[0].id);
            project(
                &reader,
                session_id,
                &session_created(session_id, lead.text().as_str(), &agent_binding),
            );
            let helper = new_agent_id();
            project(
                &reader,
                session_id,
                &resolved_run_queued(
                    session_id,
                    new_run_id().text().as_str(),
                    helper.text().as_str(),
                    &agent_binding,
                ),
            );
            let other_session_id = test_session_id();
            let stranger = new_agent_id();
            project(
                &reader,
                other_session_id,
                &session_created(other_session_id, stranger.text().as_str(), &agent_binding),
            );
            Self {
                database,
                session_id,
                lead,
                helper,
                stranger,
                calls: Calls::default(),
            }
        }

        // The service over `driver`, its provider's snapshot declaring goals as `keeps_goals`.
        fn goals(&self, driver: MockProviderDriver, keeps_goals: bool) -> SessionGoals {
            let providers = registry_of_first_provider(Arc::new(driver));
            providers
                .record_capabilities(
                    &first_provider(),
                    DriverCapabilities {
                        flags: DriverCapabilityFlags::from_fn(|flag| {
                            flag != DriverCapabilityFlag::SessionGoals || keeps_goals
                        }),
                        contract_version: FreeFormText::new("1".to_owned()).expect("valid text"),
                    },
                )
                .expect("the first provider is registered");
            SessionGoals {
                // The statements it prepares: the session, the agent, the lead, the run ids and
                // the leg.
                pool: Arc::new(DatabaseReadPool::new(self.database.path(), 8)),
                providers: Arc::new(providers),
                session_wakes: Arc::new(RecordingWaker(Arc::clone(&self.calls))),
            }
        }

        fn event_count(&self) -> i64 {
            self.database
                .reader()
                .query_row("SELECT COUNT(*) FROM session_events", [], |row| row.get(0))
                .expect("the log counts")
        }

        fn calls(&self) -> Vec<&'static str> {
            lock(&self.calls).clone()
        }
    }

    fn goal() -> SessionGoal {
        SessionGoal {
            text: FreeFormText::new(GOAL.to_owned()).expect("the goal is valid text"),
        }
    }

    fn refusal_code<Output: std::fmt::Debug>(
        outcome: Result<Output, SessionGoalError>,
    ) -> RefusalCode {
        match outcome {
            Err(SessionGoalError::Refused(refusal)) => refusal.code,
            other => panic!("the goal change is refused: {other:?}"),
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum Target {
        UnknownSession,
        OtherSessionsAgent,
        Helper,
        LeadWithoutGoals,
    }

    // Each check refuses before the session is woken or the provider is asked, and appends
    // nothing. Killed by any of the four checks removed or moved after the dispatch.
    #[rstest]
    #[case::unknown_session(Target::UnknownSession, RefusalCode::SessionNotFound)]
    #[case::agent_of_another_session(Target::OtherSessionsAgent, RefusalCode::AgentNotFound)]
    #[case::helper(Target::Helper, RefusalCode::ProviderCapabilityUnsupported)]
    #[case::provider_without_goals(
        Target::LeadWithoutGoals,
        RefusalCode::ProviderCapabilityUnsupported
    )]
    #[tokio::test]
    async fn a_goal_change_the_checks_refuse_reaches_no_provider(
        #[case] target: Target,
        #[case] expected: RefusalCode,
    ) {
        let fixture = Fixture::new();
        let mut driver = MockProviderDriver::new();
        driver.expect_set_session_goal().times(0);
        driver.expect_clear_session_goal().times(0);
        let (session_id, agent_id) = match target {
            Target::UnknownSession => (test_session_id(), fixture.lead),
            Target::OtherSessionsAgent => (fixture.session_id, fixture.stranger),
            Target::Helper => (fixture.session_id, fixture.helper),
            Target::LeadWithoutGoals => (fixture.session_id, fixture.lead),
        };
        let goals = fixture.goals(driver, !matches!(target, Target::LeadWithoutGoals));
        let events_before = fixture.event_count();

        let updated = goals
            .update(SessionGoalUpdateRequest {
                session_id,
                agent_id,
                goal: goal(),
            })
            .await;
        let cleared = goals
            .clear(SessionGoalClearRequest {
                session_id,
                agent_id,
            })
            .await;

        assert_eq!(refusal_code(updated), expected);
        assert_eq!(refusal_code(cleared), expected);
        assert!(fixture.calls().is_empty(), "nothing is woken");
        assert_eq!(fixture.event_count(), events_before);
    }

    // A change the provider did not take is refused with its words, never answered as success.
    // Killed by `Degraded` mapped to the response or the acknowledgment.
    #[tokio::test]
    async fn a_goal_change_the_provider_did_not_take_is_refused_not_applied() {
        let fixture = Fixture::new();
        let degraded = || {
            async {
                Ok(DriverGoalResult::Degraded {
                    fallback_action: Some(
                        FreeFormText::new("the goal was left as it was".to_owned())
                            .expect("valid text"),
                    ),
                })
            }
            .boxed()
        };
        let mut driver = MockProviderDriver::new();
        driver
            .expect_set_session_goal()
            .times(1)
            .returning(move |_| degraded());
        driver
            .expect_clear_session_goal()
            .times(1)
            .returning(move |_| degraded());
        let goals = fixture.goals(driver, true);

        let updated = goals
            .update(SessionGoalUpdateRequest {
                session_id: fixture.session_id,
                agent_id: fixture.lead,
                goal: goal(),
            })
            .await;
        let cleared = goals
            .clear(SessionGoalClearRequest {
                session_id: fixture.session_id,
                agent_id: fixture.lead,
            })
            .await;

        assert_eq!(refusal_code(updated), RefusalCode::SessionGoalNotApplied);
        assert_eq!(refusal_code(cleared), RefusalCode::SessionGoalNotApplied);
    }

    // A set wakes the session before the provider is asked, with the session and the goal as
    // typed, and echoes the goal. Killed by the wake dropped or moved after the dispatch, and by
    // the params built on another session or text.
    #[tokio::test]
    async fn a_goal_set_wakes_the_session_before_the_leg_carries_it() {
        let fixture = Fixture::new();
        let expected = SetSessionGoalParams::new(fixture.session_id, GOAL.to_owned());
        let calls = Arc::clone(&fixture.calls);
        let mut driver = MockProviderDriver::new();
        driver
            .expect_set_session_goal()
            .withf(move |params| *params == expected)
            .times(1)
            .returning(move |_| {
                lock(&calls).push("set");
                async { Ok(DriverGoalResult::Applied {}) }.boxed()
            });
        let goals = fixture.goals(driver, true);

        let updated = goals
            .update(SessionGoalUpdateRequest {
                session_id: fixture.session_id,
                agent_id: fixture.lead,
                goal: goal(),
            })
            .await
            .expect("the provider takes the goal");

        assert_eq!(
            updated,
            SessionGoalUpdateResponse {
                session_id: fixture.session_id,
                goal: goal(),
            }
        );
        assert_eq!(fixture.calls(), ["wake", "set"]);
    }

    // A set on a session that never ran goes once to the lead's own provider, with nothing woken,
    // since that provider opens the session's process for it. Killed by refusing a session with no
    // leg, and by a wake on that path.
    #[tokio::test]
    async fn a_goal_set_on_a_session_that_never_ran_reaches_the_leads_provider_unwoken() {
        let fixture = Fixture::never_ran();
        let expected = SetSessionGoalParams::new(fixture.session_id, GOAL.to_owned());
        let calls = Arc::clone(&fixture.calls);
        let mut driver = MockProviderDriver::new();
        driver
            .expect_set_session_goal()
            .withf(move |params| *params == expected)
            .times(1)
            .returning(move |_| {
                lock(&calls).push("set");
                async { Ok(DriverGoalResult::Applied {}) }.boxed()
            });
        let goals = fixture.goals(driver, true);

        goals
            .update(SessionGoalUpdateRequest {
                session_id: fixture.session_id,
                agent_id: fixture.lead,
                goal: goal(),
            })
            .await
            .expect("the provider takes the goal");

        assert_eq!(fixture.calls(), ["set"]);
    }
}
