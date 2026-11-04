//! The agents a stop of many reaches: every live or interrupted agent below one run, or below
//! every lead run of the session, at every depth, in dispatch order, each with what its stop
//! needs.

pub mod stops;

use std::collections::{HashMap, VecDeque};

use rusqlite::Connection;
use sidekicks_contracts::agent::tree::AgentTreeMember;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::agent_tree::read::{AgentTreeReadError, SessionTree, StoredRun, dispatch_order};
use crate::run::agent::{RUN_AGENT_STATEMENT_CAPACITY, RunAgentReadError, RunAgentReader};

pub use self::stops::{AgentTreeSweep, AgentTreeSweepError};

/// The statements [`read_descendants`] prepares on a read connection: the session's runs, its
/// nodes and its helper starts, then the run agent reader's.
pub const AGENT_TREE_SWEEP_STATEMENT_CAPACITY: usize = 3 + RUN_AGENT_STATEMENT_CAPACITY;

/// Where a sweep of the session's agents starts; the root itself is never listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SweepRoot {
    /// Below every run with no parent: every agent the session dispatched, a helper an earlier
    /// lead run left running included.
    Session,
    /// Below this run.
    Run(RunId),
}

/// One agent below a sweep's root that its stop reaches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Descendant {
    /// The agent as the session's tree names it.
    pub member: AgentTreeMember,
    /// Its run's state, live or `Interrupted`; a helper's is its newest own run's.
    pub state: RunState,
    /// What its stop needs.
    pub stop: DescendantStop,
}

/// What the stop of one descendant needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DescendantStop {
    /// A bridged or workflow run, stopped by the run engine's interrupt.
    Run {
        /// The run.
        run_id: RunId,
    },
    /// A provider's helper, stopped by its provider's driver.
    Helper {
        /// The provider that named the helper, whose driver stops it.
        provider_name: ProviderId,
        /// The run the helper runs under.
        carrying_run_id: RunId,
        /// The helper's newest own run.
        run_id: RunId,
        /// The provider's id of the helper.
        subagent_id: SubagentId,
    },
}

/// Every agent below `root` in `session_id`'s tree, at every depth, whose run is live or
/// `Interrupted`, and, with `started_after`, whose run was queued after that sequence of the
/// session's log; in dispatch order. A bridged or workflow run is listed as its agent, a helper by
/// its newest own run; every run is walked through. Helper starts count when readable before
/// `read_bound`. Fails as the tree read does, and as a listed run's agent read does.
pub fn read_descendants(
    reader: &Connection,
    session_id: &SessionId,
    root: &SweepRoot,
    started_after: Option<i64>,
    read_bound: i64,
) -> Result<Vec<Descendant>, AgentTreeReadError> {
    let tree = SessionTree::read(reader, session_id, read_bound)?;
    let mut children_of: HashMap<RunId, Vec<(RunId, &StoredRun)>> = HashMap::new();
    let mut lead_runs = VecDeque::new();
    for (&run_id, run) in &tree.runs {
        match run.parent_run_id {
            Some(parent_run_id) => children_of
                .entry(parent_run_id)
                .or_default()
                .push((run_id, run)),
            None => lead_runs.push_back(run_id),
        }
    }
    let mut walk = match root {
        SweepRoot::Session => lead_runs,
        SweepRoot::Run(run_id) => VecDeque::from([*run_id]),
    };

    let agents = RunAgentReader::new(reader);
    let mut listed: Vec<(WireInstant, String, Descendant)> = Vec::new();
    while let Some(parent_run_id) = walk.pop_front() {
        for &(run_id, run) in children_of.get(&parent_run_id).into_iter().flatten() {
            walk.push_back(run_id);
            let is_stoppable = !run.state.is_terminal() || run.state == RunState::Interrupted;
            let is_after = started_after.is_none_or(|after| {
                run.queued_sequence
                    .is_some_and(|queued_sequence| queued_sequence > after)
            });
            if !(is_stoppable && is_after) {
                continue;
            }
            match run.reached_by {
                Some(ChildRunProvenance::BridgeRun | ChildRunProvenance::WorkflowStep) => {
                    // Every run is queued with its agent, so a run with no queued row reads as one
                    // whose log names no agent.
                    let started_at =
                        run.queued_at.clone().ok_or(RunAgentReadError::NoRunAgent {
                            session_id: *session_id,
                            run_id,
                        })?;
                    let agent_id = agents.read_agent(session_id, &run_id)?;
                    listed.push((
                        started_at,
                        run_id.text().as_str().to_owned(),
                        Descendant {
                            member: AgentTreeMember::Agent { agent_id },
                            state: run.state,
                            stop: DescendantStop::Run { run_id },
                        },
                    ));
                }
                Some(ChildRunProvenance::ProviderSubagent) | None => {
                    // A helper is listed by its newest own run; an older own run, or a run no node
                    // holds, is only walked through.
                    let Some(&place) = tree.node_of_run.get(&run_id) else {
                        continue;
                    };
                    let node = &tree.nodes[place];
                    if node.own_run_id != run_id {
                        continue;
                    }
                    listed.push((
                        node.started_at.clone(),
                        node.child_handle.as_str().to_owned(),
                        Descendant {
                            member: tree.member(place)?,
                            state: run.state,
                            stop: DescendantStop::Helper {
                                provider_name: node.provider_name.clone(),
                                carrying_run_id: tree.carrying_run(place)?,
                                run_id,
                                subagent_id: node.subagent_id.clone(),
                            },
                        },
                    ));
                }
            }
        }
    }
    listed.sort_by(|left, right| {
        dispatch_order((&left.0, left.1.as_str()), (&right.0, right.1.as_str()))
    });
    Ok(listed
        .into_iter()
        .map(|(_, _, descendant)| descendant)
        .collect())
}

#[cfg(test)]
mod tests;
