//! The helpers a session's driver re-attaches after a restart: each helper whose own run was live
//! before the restart, with every ancestor it hangs under, parents first, as the tree holds them.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use rusqlite::types::Type;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_provider::driver::run_control::ReattachedHelper;

use crate::agent_tree::read::{AgentTreeReadError, own_run_parent};
use crate::agent_tree::store::{AgentTreeNode, read_session_nodes};
use crate::run::read::RunStateReader;

/// The statements [`read_helpers_to_reattach`] prepares on a connection: the session's nodes and
/// one run's parentage.
pub const HELPER_REATTACH_STATEMENT_CAPACITY: usize = 2;

// The node read's columns a failed conversion of their text names.
const NODE_SUBAGENT_ID_COLUMN: usize = 3;
const NODE_PARENT_SUBAGENT_ID_COLUMN: usize = 4;
const NODE_PROVIDER_PATH_COLUMN: usize = 8;
const NODE_START_CALL_ID_COLUMN: usize = 9;

/// The helpers of `session_id` to re-attach: each node whose newest own run is in
/// `live_helper_runs`, marked live, and each ancestor of one along its parent nodes, once and not
/// live; by depth below the lead, then oldest first. An empty `live_helper_runs` reads nothing.
/// Fails with [`AgentTreeReadError::RunMissing`] when a kept node's own run has no row, and as
/// SQLite or a stored column does, a stored text the wire refuses included.
pub fn read_helpers_to_reattach(
    connection: &Connection,
    session_id: SessionId,
    live_helper_runs: &[RunId],
) -> Result<Vec<ReattachedHelper>, AgentTreeReadError> {
    if live_helper_runs.is_empty() {
        return Ok(Vec::new());
    }
    let live_helper_runs: HashSet<&RunId> = live_helper_runs.iter().collect();
    let nodes = read_session_nodes(connection, session_id)?;
    let place_of_handle: HashMap<&ChildHandle, usize> = nodes
        .iter()
        .enumerate()
        .map(|(place, node)| (&node.child_handle, place))
        .collect();
    let parent_place = |place: usize| {
        nodes[place]
            .parent_child_handle
            .as_ref()
            .and_then(|handle| place_of_handle.get(handle).copied())
    };

    // Each node's liveness where it is kept: live first, so an ancestor walk never marks a live
    // node, and a walk stops at the first ancestor another walk already kept.
    let mut was_live: Vec<Option<bool>> = nodes
        .iter()
        .map(|node| live_helper_runs.contains(&node.own_run_id).then_some(true))
        .collect();
    for place in 0..nodes.len() {
        if was_live[place] != Some(true) {
            continue;
        }
        let mut ancestor = parent_place(place);
        while let Some(ancestor_place) = ancestor {
            if was_live[ancestor_place].is_some() {
                break;
            }
            was_live[ancestor_place] = Some(false);
            ancestor = parent_place(ancestor_place);
        }
    }

    // Kept places in the store's order, then a stable sort by depth: parents first, oldest first
    // within a depth.
    let mut kept: Vec<(usize, usize)> = (0..nodes.len())
        .filter(|&place| was_live[place].is_some())
        .map(|place| {
            let depth =
                std::iter::successors(parent_place(place), |&above| parent_place(above)).count();
            (depth, place)
        })
        .collect();
    kept.sort_by_key(|&(depth, _)| depth);

    let runs = RunStateReader::new(connection);
    kept.into_iter()
        .map(|(_, place)| {
            let node = &nodes[place];
            let own_run = runs.read_run_parentage(&node.own_run_id)?.ok_or(
                AgentTreeReadError::RunMissing {
                    run_id: node.own_run_id,
                },
            )?;
            reattached_helper(
                node,
                own_run_parent(own_run.parent_run_id)?,
                was_live[place] == Some(true),
            )
        })
        .collect()
}

// The node as its driver takes it, each stored text checked as its wire type.
fn reattached_helper(
    node: &AgentTreeNode,
    parent_run_id: RunId,
    was_live: bool,
) -> Result<ReattachedHelper, AgentTreeReadError> {
    Ok(ReattachedHelper {
        run_id: node.own_run_id,
        parent_run_id,
        subagent_id: SubagentId::new(node.subagent_id.clone())
            .map_err(|error| stored_text_refused(NODE_SUBAGENT_ID_COLUMN, error))?,
        parent_subagent_id: node
            .parent_subagent_id
            .clone()
            .map(SubagentId::new)
            .transpose()
            .map_err(|error| stored_text_refused(NODE_PARENT_SUBAGENT_ID_COLUMN, error))?,
        start_call_id: node
            .start_call_id
            .clone()
            .map(ToolCallId::new)
            .transpose()
            .map_err(|error| stored_text_refused(NODE_START_CALL_ID_COLUMN, error))?,
        provider_path: node
            .provider_path
            .clone()
            .map(FreeFormText::new)
            .transpose()
            .map_err(|error| stored_text_refused(NODE_PROVIDER_PATH_COLUMN, error))?,
        was_live,
    })
}

fn stored_text_refused(column: usize, error: TextError) -> AgentTreeReadError {
    AgentTreeReadError::Read(rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(error),
    ))
}

#[cfg(test)]
mod tests;
