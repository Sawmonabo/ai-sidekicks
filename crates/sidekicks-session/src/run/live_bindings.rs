//! A run's live binding: the newest binding row of a run that has not ended, which names the driver
//! a run-addressed handler acts through and the binding a run-addressed driver call names; and an
//! agent's live bindings, one per binding its live runs run under. A run keeps every binding it
//! had, so the older rows are the ones a resume or a rewind replaced.

use rusqlite::Connection;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::runtime_binding::store::{RuntimeBinding, read_binding, read_run_bindings};

use crate::run::agent::is_agent_named;
use crate::run::read::{RunStateReader, read_run_provider, read_session_live_runs};

/// The statements live-binding reads prepare on a read connection: the run's row and its
/// bindings, and for an agent's bindings the session's live runs, each run's provider, a binding
/// and whether the log names the agent.
pub const LIVE_RUN_BINDINGS_STATEMENT_CAPACITY: usize = 6;

/// One run's live binding as the addressed session sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunBindingResolution {
    /// No run of the addressed session answers to the id.
    UnknownRun {},
    /// The run has ended, or has no binding yet.
    NoLiveBinding {},
    /// The run's live binding.
    Bound {
        /// The provider the binding runs on.
        provider_name: ProviderId,
        /// The binding.
        binding_id: RuntimeBindingId,
    },
}

/// `run_id`'s live binding, read on `reader`, answering a run of another session as an unknown
/// one. Fails as the reads do.
pub fn resolve_run_binding(
    reader: &Connection,
    session_id: &SessionId,
    run_id: &RunId,
) -> rusqlite::Result<RunBindingResolution> {
    let Some(run) = RunStateReader::new(reader).read_run(run_id)? else {
        return Ok(RunBindingResolution::UnknownRun {});
    };
    if run.session_id != *session_id {
        return Ok(RunBindingResolution::UnknownRun {});
    }
    if run.state.is_terminal() {
        return Ok(RunBindingResolution::NoLiveBinding {});
    }
    Ok(match newest_binding(reader, run_id)? {
        Some(binding) => RunBindingResolution::Bound {
            provider_name: binding.provider_name,
            binding_id: binding.id,
        },
        None => RunBindingResolution::NoLiveBinding {},
    })
}

// The run's newest binding row; the rows read in the order they were written.
fn newest_binding(reader: &Connection, run_id: &RunId) -> rusqlite::Result<Option<RuntimeBinding>> {
    Ok(read_run_bindings(reader, run_id)?.pop())
}

/// One binding an agent's live runs run under: the provider and account it runs on, and its one
/// live run of the agent, `None` when several are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentBinding {
    /// The binding.
    pub binding_id: RuntimeBindingId,
    /// The provider it runs on.
    pub provider_name: ProviderId,
    /// The account its run was admitted against; `None` when it bound none.
    pub provider_account_id: Option<ProviderAccountId>,
    /// The one live run of the agent on the binding; `None` when several are live.
    pub run_id: Option<RunId>,
}

/// An agent's live bindings as the addressed session sees them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentBindingResolution {
    /// The session's log names no such agent.
    UnknownAgent {},
    /// The agent has no live run on a binding.
    NoLiveBinding {},
    /// Each binding its live runs run under, in the order its runs were written.
    Bound(Vec<AgentBinding>),
}

/// `agent_id`'s live bindings in `session_id`, read on `reader` with the log read before
/// `read_bound`: each live run of the agent under its own binding, or a provider subagent's under
/// its parent's, grouped by binding. Fails as the reads do.
pub fn resolve_agent_bindings(
    reader: &Connection,
    session_id: &SessionId,
    agent_id: &AgentId,
    read_bound: i64,
) -> rusqlite::Result<AgentBindingResolution> {
    let mut bindings: Vec<AgentBinding> = Vec::new();
    let mut has_live_run = false;
    for live_run in read_session_live_runs(reader, session_id, read_bound)? {
        if live_run.agent_id.as_ref() != Some(agent_id) {
            continue;
        }
        has_live_run = true;
        let Some(bound) = read_run_provider(reader, &live_run.run_id)? else {
            continue;
        };
        if let Some(shared) = bindings
            .iter_mut()
            .find(|binding| binding.binding_id == bound.binding_id)
        {
            shared.run_id = None;
            continue;
        }
        let provider_account_id = read_binding(reader, &bound.binding_id)?
            .and_then(|binding| binding.spawn_config.provider_account_id);
        bindings.push(AgentBinding {
            binding_id: bound.binding_id,
            provider_name: bound.provider,
            provider_account_id,
            run_id: Some(live_run.run_id),
        });
    }
    if !bindings.is_empty() {
        return Ok(AgentBindingResolution::Bound(bindings));
    }
    if has_live_run || is_agent_named(reader, session_id, agent_id, read_bound)? {
        Ok(AgentBindingResolution::NoLiveBinding {})
    } else {
        Ok(AgentBindingResolution::UnknownAgent {})
    }
}
