//! The agent tree's rows as the log rebuilds them: each helper's node written at its first run's
//! `agent.run.queued` and bound to each later one, through the statement the run's own write uses.

use std::borrow::Cow;
use std::collections::HashSet;

use rusqlite::types::Value;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{AgentRunQueuedPayload, ProviderChildStart};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

use crate::agent_tree::store::{NewAgentTreeNode, bind_newest_run, insert_node};

// One delete takes parents and children together: SQLite checks an immediate foreign key once the
// statement ends.
const DELETE_SESSION_NODES_SQL: &str = "DELETE FROM agent_tree_nodes WHERE session_id = ?";

const AGENT_TREE_EVENT_TYPES: &[SessionEventType] = &[SessionEventType::AgentRunQueued];

/// What a helper's run start writes to its node: the node itself under its parent's node, or the
/// newest run of a node the tree already holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProviderChildNodeWrite {
    /// The helper's first start writes its node beneath `parent_child_handle`, `None` under the
    /// lead or where no node holds its parent.
    Insert {
        /// The parent's node.
        parent_child_handle: Option<ChildHandle>,
    },
    /// A later start binds the known node to its newest run.
    BindNewestRun,
}

/// The statement that writes `child`'s node for its run `own_run_id` in `session_id`, as `write`
/// says, timed by `occurred_at`, the instant of the run's `agent.run.queued`. The statement is
/// refused as [`insert_node`] or [`bind_newest_run`] refuses it.
pub(crate) fn provider_child_node_statement(
    session_id: SessionId,
    own_run_id: RunId,
    child: &ProviderChildStart,
    occurred_at: &WireInstant,
    write: ProviderChildNodeWrite,
) -> WriteStatement {
    let start_call_id = child.start_call_id.as_ref().map(ToolCallId::as_str);
    match write {
        ProviderChildNodeWrite::Insert {
            parent_child_handle,
        } => insert_node(&NewAgentTreeNode {
            child_handle: child.child_handle.clone(),
            session_id,
            provider_name: child.provider.clone(),
            subagent_id: child.subagent_id.as_str().to_owned(),
            parent_subagent_id: child
                .parent_subagent_id
                .as_ref()
                .map(|parent| parent.as_str().to_owned()),
            parent_child_handle,
            name: child.name.as_ref().map(|name| name.as_str().to_owned()),
            role: child.role.as_ref().map(|role| role.as_str().to_owned()),
            provider_path: child
                .provider_path
                .as_ref()
                .map(|path| path.as_str().to_owned()),
            ask: child.ask.as_ref().map(|ask| ask.as_str().to_owned()),
            model_id: child
                .model_id
                .as_ref()
                .map(|model| model.as_str().to_owned()),
            effort: child
                .effort
                .as_ref()
                .map(|effort| effort.as_str().to_owned()),
            start_call_id: start_call_id.map(str::to_owned),
            own_run_id,
            started_at: occurred_at.clone(),
        }),
        ProviderChildNodeWrite::BindNewestRun => {
            bind_newest_run(&child.child_handle, own_run_id, start_call_id, occurred_at)
        }
    }
}

/// The `agent_tree_nodes` rows as a rebuild replaces them: one per helper a provider started in the
/// session, folded from the `agent.run.queued` of each of its runs.
#[derive(Clone, Copy, Debug)]
pub struct AgentTreeProjection;

impl SessionProjection for AgentTreeProjection {
    fn name(&self) -> &'static str {
        "agent_tree"
    }

    fn event_types(&self) -> &[SessionEventType] {
        AGENT_TREE_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(DELETE_SESSION_NODES_SQL),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(AgentTreeFold {
            written: HashSet::new(),
        })
    }
}

// The nodes this rebuild has written: a helper's first start writes its node, each later one binds
// it, and a parent the rebuild never wrote, its every start in a range skipped as damaged, is no
// parent.
struct AgentTreeFold {
    written: HashSet<ChildHandle>,
}

impl SessionProjectionFold for AgentTreeFold {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let SessionEvent::AgentRunQueued(AgentRunQueuedPayload::SessionAgent(queued)) = event
        else {
            return Ok(());
        };
        let Some(child) = &queued.provider_child else {
            return Ok(());
        };
        let occurred_at =
            WireInstant::try_from(envelope.occurred_at.as_str().to_owned()).map_err(|refusal| {
                ProjectionContradiction(format!(
                    "The start of run {} has an occurredAt that does not read: {refusal}",
                    queued.run_id
                ))
            })?;
        let write = if self.written.insert(child.child_handle.clone()) {
            ProviderChildNodeWrite::Insert {
                parent_child_handle: child
                    .parent_child_handle
                    .clone()
                    .filter(|parent| self.written.contains(parent)),
            }
        } else {
            ProviderChildNodeWrite::BindNewestRun
        };
        statements.push(provider_child_node_statement(
            queued.session_id,
            queued.run_id,
            child,
            &occurred_at,
            write,
        ));
        Ok(())
    }
}
