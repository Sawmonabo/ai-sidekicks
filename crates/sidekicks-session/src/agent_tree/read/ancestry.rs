//! A tree entry's ancestry: the members from the lead down to its parent.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::tree::AgentTreeMember;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::session::id::SessionId;

use crate::agent_tree::read::{AgentTreeReadError, SessionTree};
use crate::run::agent::{RunAgentReadError, RunAgentReader};

// Walks a link's ancestry, reading each run's agent once per tree read.
pub(super) struct AncestryWalk<'tree> {
    pub(super) tree: &'tree SessionTree,
    pub(super) agents: RunAgentReader<'tree>,
    pub(super) session_id: &'tree SessionId,
    pub(super) agent_of_run: HashMap<RunId, AgentId>,
}

impl AncestryWalk<'_> {
    // A node's ancestry from the lead down to its parent: up its parent nodes, then up the runs
    // from the topmost one's carrying run.
    pub(super) fn node_ancestry(
        &mut self,
        place: usize,
    ) -> Result<Vec<AgentTreeMember>, AgentTreeReadError> {
        let mut seen = HashSet::from([place]);
        let mut upward = Vec::new();
        let mut topmost = place;
        for parent in self.tree.lineage_places(Some(place)).skip(1) {
            upward.push(self.tree.member(parent)?);
            seen.insert(parent);
            topmost = parent;
        }
        self.walk_runs(self.tree.carrying_run(topmost)?, &mut seen, &mut upward)?;
        upward.reverse();
        Ok(upward)
    }

    // A run link's ancestry from the lead down to its parent run's member.
    pub(super) fn run_ancestry(
        &mut self,
        parent_run_id: RunId,
    ) -> Result<Vec<AgentTreeMember>, AgentTreeReadError> {
        let mut upward = Vec::new();
        self.walk_runs(parent_run_id, &mut HashSet::new(), &mut upward)?;
        upward.reverse();
        Ok(upward)
    }

    // Adds the members up `parent_run_id` from `run_id` to the root, nearest first. A provider
    // subagent's run adds its node's member unless that node is the child or already in `seen`:
    // a helper resumed under a run of its own child hangs under that child's run, so the run
    // chain can cross the node chain. Each chain only reaches back in time, so the walk ends.
    fn walk_runs(
        &mut self,
        mut run_id: RunId,
        seen: &mut HashSet<usize>,
        upward: &mut Vec<AgentTreeMember>,
    ) -> Result<(), AgentTreeReadError> {
        loop {
            let run = self.tree.run(run_id)?;
            let Some(parent_run_id) = run.parent_run_id else {
                upward.push(AgentTreeMember::Agent {
                    agent_id: self.agent(run_id)?,
                });
                return Ok(());
            };
            match run.reached_by {
                Some(ChildRunProvenance::BridgeRun | ChildRunProvenance::WorkflowStep) => {
                    upward.push(AgentTreeMember::Agent {
                        agent_id: self.agent(run_id)?,
                    });
                }
                Some(ChildRunProvenance::ProviderSubagent) | None => {
                    if let Some(&place) = self.tree.node_of_run.get(&run_id)
                        && seen.insert(place)
                    {
                        upward.push(self.tree.member(place)?);
                    }
                }
            }
            run_id = parent_run_id;
        }
    }

    fn agent(&mut self, run_id: RunId) -> Result<AgentId, RunAgentReadError> {
        if let Some(&agent_id) = self.agent_of_run.get(&run_id) {
            return Ok(agent_id);
        }
        let agent_id = self.agents.read_agent(self.session_id, &run_id)?;
        self.agent_of_run.insert(run_id, agent_id);
        Ok(agent_id)
    }
}
