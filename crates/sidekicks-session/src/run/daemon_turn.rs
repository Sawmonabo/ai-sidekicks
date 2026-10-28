//! The queued run of a turn the daemon or its provider starts on a session as the session's own
//! run. A session has one live lead run, so such a run is queued only while none is live, and a
//! turn the daemon starts also waits while a lead message waits for the session's interrupted lead
//! run, whose continue is the session's next turn. A turn in a process of its own takes no turn of
//! the session's, so its run is no lead run and waits for neither.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::start_request::DaemonTurnStartRequest;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use crate::queue_store::{no_continue_waiting_statement, no_live_lead_run_statement};
use crate::run::projection::insert_queued_run_statement;
use crate::run::refusals::RunRefusal;
use crate::run::state_change::refused_statement_index;

/// Why a daemon turn's run was not queued; nothing was written.
#[derive(Debug, thiserror::Error)]
pub enum DaemonTurnQueueError {
    /// The session's next turn is held for another of its runs
    /// ([`RunRefusal::SessionTurnHeld`]).
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// The run's creation could not be drafted or appended.
    #[error("the daemon turn's run was not queued")]
    Emit(#[from] SessionEventEmitError),
}

/// Writes `agent.run.queued` for a daemon turn's run under a new id, naming the session's lead
/// `agent_id` and no parent, and returns that id. Fails with [`RunRefusal::SessionTurnHeld`],
/// writing nothing, while a lead run of the session is live, and for a turn the daemon starts while
/// a lead message waits for the session's interrupted lead run.
pub(crate) async fn queue_daemon_turn_run(
    appender: &SessionEventAppender,
    request: &DaemonTurnStartRequest,
    agent_id: AgentId,
) -> Result<RunId, DaemonTurnQueueError> {
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
        session_id: request.session_id,
        run_id,
        run_version: SafeInt::ZERO,
        new_state: AgentRunQueuedNewState::Value,
        agent_id,
        resolved_agent: None,
        parent_run_id: None,
        reached_by: None,
        effective_run_config: None,
        admitted_model_family: None,
        admitted_provider_account_id: request.admitted_provider_account_id.clone(),
    });
    let mut guards = vec![no_live_lead_run_statement(&request.session_id)];
    if !request.is_provider_started {
        guards.push(no_continue_waiting_statement(&request.session_id));
    }
    let guard_count = guards.len();
    let mut transactional_prelude = guards;
    transactional_prelude.push(insert_queued_run_statement(&queued));
    let draft =
        SessionEventDraft::of_session(request.session_id, &SessionEvent::AgentRunQueued(queued))
            .map_err(SessionEventEmitError::from)?;
    match appender
        .append(
            draft,
            SessionEventLinkage {
                transactional_prelude,
                ..SessionEventLinkage::default()
            },
        )
        .await
    {
        Ok(_receipt) => Ok(run_id),
        Err(error) if refused_statement_index(&error).is_some_and(|index| index < guard_count) => {
            Err(RunRefusal::SessionTurnHeld {
                session_id: request.session_id,
                source: Box::new(error),
            }
            .into())
        }
        Err(error) => Err(SessionEventEmitError::from(error).into()),
    }
}
