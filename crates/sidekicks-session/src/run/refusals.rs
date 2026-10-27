//! The run engine's refusals, each sent on the wire by its code.

use std::error::Error;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::run::read::RunRead;
use sidekicks_ipc::domain_error::DomainError;

/// Why the run engine refused a call or a move; nothing was written for any of them.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunRefusal {
    /// A run id the daemon holds no run for (`agent.run.notFound`).
    #[error("Run does not exist or is not accessible")]
    NotFound {
        /// The run asked for.
        run_id: RunId,
    },
    /// An `agent.run.pause` or `agent.run.resume` whose expected version is not the run's current
    /// one, older or newer (`agent.run.versionStale`); the run is as it was.
    #[error("The run's version is not the one the call expected")]
    VersionStale {
        /// The run asked for.
        run_id: RunId,
        /// The version the call expected, as the call carried it.
        expected_run_version: u64,
        /// The run's current version, as the store holds it.
        run_version: i64,
        /// The guard that found the version moved inside the write, when one did.
        #[source]
        source: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A move the run's current state does not allow (`agent.run.invalidTransition`).
    #[error(
        "A run in {} cannot move to {}",
        <&'static str>::from(*.from_state),
        <&'static str>::from(RunState::from(*.to_state))
    )]
    InvalidTransition {
        /// The run that would have moved.
        run_id: RunId,
        /// The state it was in.
        from_state: RunState,
        /// The state the move asked for.
        to_state: RunStateChangeState,
        /// The failure that found the move refused, when one did.
        #[source]
        source: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A terminal refused because the run had already ended, by the time it was read or inside the
    /// write itself (`agent.run.invalidTransition`); a late terminal from the provider meets this.
    #[error(
        "A run in {} cannot move to {}",
        <&'static str>::from(*.from_state),
        <&'static str>::from(RunState::from(*.to_state))
    )]
    AlreadyEnded {
        /// The run that would have moved.
        run_id: RunId,
        /// The state it ended in.
        from_state: RunState,
        /// The terminal state the move asked for.
        to_state: RunStateChangeState,
        /// The guard that found the end inside the write, when one did.
        #[source]
        source: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A turn the daemon or the provider would start on a session whose next turn is held for
    /// another run: the continue of its interrupted lead run with the messages waiting for it, or
    /// a lead run that has not ended (`provider.unavailable`, `sessionTurnInFlight`, as a driver
    /// refuses a turn the daemon starts while another holds the session).
    #[error("The session's next turn is held for another of its runs, so this turn waits")]
    SessionTurnHeld {
        /// The session whose turn is held.
        session_id: SessionId,
        /// The guard that found the turn held.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}

/// The refusal of a provider's move of `run_id` to `to_state` once the run has ended in
/// `ended_state`: [`RunRefusal::AlreadyEnded`] for a terminal, else
/// [`RunRefusal::InvalidTransition`].
pub(crate) fn ended_run_refusal(
    run_id: RunId,
    to_state: RunStateChangeState,
    ended_state: RunState,
) -> RunRefusal {
    if RunState::from(to_state).is_terminal() {
        RunRefusal::AlreadyEnded {
            run_id,
            from_state: ended_state,
            to_state,
            source: None,
        }
    } else {
        RunRefusal::InvalidTransition {
            run_id,
            from_state: ended_state,
            to_state,
            source: None,
        }
    }
}

/// Refuses `run`, read as `run_id`, with [`RunRefusal::VersionStale`] unless it is at the version
/// the caller read, `expected_run_version`: an older one, or one no honest caller can hold yet.
pub(crate) fn require_expected_version(
    run_id: RunId,
    run: &RunRead,
    expected_run_version: SafeInt<0>,
) -> Result<(), RunRefusal> {
    if run.version == i64::from(expected_run_version) {
        return Ok(());
    }
    Err(RunRefusal::VersionStale {
        run_id,
        expected_run_version: expected_run_version.get(),
        run_version: run.version,
        source: None,
    })
}

impl From<RunRefusal> for DomainError {
    fn from(refusal: RunRefusal) -> Self {
        let message = refusal.to_string();
        match refusal {
            RunRefusal::NotFound { run_id } => {
                DomainError::new(message, RefusalCode::AgentRunNotFound)
                    .with_detail(json!({ "runId": run_id }))
            }
            RunRefusal::VersionStale {
                run_id,
                expected_run_version,
                run_version,
                source,
            } => DomainError::new(message, RefusalCode::AgentRunVersionStale)
                .with_detail(json!({
                    "runId": run_id,
                    "expectedRunVersion": expected_run_version,
                    "runVersion": run_version,
                }))
                .with_optional_source(source),
            RunRefusal::InvalidTransition {
                run_id,
                from_state,
                to_state,
                source,
            }
            | RunRefusal::AlreadyEnded {
                run_id,
                from_state,
                to_state,
                source,
            } => transition_refusal(message, &run_id, from_state, to_state)
                .with_optional_source(source),
            RunRefusal::SessionTurnHeld { session_id, source } => {
                DomainError::new(message, RefusalCode::ProviderUnavailable)
                    .with_detail(json!({
                        "sessionId": session_id,
                        "reason": "sessionTurnInFlight",
                    }))
                    .with_source(source)
            }
        }
    }
}

// `agent.run.invalidTransition` with the run and both states as its detail, which both transition
// refusals send.
fn transition_refusal(
    message: String,
    run_id: &RunId,
    from_state: RunState,
    to_state: RunStateChangeState,
) -> DomainError {
    DomainError::new(message, RefusalCode::AgentRunInvalidTransition).with_detail(json!({
        "runId": run_id,
        "fromState": <&'static str>::from(from_state),
        "toState": <&'static str>::from(RunState::from(to_state)),
    }))
}
