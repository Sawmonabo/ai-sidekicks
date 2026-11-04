//! A person's controls on a session's helpers: one helper of a run, named by its handle, is
//! refused by the run it belongs to, then that run's version, then the handle, and acted on through
//! its own run by the service that acts on any run; the stop of every agent a session dispatched
//! sweeps the session's tree and appends one flow row naming the agents it reached.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::children::{
    AgentChildRunControlRefusedDetails, AgentChildRunControlRefusedReason,
    AgentChildRunInterruptRequest, AgentChildRunInterruptResponse, AgentChildRunStopAllRequest,
    AgentChildRunStopAllResponse, ChildStopOutcome,
};
use sidekicks_contracts::run::events::{AgentChildrenStoppedPayload, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};

use crate::agent_tree::read::{AgentTreeReadError, resolve_child};
use crate::agent_tree::sweep::{AgentTreeSweep, AgentTreeSweepError, SweepRoot};
use crate::driver_resolution::read_session_provider;
use crate::interventions::service::InterventionService;
use crate::interventions::service::errors::InterventionError;
use crate::run::read::{RunStateReader, safe_run_version};
use crate::run::refusals::{RunRefusal, require_expected_version};

/// Why a child control was not answered.
#[derive(Debug, thiserror::Error)]
pub enum ChildRunControlError {
    /// The run the child belongs to is unknown or past the version the caller read
    /// (`agent.run.notFound`, `agent.run.versionStale`).
    #[error(transparent)]
    Run(#[from] RunRefusal),
    /// The handle names no child of the run (`agent.childRun.notFound`).
    #[error("the run holds no child with this handle")]
    ChildNotFound {
        /// The handle asked for.
        child_handle: ChildHandle,
    },
    /// The provider did not carry the act out (`agent.childRun.controlRefused`).
    #[error("the child's provider did not carry the control out")]
    Refused {
        /// Why.
        reason: AgentChildRunControlRefusedReason,
    },
    /// The intervention on the child's own run refused or failed, answered as it answers.
    #[error(transparent)]
    Intervention(#[from] InterventionError),
    /// The session is not one this daemon holds (`session.notFound`).
    #[error("this daemon holds no such session")]
    SessionNotFound {
        /// The session asked for.
        session_id: SessionId,
    },
    /// No driver answers the provider the session's lead runs on.
    #[error("no driver answers the provider of the session's lead")]
    LeadProvider(#[source] DomainError),
    /// The session's agents could not be read, so none was stopped.
    #[error(transparent)]
    Sweep(#[from] AgentTreeSweepError),
    /// The stop's flow row was not drafted or not kept.
    #[error("the flow row of the stop was not appended")]
    Row(#[from] SessionEventEmitError),
    /// The child's node or its own run could not be read.
    #[error(transparent)]
    Tree(#[from] AgentTreeReadError),
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("reading the run or its child failed")]
    Read(#[from] rusqlite::Error),
    /// A read did not reach a connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<ChildRunControlError> for HandlerError {
    /// A refusal answers by its code, the intervention's as it answers them (an unknown queue item
    /// among them); a failed read, a missing driver, a failed sweep and a lost row are faults in
    /// the daemon.
    fn from(error: ChildRunControlError) -> Self {
        match error {
            ChildRunControlError::Run(refusal) => Self::Refused(refusal.into()),
            ChildRunControlError::ChildNotFound { child_handle } => Self::Refused(
                DomainError::new(
                    "The run holds no child with this handle",
                    RefusalCode::AgentChildRunNotFound,
                )
                .with_detail(json!({ "childHandle": child_handle })),
            ),
            ChildRunControlError::Refused { reason } => Self::Refused(
                DomainError::new(
                    "The child's provider did not carry the control out",
                    RefusalCode::AgentChildRunControlRefused,
                )
                .with_detail(AgentChildRunControlRefusedDetails { reason }),
            ),
            ChildRunControlError::Intervention(error) => error.into(),
            ChildRunControlError::SessionNotFound { session_id } => {
                Self::Refused(session_not_found(&session_id))
            }
            fault @ (ChildRunControlError::LeadProvider(_)
            | ChildRunControlError::Sweep(_)
            | ChildRunControlError::Row(_)
            | ChildRunControlError::Tree(_)
            | ChildRunControlError::Read(_)
            | ChildRunControlError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// A person's controls on a session's helpers. Cloning the interventions service shares its
/// locks, so the child's own run takes its interrupts in turn with every other one.
pub struct ChildRunControls {
    // The read pool every read of a control borrows a connection from.
    pool: Arc<DatabaseReadPool>,
    // Interrupts the child's own run.
    interventions: InterventionService,
    // Stops every agent a session dispatched.
    sweep: AgentTreeSweep,
    // The registered drivers, whose descriptor gives the stop's flow row its word.
    providers: Arc<ProviderRegistry>,
    // The session's log, which takes the stop's flow row.
    appender: Arc<SessionEventAppender>,
    // Where a damaged session's reads stop.
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

// Where the child stood when the control read it.
enum ChildStanding {
    // Ended, in this state.
    Ended(RunState),
    // Live: its own run at this version.
    Live { own_run_id: RunId, own_version: i64 },
}

impl ChildRunControls {
    /// Controls reading through `pool` up to where `read_damaged_from_sequence` stops a damaged
    /// session, interrupting through `interventions`, stopping helpers through `providers`'
    /// drivers and appending through `appender`; the sweep is built from the same parts.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        providers: Arc<ProviderRegistry>,
        interventions: InterventionService,
        appender: Arc<SessionEventAppender>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Self {
        let sweep = AgentTreeSweep::new(
            Arc::clone(&pool),
            Arc::clone(&providers),
            interventions.clone(),
            Arc::clone(&appender),
        );
        Self {
            pool,
            interventions,
            sweep,
            providers,
            appender,
            read_damaged_from_sequence,
        }
    }

    /// Interrupts the child `request` names, and only it: its pending messages go as its next
    /// turn, `deliver_first` ahead of the rest. A child that had ended answers the state it ended
    /// in, with nothing sent. Refuses `agent.run.notFound`, `agent.run.versionStale` for the run
    /// it belongs to, `agent.childRun.notFound` for a handle that names no child of that run, and
    /// `agent.childRun.controlRefused` (`providerRefused`) when the provider did not confirm the
    /// interrupt; the intervention's own refusals pass through.
    pub async fn interrupt(
        &self,
        request: AgentChildRunInterruptRequest,
        actor: InterventionActor,
    ) -> Result<AgentChildRunInterruptResponse, ChildRunControlError> {
        let AgentChildRunInterruptRequest {
            target_run_id,
            child_handle,
            expected_run_version,
            client_idempotency_key,
            deliver_first,
        } = request;
        let read_handle = child_handle.clone();
        let standing = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let runs = RunStateReader::new(reader);
                let run = runs.read_run(&target_run_id)?.ok_or(RunRefusal::NotFound {
                    run_id: target_run_id,
                })?;
                require_expected_version(target_run_id, &run, expected_run_version)?;
                let child = resolve_child(reader, &run.session_id, &read_handle)?
                    .filter(|child| child.parent_run_id == target_run_id)
                    .ok_or(ChildRunControlError::ChildNotFound {
                        child_handle: read_handle,
                    })?;
                if child.state.is_terminal() {
                    return Ok(ChildStanding::Ended(child.state));
                }
                let own_run_id = child.node.own_run_id;
                let own_run = runs
                    .read_run(&own_run_id)?
                    .ok_or(AgentTreeReadError::RunMissing { run_id: own_run_id })?;
                Ok::<_, ChildRunControlError>(ChildStanding::Live {
                    own_run_id,
                    own_version: own_run.version,
                })
            })
            .await?;
        let (own_run_id, own_version) = match standing {
            ChildStanding::Ended(state) => {
                return Ok(AgentChildRunInterruptResponse {
                    child_handle,
                    state,
                });
            }
            ChildStanding::Live {
                own_run_id,
                own_version,
            } => (own_run_id, own_version),
        };
        let answer = self
            .interventions
            .apply_intervention(
                AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
                    target_run_id: own_run_id,
                    expected_run_version: safe_run_version(own_version),
                    client_idempotency_key,
                    reason: None,
                    deliver_first,
                }),
                actor,
            )
            .await?;
        let provider_refused = ChildRunControlError::Refused {
            reason: AgentChildRunControlRefusedReason::ProviderRefused,
        };
        match answer {
            AgentRunInterveneResponse::Applied { .. }
            | AgentRunInterveneResponse::Degraded { .. } => {
                let state = self.own_run_state(own_run_id).await?;
                Ok(AgentChildRunInterruptResponse {
                    child_handle,
                    state,
                })
            }
            // Refused or outdated: a child that ended meanwhile answers its end.
            AgentRunInterveneResponse::Rejected { .. }
            | AgentRunInterveneResponse::Expired { .. } => {
                let state = self.own_run_state(own_run_id).await?;
                if state.is_terminal() {
                    Ok(AgentChildRunInterruptResponse {
                        child_handle,
                        state,
                    })
                } else {
                    Err(provider_refused)
                }
            }
            // The provider got it with no answer back, or its dispatch failed, so it is never
            // answered as interrupted.
            AgentRunInterveneResponse::Requested { .. }
            | AgentRunInterveneResponse::Accepted { .. }
            | AgentRunInterveneResponse::Failed { .. } => Err(provider_refused),
        }
    }

    /// Stops every live or interrupted agent the session `request` names dispatched, at every
    /// depth, a helper an earlier lead run left running included, each stop from `actor`; then
    /// appends one `agent.children.stopped` whose word is the lead's provider's and whose names
    /// are the agents stopped, in dispatch order. Answers each agent's own outcome in dispatch
    /// order. Refuses `session.notFound` before anything is stopped; fails when the agents cannot
    /// be read or the row is not kept.
    pub async fn stop_all(
        &self,
        request: AgentChildRunStopAllRequest,
        actor: InterventionActor,
    ) -> Result<AgentChildRunStopAllResponse, ChildRunControlError> {
        let session_id = request.session_id;
        let (provider, _) = read_session_provider::<ChildRunControlError>(
            &self.pool,
            &*self.read_damaged_from_sequence,
            session_id,
        )
        .await?
        .ok_or(ChildRunControlError::SessionNotFound { session_id })?;
        let word = self
            .providers
            .descriptor(&provider)
            .map_err(ChildRunControlError::LeadProvider)?
            .stop_all_row_word;
        let read_bound = session_read_bound(&*self.read_damaged_from_sequence, &session_id, None);
        let children = self
            .sweep
            .stop_descendants(session_id, SweepRoot::Session, None, read_bound, actor)
            .await?;
        // A failed stop carries its failure on its own row, so only the stopped are named.
        let reached = children
            .iter()
            .filter_map(|outcome| match outcome {
                ChildStopOutcome::Stopped { child, .. } => Some(child.clone()),
                ChildStopOutcome::AlreadyEnded { .. } | ChildStopOutcome::Failed { .. } => None,
            })
            .collect();
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::AgentChildrenStopped(AgentChildrenStoppedPayload { word, reached }),
        )
        .map_err(SessionEventEmitError::from)?;
        self.appender
            .append(draft, SessionEventLinkage::default())
            .await
            .map_err(SessionEventEmitError::from)?;
        Ok(AgentChildRunStopAllResponse { children })
    }

    // The state of the child's own run `own_run_id` as it stands now.
    async fn own_run_state(&self, own_run_id: RunId) -> Result<RunState, ChildRunControlError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let own_run = RunStateReader::new(reader)
                    .read_run(&own_run_id)?
                    .ok_or(AgentTreeReadError::RunMissing { run_id: own_run_id })?;
                Ok::<_, ChildRunControlError>(own_run.state)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use std::path::PathBuf;

    use futures::FutureExt as _;
    use rstest::rstest;
    use rusqlite::params;
    use serde_json::Value;
    use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::children::{
        AgentChildRunInterruptRequest, AgentChildRunStopAllRequest, ChildStoppedState,
    };
    use sidekicks_contracts::run::events::{
        AgentChildrenStoppedPayload, InterventionActor, InterventionDeviceActor,
    };
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queued::ChildRunProvenance;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::error_causes::unanswered;
    use sidekicks_provider::driver::registry::ProviderRegistry;
    use sidekicks_provider::driver::run_control::HelperStopOutcome;
    use sidekicks_provider::driver::test_registry::{
        registry_of_first_provider, registry_of_first_providers,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_fixture::open_log;
    use sidekicks_store::events::session::appender::SessionEventAppender;
    use sidekicks_store::events::session::read::DamagedFromSequenceReader;
    use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

    use super::{ChildRunControlError, ChildRunControls};
    use crate::agent_tree::read::AGENT_TREE_READ_STATEMENT_CAPACITY;
    use crate::agent_tree::read::tests::{HELPER_PROVIDER, SessionLog, at};
    use crate::agent_tree::store::{NewAgentTreeNode, insert_node, mint_child_handle};
    use crate::agents::projection::test_fixture::{binding, run_statements, session_created};
    use crate::interventions::service::tests::{Harness, applied, harness};
    use crate::run::engine::test_fixture::insert_running_run;

    // Controls reading the database at `path`, a whole session's log readable, acting through
    // `harness`'s interventions service and `providers`' drivers, and appending to `database`'s
    // log.
    async fn controls(
        path: PathBuf,
        database: &TestDatabase,
        harness: &Harness,
        providers: ProviderRegistry,
    ) -> ChildRunControls {
        let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
            Arc::new(|_: &SessionId| None);
        ChildRunControls::new(
            Arc::new(DatabaseReadPool::new(
                path,
                AGENT_TREE_READ_STATEMENT_CAPACITY,
            )),
            Arc::new(providers),
            (*harness.service).clone(),
            Arc::new(SessionEventAppender::new(
                open_log(database, None).await.service,
                SESSION_EVENT_VERSION.clone(),
            )),
            read_damaged_from_sequence,
        )
    }

    /// The harness's run as the own run of a helper of a running parent run, at the parent's
    /// version 1, with a second running run of the session that holds no child.
    struct ChildOfARun {
        harness: Harness,
        controls: ChildRunControls,
        parent_run_id: RunId,
        other_run_id: RunId,
        child_handle: ChildHandle,
    }

    async fn child_of_a_run(driver: MockProviderDriver, child_state: &str) -> ChildOfARun {
        let harness = harness(driver).await;
        let parent_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let other_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&harness.database, harness.session_id, parent_run_id);
        insert_running_run(&harness.database, harness.session_id, other_run_id);
        harness
            .database
            .reader()
            .execute(
                "UPDATE runs SET parent_run_id = ?2, reached_by = ?3 WHERE run_id = ?1",
                params![
                    harness.run_id.text().as_str(),
                    parent_run_id.text().as_str(),
                    <&'static str>::from(ChildRunProvenance::ProviderSubagent),
                ],
            )
            .expect("the test hangs the child's own run under its parent");
        harness.set_run(child_state, 1);
        let child_handle = mint_child_handle();
        run_statements(
            &harness.database.reader(),
            &[insert_node(&NewAgentTreeNode {
                child_handle: child_handle.clone(),
                session_id: harness.session_id,
                provider_name: ProviderId::new(HELPER_PROVIDER.to_owned()).expect("a provider id"),
                subagent_id: "helper-1".to_owned(),
                parent_subagent_id: None,
                parent_child_handle: None,
                name: None,
                role: None,
                provider_path: None,
                start_call_id: None,
                own_run_id: harness.run_id,
                started_at: WireInstant::now(),
            })],
        );
        let controls = controls(
            harness.database.path(),
            &harness.database,
            &harness,
            registry_of_first_provider(Arc::new(MockProviderDriver::new())),
        )
        .await;
        ChildOfARun {
            harness,
            controls,
            parent_run_id,
            other_run_id,
            child_handle,
        }
    }

    impl ChildOfARun {
        // Interrupts the child named under `target_run_id`, which the caller read at `version`.
        async fn interrupt(
            &self,
            target_run_id: RunId,
            version: u64,
        ) -> Result<RunState, ChildRunControlError> {
            let actor = InterventionDeviceActor::new(
                DeviceId::new("device-1".to_owned()).expect("a test device id"),
            )
            .expect("a device that is not the daemon");
            self.controls
                .interrupt(
                    AgentChildRunInterruptRequest {
                        target_run_id,
                        child_handle: self.child_handle.clone(),
                        expected_run_version: SafeInt::new(version).expect("a test version"),
                        client_idempotency_key: ClientUuid::new(
                            "0b7f3c1e-9a52-4d6b-8e21-5f4c7d9a1b30".to_owned(),
                        )
                        .expect("a test key is a UUID"),
                        deliver_first: None,
                    },
                    InterventionActor::Device(actor),
                )
                .await
                .map(|response| {
                    assert_eq!(response.child_handle, self.child_handle);
                    response.state
                })
        }
    }

    fn refusal_code(error: ChildRunControlError) -> RefusalCode {
        match HandlerError::from(error) {
            HandlerError::Refused(refusal) => refusal.code,
            other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                panic!("expected a refusal, got {other:?}")
            }
        }
    }

    // A handle the target run holds no child under, and a stale version of the run the child
    // belongs to, are each refused before anything is sent: the driver has no expectation, so a
    // dispatch fails the test, and no intervention row is written. Killed by dropping the parent
    // check or the version check.
    #[rstest]
    #[case::a_child_of_another_run(false, 1, RefusalCode::AgentChildRunNotFound)]
    #[case::a_stale_parent_version(true, 2, RefusalCode::AgentRunVersionStale)]
    #[tokio::test]
    async fn a_child_control_refuses_the_wrong_parent_and_a_stale_version(
        #[case] is_own_parent: bool,
        #[case] version: u64,
        #[case] code: RefusalCode,
    ) {
        let child = child_of_a_run(MockProviderDriver::new(), "running").await;
        let target = if is_own_parent {
            child.parent_run_id
        } else {
            child.other_run_id
        };

        let error = child
            .interrupt(target, version)
            .await
            .expect_err("the control is refused");

        assert_eq!(refusal_code(error), code);
        assert_eq!(
            child.harness.stored_rows(),
            Vec::<(String, String, Option<String>)>::new()
        );
    }

    // A running child whose driver confirms the interrupt answers `interrupted`; one whose driver
    // got it with no answer back is refused `providerRefused`, never answered as interrupted.
    // Killed by answering an unconfirmed interrupt with the child's state.
    #[rstest]
    #[case::confirmed(true)]
    #[case::unanswered(false)]
    #[tokio::test]
    async fn an_interrupt_answers_interrupted_only_when_the_provider_confirms_it(
        #[case] is_confirmed: bool,
    ) {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_apply_intervention()
            .times(1)
            .returning(move |_| {
                async move {
                    if is_confirmed {
                        Ok(applied())
                    } else {
                        Err(unanswered())
                    }
                }
                .boxed()
            });
        let child = child_of_a_run(driver, "running").await;

        let answer = child.interrupt(child.parent_run_id, 1).await;

        if is_confirmed {
            assert_eq!(
                answer.expect("the interrupt is answered"),
                RunState::Interrupted
            );
        } else {
            let error = answer.expect_err("an unconfirmed interrupt is refused");
            assert!(
                matches!(
                    error,
                    ChildRunControlError::Refused {
                        reason: super::AgentChildRunControlRefusedReason::ProviderRefused
                    }
                ),
                "{error:?}"
            );
            assert_eq!(
                refusal_code(error),
                RefusalCode::AgentChildRunControlRefused
            );
        }
    }

    // A child that had already completed answers `completed`, and nothing is sent: the driver has
    // no expectation and no intervention row is written. Killed by interrupting an ended child.
    #[tokio::test]
    async fn an_ended_child_answers_its_end_with_nothing_sent() {
        let child = child_of_a_run(MockProviderDriver::new(), "completed").await;

        let state = child
            .interrupt(child.parent_run_id, 1)
            .await
            .expect("an ended child answers its state");

        assert_eq!(state, RunState::Completed);
        assert_eq!(
            child.harness.stored_rows(),
            Vec::<(String, String, Option<String>)>::new()
        );
    }

    // A stop of every agent a session dispatched, on a session whose lead runs on the table's
    // provider at `lead_place`: of four helpers, each driver stop answering the other word, one
    // already ended and one refused, the row names the two stopped in dispatch order under the
    // lead's word, and the answer keeps every outcome in that order. Killed by a row built from
    // every outcome, by one cut at the first failure, and by a word taken from the children.
    #[rstest]
    #[case::stopped_for_good(0, ChildStoppedState::Stopped)]
    #[case::interrupted(1, ChildStoppedState::Interrupted)]
    #[tokio::test]
    async fn the_stop_all_row_names_the_stopped_in_dispatch_order_under_the_leads_word(
        #[case] lead_place: usize,
        #[case] word: ChildStoppedState,
    ) {
        let other_word = match word {
            ChildStoppedState::Stopped => HelperStopOutcome::Interrupted,
            ChildStoppedState::Interrupted => HelperStopOutcome::Stopped,
        };
        let answers = [
            ("helper-first", Some(other_word)),
            ("helper-ended", Some(HelperStopOutcome::AlreadyEnded)),
            ("helper-refused", None),
            ("helper-last", Some(other_word)),
        ];
        let harness = harness(MockProviderDriver::new()).await;
        let mut log = SessionLog::new();
        let lead = log.lead;
        let lead_provider = PROVIDERS[lead_place].id;
        let created = serde_json::to_value(session_created(
            log.session_id,
            lead.text().as_str(),
            &binding(lead_provider, "model-lead"),
        ))
        .expect("the session's birth writes");
        log.event(
            SessionEventType::SessionCreated,
            &created["payload"],
            None,
            &at(0),
        );
        let lead_run = log.run(None, RunState::Running, lead, &at(0));
        let mut handles = Vec::new();
        for (place, (subagent_id, _)) in (1_u32..).zip(answers) {
            let own_run = log.own_run(lead_run, subagent_id, RunState::Running, &at(place));
            handles.push(log.node(own_run, subagent_id, None, &at(place)));
        }
        log.connection
            .execute(
                "UPDATE agent_tree_nodes SET provider_name = ?1",
                [lead_provider],
            )
            .expect("the test names the helpers' provider");
        let mut helper_driver = MockProviderDriver::new();
        helper_driver
            .expect_stop_child_run()
            .times(answers.len())
            .returning(move |params| {
                let (_, answer) = answers
                    .into_iter()
                    .find(|(subagent_id, _)| *subagent_id == params.subagent_id.as_str())
                    .expect("each stop names a test helper");
                async move {
                    answer.ok_or_else(|| {
                        DriverError::from(DomainError::new(
                            "the provider is not running",
                            RefusalCode::ProviderUnavailable,
                        ))
                    })
                }
                .boxed()
            });
        let mut drivers: Vec<Arc<dyn ProviderDriver>> = vec![
            Arc::new(MockProviderDriver::new()),
            Arc::new(MockProviderDriver::new()),
        ];
        drivers[lead_place] = Arc::new(helper_driver);
        let path = PathBuf::from(
            log.connection
                .path()
                .expect("the test's database is a file"),
        );
        let controls = controls(
            path,
            &log.database,
            &harness,
            registry_of_first_providers(drivers),
        )
        .await;
        let actor = InterventionDeviceActor::new(
            DeviceId::new("device-1".to_owned()).expect("a test device id"),
        )
        .expect("a device that is not the daemon");

        let answer = controls
            .stop_all(
                AgentChildRunStopAllRequest {
                    session_id: log.session_id,
                },
                InterventionActor::Device(actor),
            )
            .await
            .expect("the stop is answered");

        let child = |place: usize| AgentTreeMember::ProviderChild {
            run_id: lead_run,
            child_handle: handles[place].clone(),
        };
        let answered: Vec<AgentTreeMember> = answer
            .children
            .into_iter()
            .map(|outcome| match outcome {
                super::ChildStopOutcome::Stopped { child, .. }
                | super::ChildStopOutcome::AlreadyEnded { child, .. }
                | super::ChildStopOutcome::Failed { child, .. } => child,
            })
            .collect();
        assert_eq!(answered, (0..answers.len()).map(child).collect::<Vec<_>>());
        let rows: Vec<Value> = log
            .connection
            .prepare("SELECT payload FROM session_events WHERE type = ?1")
            .expect("the test prepares its read")
            .query_map([SessionEventType::AgentChildrenStopped.as_str()], |row| {
                row.get::<_, String>(0)
            })
            .expect("the test reads the log")
            .map(|payload| {
                serde_json::from_str(&payload.expect("each row reads")).expect("a JSON payload")
            })
            .collect();
        assert_eq!(
            rows,
            [serde_json::to_value(AgentChildrenStoppedPayload {
                word,
                reached: vec![child(0), child(3)],
            })
            .expect("the payload writes")]
        );
    }
}
