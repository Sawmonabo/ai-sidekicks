//! The session's agent tree as a client reads it: every child at any depth with its head, the
//! badge's figures and the refused creates; and a wire handle resolved to its node.

mod head;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use rusqlite::types::Type;
use rusqlite::{Connection, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::orchestration::{
    AgentChildRunLinkListResponse, AgentRunRejectedPayload, ChildRunCounts, ChildRunHead,
    ChildRunLink, ChildRunRejection,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::cost::{AgentSpend, UsdMicros};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::stored_column::{
    StoredJsonFault, closed_word, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::events::session::read::readable_event_sql;

use crate::agent_tree::read::head::{HEAD_LOG_STATEMENT_CAPACITY, HeadLog, run_ids_json};
use crate::agent_tree::store::{AgentTreeNode, read_node, read_session_nodes};
use crate::agents::projection::read_agent_row;
use crate::run::agent::{RUN_AGENT_STATEMENT_CAPACITY, RunAgentReadError, RunAgentReader};
use crate::run::read::RunStateReader;
use crate::usage_record::reads::TOKEN_COUNT_SUM_SQL;

// Every run of the session with the time and the log sequence of its `agent.run.queued` row, read
// as the run's agent is; the unary `+` drops the run id column's affinity, which would keep the
// log's run index from serving.
static SELECT_SESSION_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id, parent_run_id, reached_by, state,
    (SELECT queued.occurred_at
       FROM session_events AS queued
      WHERE queued.session_id = runs.session_id
        AND queued.type = '{run_queued}'
        AND queued.run_id = +runs.run_id) AS queued_at,
    (SELECT queued.sequence
       FROM session_events AS queued
      WHERE queued.session_id = runs.session_id
        AND queued.type = '{run_queued}'
        AND queued.run_id = +runs.run_id) AS queued_sequence
  FROM runs
  WHERE session_id = @session_id",
        run_queued = SessionEventType::AgentRunQueued.as_str(),
    )
});

// Each readable helper start that names the helper's own run, with the provider and its id for
// the helper, which pair the run to its node; and each readable stop of a helper already
// interrupted, which names its own run. The row's type tells the two apart.
static SELECT_HELPER_STARTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(started.payload, '$.childRunId'),
       json_extract(started.payload, '$.provider'),
       json_extract(started.payload, '$.subagentId'),
       started.type
  FROM session_events AS started
  WHERE started.session_id = @session_id
    AND started.type IN ('{started}', '{stopped}')
    AND json_extract(started.payload, '$.childRunId') IS NOT NULL
    AND {readable}",
        started = SessionEventType::AgentSubagentStarted.as_str(),
        stopped = SessionEventType::AgentSubagentStopped.as_str(),
        readable = readable_event_sql("started"),
    )
});

// Each listed run's newest readable usage row that names a model, with its place in the log; the
// bare columns read from the row `MAX` picks.
static SELECT_NEWEST_MODELS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT recorded.run_id, MAX(recorded.sequence),
       json_extract(recorded.payload, '$.modelId')
  FROM session_events AS recorded
  WHERE recorded.session_id = @session_id
    AND recorded.type = '{usage}'
    AND recorded.run_id IN (SELECT value FROM json_each(@run_ids))
    AND json_extract(recorded.payload, '$.modelId') IS NOT NULL
    AND {readable}
  GROUP BY recorded.run_id",
        usage = SessionEventType::UsageTokenCountRecorded.as_str(),
        readable = readable_event_sql("recorded"),
    )
});

// Each listed run's token count, as the run's tally seed counts it.
static SELECT_TOKEN_COUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id, {TOKEN_COUNT_SUM_SQL}
  FROM session_events
  WHERE session_id = @session_id
    AND type = '{usage}'
    AND run_id IN (SELECT value FROM json_each(@run_ids))
  GROUP BY run_id",
        usage = SessionEventType::UsageTokenCountRecorded.as_str(),
    )
});

// Each readable refused create, in log order.
static SELECT_REJECTED_CREATES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT rejected.occurred_at, rejected.payload
  FROM session_events AS rejected
  WHERE rejected.session_id = @session_id
    AND rejected.type = '{rejected}'
    AND {readable}
  ORDER BY rejected.sequence",
        rejected = SessionEventType::AgentRunRejected.as_str(),
        readable = readable_event_sql("rejected"),
    )
});

// Whether a helper stop of the session names its own run, with no read bound.
static SELECT_HELD_STOP_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}",
        held_stop_exists_sql("@session_id", "@own_run_id")
    )
});

/// The statements the tree read and [`resolve_child`] prepare on a read connection: the session's
/// runs, its nodes, its helper starts, the newest models, the token counts, the refused creates,
/// one node, one own run and whether a helper stop names it, the heads' log reads, then the run
/// agent reader's.
pub const AGENT_TREE_READ_STATEMENT_CAPACITY: usize =
    9 + HEAD_LOG_STATEMENT_CAPACITY + RUN_AGENT_STATEMENT_CAPACITY;

/// The SQL test that a stop of a helper already interrupted, an `agent.subagent.stopped` of the
/// session `session_sql`, names the run `own_run_sql` as the helper's own; each argument is a
/// column or a parameter. The stop is found through the log's type index.
pub(crate) fn held_stop_exists_sql(session_sql: &str, own_run_sql: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM session_events AS held
      WHERE held.session_id = {session_sql} AND held.type = '{helper_stopped}'
        AND json_extract(held.payload, '$.childRunId') = {own_run_sql})",
        helper_stopped = SessionEventType::AgentSubagentStopped.as_str(),
    )
}

/// The state a helper's own run reads as: an interrupted one that a helper stop names
/// (`is_held_stop`) was stopped with every agent for good, its row keeping `interrupted`.
pub(crate) fn own_run_state_with_held_stop(state: RunState, is_held_stop: bool) -> RunState {
    if state == RunState::Interrupted && is_held_stop {
        RunState::Stopped
    } else {
        state
    }
}

/// Why the agent tree, or a child handle, could not be read.
#[derive(Debug, thiserror::Error)]
pub enum AgentTreeReadError {
    /// A node's newest own run, or a run's parent, has no `runs` row: a broken store, or a read
    /// while a rebuild of the session's runs deletes and refills them.
    #[error("run \"{run_id}\" has no row")]
    RunMissing {
        /// The run read.
        run_id: RunId,
    },
    /// A run's agent or its binding could not be read.
    #[error(transparent)]
    RunAgent(#[from] RunAgentReadError),
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("reading the agent tree failed")]
    Read(#[from] rusqlite::Error),
}

/// A wire handle resolved to its node: the node, its newest own run's state, and the run that own
/// run hangs under, which the helper runs in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedChild {
    /// The node.
    pub node: AgentTreeNode,
    /// Its newest own run's state, which is the node's; `Stopped` for an interrupted own run a
    /// helper stop names.
    pub state: RunState,
    /// The run its newest own run hangs under: the wire's `run_id` for the helper, and the run an
    /// interrupt or a pause of it names.
    pub parent_run_id: RunId,
}

impl ResolvedChild {
    /// The helper as the session's tree names it: the run it runs in and its handle.
    pub fn member(&self) -> AgentTreeMember {
        AgentTreeMember::ProviderChild {
            run_id: self.parent_run_id,
            child_handle: self.node.child_handle.clone(),
        }
    }
}

/// The node of `session_id` that the wire handle `child_handle` names, with its newest own run's
/// state, a held stop folded in as the tree folds it, and parent; `None` when no node holds it, or
/// its node belongs to another session. Fails with [`AgentTreeReadError::RunMissing`] when its own
/// run has no row, and as SQLite or a stored column does.
pub fn resolve_child(
    reader: &Connection,
    session_id: &SessionId,
    child_handle: &ChildHandle,
) -> Result<Option<ResolvedChild>, AgentTreeReadError> {
    let Some(node) = read_node(reader, child_handle)?.filter(|node| node.session_id == *session_id)
    else {
        return Ok(None);
    };
    let own_run = RunStateReader::new(reader)
        .read_run_parentage(&node.own_run_id)?
        .ok_or(AgentTreeReadError::RunMissing {
            run_id: node.own_run_id,
        })?;
    let is_held_stop = own_run.state == RunState::Interrupted
        && reader.prepare_cached(&SELECT_HELD_STOP_SQL)?.query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@own_run_id": node.own_run_id.text().as_str(),
            },
            |row| row.get::<_, bool>(0),
        )?;
    Ok(Some(ResolvedChild {
        state: own_run_state_with_held_stop(own_run.state, is_held_stop),
        parent_run_id: own_run_parent(own_run.parent_run_id)?,
        node,
    }))
}

/// `session_id`'s whole agent tree: every bridged or workflow run and every provider helper at any
/// depth, oldest first, each with its head; the badge's figures; and the refused creates that name
/// a parent run. What the log reports is read from its events before `read_bound` outside its
/// skipped ranges; each head's binding and name are its agent's row as it stands now, which no
/// bound limits, except that a provider helper's model and effort are its own where its start named
/// them, else those of the nearest helper above it whose start did, and its name and ask are its
/// node's; each head's spend is its member's own in `agent_spend`, 0 where the list names none; its
/// tool calls, end, activity, failure and result are its own run's, a node's newest own run's.
/// Fails as a run's agent read does, with [`AgentTreeReadError::RunMissing`] when a run the tree
/// names has no row, and as SQLite, a stored column or a stored body does.
pub fn read_agent_tree(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
    agent_spend: &[AgentSpend],
) -> Result<AgentChildRunLinkListResponse, AgentTreeReadError> {
    let tree = SessionTree::read(reader, session_id, read_bound)?;
    let drafts = tree.link_drafts()?;

    let model_runs: Vec<RunId> = drafts
        .iter()
        .flat_map(|draft| draft.model_runs.iter().copied())
        .collect();
    let newest_models = read_newest_models(reader, session_id, read_bound, &model_runs)?;
    let head_runs: Vec<RunId> = drafts.iter().map(|draft| draft.head_run).collect();
    let token_counts = read_token_counts(reader, session_id, &head_runs)?;
    let ended_runs: Vec<RunId> = drafts
        .iter()
        .filter(|draft| draft.subject.state().is_terminal())
        .map(|draft| draft.head_run)
        .collect();
    let admitted_runs: Vec<RunId> = drafts
        .iter()
        .filter(|draft| matches!(draft.subject, LinkSubject::Run { .. }))
        .map(|draft| draft.head_run)
        .collect();
    let head_log = HeadLog::read(
        reader,
        session_id,
        read_bound,
        (&head_runs, &ended_runs, &admitted_runs),
    )?;

    let mut ancestry = AncestryWalk {
        tree: &tree,
        agents: RunAgentReader::new(reader),
        session_id,
        agent_of_run: HashMap::new(),
    };
    let mut links = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let run_agent = ancestry
            .agents
            .read_agent_binding(session_id, &draft.head_run)?;
        // A provider helper runs under its parent's agent, so the model and effort its own start
        // named, else the ones the nearest helper above it started on, which it inherited, come
        // before that agent's binding; the model it ran on comes first.
        let place = match &draft.subject {
            LinkSubject::Node { place, .. } => Some(*place),
            LinkSubject::Run { .. } => None,
        };
        let model_id = draft
            .model_runs
            .iter()
            .filter_map(|run_id| newest_models.get(run_id))
            .max_by_key(|(sequence, _)| *sequence)
            .map(|(_, model)| model.clone())
            .or_else(|| tree.lineage(place).find_map(|node| node.model_id.clone()))
            .unwrap_or(run_agent.binding.model_id);
        let effort = tree
            .lineage(place)
            .find_map(|node| node.effort.clone())
            .or(run_agent.binding.effort);
        // A run is named by its agent and asked by the send that started it; a helper by its
        // provider's name for it, else the role it started in, and asked as its start named.
        let (agent_name, ask, via_agent_name) = match &draft.subject {
            LinkSubject::Run { reached_by, .. } => {
                let row_name = read_agent_row(reader, &run_agent.agent_id)?.map(|row| row.name);
                let via_agent_name = match reached_by {
                    ChildRunProvenance::BridgeRun => row_name.clone(),
                    ChildRunProvenance::ProviderSubagent | ChildRunProvenance::WorkflowStep => None,
                };
                (
                    row_name.map(|name| {
                        FreeFormText::new(name.into_string())
                            .expect("an agent's name fits a handle's cap")
                    }),
                    head_log.admitted_ask(draft.head_run),
                    via_agent_name,
                )
            }
            LinkSubject::Node { place, .. } => {
                let node = &tree.nodes[*place];
                let name = node.name.clone().or_else(|| node.role.clone()).map(|name| {
                    FreeFormText::new(name).expect("a helper's name was stored from a handle")
                });
                (name, node.ask.clone(), None)
            }
        };
        let (members, spend) = match &draft.subject {
            LinkSubject::Run { parent_run_id, .. } => (
                ancestry.run_ancestry(*parent_run_id)?,
                own_spend(agent_spend, |member| {
                    matches!(member, AgentTreeMember::Agent { agent_id }
                        if *agent_id == run_agent.agent_id)
                }),
            ),
            LinkSubject::Node { place, .. } => {
                let handle = &tree.nodes[*place].child_handle;
                (
                    ancestry.node_ancestry(*place)?,
                    own_spend(agent_spend, |member| {
                        matches!(member, AgentTreeMember::ProviderChild { child_handle, .. }
                            if child_handle == handle)
                    }),
                )
            }
        };
        // An end is read only for a child at rest: a helper's interrupted own run may continue.
        let end = if draft.subject.state().is_terminal() {
            head_log.end(draft.head_run)
        } else {
            None
        };
        let head = ChildRunHead {
            agent_name,
            ask,
            model_id,
            effort,
            via_agent_name,
            tool_count: head_log.tool_count(draft.head_run),
            tokens: token_counts
                .get(&draft.head_run)
                .copied()
                .unwrap_or(SafeInt::ZERO),
            spend_usd_micros: spend,
            started_at: draft.started_at.clone(),
            ended_at: end.map(|end| end.ended_at.clone()),
            activity: head_log.activity(draft.head_run),
            result: head_log.result(draft.head_run),
            failure_reason: end.and_then(|end| end.failure_reason.clone()),
            ancestry: BoundedVec::new(members)
                .expect("every ancestry reaches a run with no parent, whose agent it names"),
        };
        let link = match draft.subject {
            LinkSubject::Run {
                child_run_id,
                parent_run_id,
                state,
                ..
            } => ChildRunLink::Run {
                child_run_id,
                parent_run_id,
                agent_id: run_agent.agent_id,
                state,
                head,
            },
            LinkSubject::Node {
                place,
                run_id,
                state,
            } => {
                let node = &tree.nodes[place];
                ChildRunLink::ProviderChild {
                    run_id,
                    child_handle: node.child_handle.clone(),
                    parent_child_handle: node.parent_child_handle.clone(),
                    state,
                    head,
                }
            }
        };
        links.push((draft.started_at, draft.order_key, link));
    }
    links.sort_by(|left, right| {
        dispatch_order((&left.0, left.1.as_str()), (&right.0, right.1.as_str()))
    });
    let children: Vec<ChildRunLink> = links.into_iter().map(|(_, _, link)| link).collect();

    let state_of = |link: &ChildRunLink| match link {
        ChildRunLink::Run { state, .. } | ChildRunLink::ProviderChild { state, .. } => *state,
    };
    let counts = ChildRunCounts {
        live: count_of(
            children
                .iter()
                .filter(|link| !state_of(link).is_terminal())
                .count(),
        ),
        total: count_of(children.len()),
        waiting: count_of(
            children
                .iter()
                .filter(|link| state_of(link) == RunState::WaitingForApproval)
                .count(),
        ),
    };
    Ok(AgentChildRunLinkListResponse {
        children,
        counts,
        rejected_creates: read_rejected_creates(reader, session_id, read_bound)?,
    })
}

/// Which of two tree entries was dispatched first, each given by its start and its order key (a
/// run id's text or a handle's): the earlier start, then the smaller key for a shared start.
pub(crate) fn dispatch_order(left: (&WireInstant, &str), right: (&WireInstant, &str)) -> Ordering {
    (left.0.as_str(), left.1).cmp(&(right.0.as_str(), right.1))
}

/// A run of the session as the tree reads it.
pub(crate) struct StoredRun {
    /// The run it hangs under, `None` for a lead run.
    pub(crate) parent_run_id: Option<RunId>,
    /// How its parent reached it, `None` for a lead run.
    pub(crate) reached_by: Option<ChildRunProvenance>,
    /// Where it stands; `Stopped` for an interrupted helper's run a later helper stop names.
    pub(crate) state: RunState,
    /// When its `agent.run.queued` row was written, `None` when the log holds none.
    pub(crate) queued_at: Option<WireInstant>,
    /// Its `agent.run.queued` row's sequence in the session's log, `None` when the log holds none.
    pub(crate) queued_sequence: Option<i64>,
}

/// The session's runs, its nodes, and which node each own run its helper starts name belongs to.
pub(crate) struct SessionTree {
    /// The session read.
    pub(crate) session_id: SessionId,
    /// Every run of the session by its id.
    pub(crate) runs: HashMap<RunId, StoredRun>,
    /// Every node of the session, oldest first.
    pub(crate) nodes: Vec<AgentTreeNode>,
    /// Each node's place in `nodes` by its handle.
    pub(crate) node_of_handle: HashMap<ChildHandle, usize>,
    /// Each own run's node by its place in `nodes`: every node's newest own run, and each run a
    /// readable helper start names for it.
    pub(crate) node_of_run: HashMap<RunId, usize>,
}

impl SessionTree {
    /// `session_id`'s runs and nodes, each own run paired to its node through the helper starts
    /// readable before `read_bound`, and each interrupted own run that a helper stop readable
    /// before it names read as `Stopped`, its row keeping `interrupted`. Fails as SQLite or a
    /// stored column does.
    pub(crate) fn read(
        reader: &Connection,
        session_id: &SessionId,
        read_bound: i64,
    ) -> Result<Self, AgentTreeReadError> {
        let session = session_id.text();
        let mut runs = reader
            .prepare_cached(&SELECT_SESSION_RUNS_SQL)?
            .query_map(named_params! { "@session_id": session.as_str() }, |row| {
                Ok((
                    text_column(row, 0, |text| RunId::new(&text))?,
                    StoredRun {
                        parent_run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
                        reached_by: optional_text_column(row, 2, closed_word)?,
                        state: text_column(row, 3, closed_word)?,
                        queued_at: optional_text_column(row, 4, WireInstant::try_from)?,
                        queued_sequence: row.get(5)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        let nodes = read_session_nodes(reader, *session_id)?;
        let node_of_handle = nodes
            .iter()
            .enumerate()
            .map(|(place, node)| (node.child_handle.clone(), place))
            .collect();
        let node_of_helper: HashMap<(&str, &str), usize> = nodes
            .iter()
            .enumerate()
            .map(|(place, node)| {
                (
                    (node.provider_name.as_str(), node.subagent_id.as_str()),
                    place,
                )
            })
            .collect();
        let mut node_of_run: HashMap<RunId, usize> = nodes
            .iter()
            .enumerate()
            .map(|(place, node)| (node.own_run_id, place))
            .collect();
        let mut starts = reader.prepare_cached(&SELECT_HELPER_STARTS_SQL)?;
        let starts = starts.query_map(
            named_params! { "@session_id": session.as_str(), "@read_bound": read_bound },
            |row| {
                Ok((
                    text_column(row, 0, |text| RunId::new(&text))?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;
        for start in starts {
            let (run_id, provider, subagent_id, event_type) = start?;
            if event_type == SessionEventType::AgentSubagentStopped.as_str() {
                if let Some(run) = runs.get_mut(&run_id) {
                    run.state = own_run_state_with_held_stop(run.state, true);
                }
            } else if let Some(&place) =
                node_of_helper.get(&(provider.as_str(), subagent_id.as_str()))
            {
                node_of_run.insert(run_id, place);
            }
        }
        Ok(Self {
            session_id: *session_id,
            runs,
            nodes,
            node_of_handle,
            node_of_run,
        })
    }

    // The node at `place`, then each node above it, nearest first; none for no place.
    fn lineage(&self, place: Option<usize>) -> impl Iterator<Item = &AgentTreeNode> {
        self.lineage_places(place).map(|place| &self.nodes[place])
    }

    // The place of the node at `place`, then of each node above it, nearest first.
    fn lineage_places(&self, place: Option<usize>) -> impl Iterator<Item = usize> {
        std::iter::successors(place, |&place| {
            self.nodes[place]
                .parent_child_handle
                .as_ref()
                .and_then(|handle| self.node_of_handle.get(handle).copied())
        })
    }

    /// The run `run_id`; fails with [`AgentTreeReadError::RunMissing`] when the session has none.
    pub(crate) fn run(&self, run_id: RunId) -> Result<&StoredRun, AgentTreeReadError> {
        self.runs
            .get(&run_id)
            .ok_or(AgentTreeReadError::RunMissing { run_id })
    }

    /// The run the node at `place` has its newest own run under, which the helper runs in; fails
    /// as [`Self::run`] does, and as a stored column when that own run has no parent.
    pub(crate) fn carrying_run(&self, place: usize) -> Result<RunId, AgentTreeReadError> {
        own_run_parent(self.run(self.nodes[place].own_run_id)?.parent_run_id)
    }

    /// The helper at `place` as the session's tree names it: the run it runs in and its handle;
    /// fails as [`Self::carrying_run`] does.
    pub(crate) fn member(&self, place: usize) -> Result<AgentTreeMember, AgentTreeReadError> {
        Ok(AgentTreeMember::ProviderChild {
            run_id: self.carrying_run(place)?,
            child_handle: self.nodes[place].child_handle.clone(),
        })
    }

    // Each link before its head: a run with a parent that the bridge or a workflow step reached,
    // and every node; a provider subagent's run is its node's, and a run with no parent the root.
    fn link_drafts(&self) -> Result<Vec<LinkDraft>, AgentTreeReadError> {
        let mut drafts = Vec::new();
        for (&run_id, run) in &self.runs {
            let Some(parent_run_id) = run.parent_run_id else {
                continue;
            };
            let reached_by = match run.reached_by {
                Some(
                    reached_by @ (ChildRunProvenance::BridgeRun | ChildRunProvenance::WorkflowStep),
                ) => reached_by,
                Some(ChildRunProvenance::ProviderSubagent) | None => continue,
            };
            // Every run is queued with its agent, so a run with no queued row reads as one whose
            // log names no agent.
            let started_at = run.queued_at.clone().ok_or(RunAgentReadError::NoRunAgent {
                session_id: self.session_id,
                run_id,
            })?;
            drafts.push(LinkDraft {
                head_run: run_id,
                model_runs: vec![run_id],
                started_at,
                order_key: run_id.text().as_str().to_owned(),
                subject: LinkSubject::Run {
                    child_run_id: run_id,
                    parent_run_id,
                    reached_by,
                    state: run.state,
                },
            });
        }
        let mut started_runs: Vec<Vec<RunId>> = vec![Vec::new(); self.nodes.len()];
        for (&run_id, &place) in &self.node_of_run {
            started_runs[place].push(run_id);
        }
        for (place, (node, model_runs)) in self.nodes.iter().zip(started_runs).enumerate() {
            drafts.push(LinkDraft {
                head_run: node.own_run_id,
                model_runs,
                started_at: node.started_at.clone(),
                order_key: node.child_handle.as_str().to_owned(),
                subject: LinkSubject::Node {
                    place,
                    run_id: self.carrying_run(place)?,
                    state: self.run(node.own_run_id)?.state,
                },
            });
        }
        Ok(drafts)
    }
}

// A link before its head is read.
struct LinkDraft {
    // The run whose agent, binding and tokens the head reads: the run itself, or a node's newest
    // own run.
    head_run: RunId,
    // The runs whose newest usage model the head reads.
    model_runs: Vec<RunId>,
    started_at: WireInstant,
    // The run id's or the handle's text, which orders links that started together.
    order_key: String,
    subject: LinkSubject,
}

enum LinkSubject {
    Run {
        child_run_id: RunId,
        parent_run_id: RunId,
        reached_by: ChildRunProvenance,
        state: RunState,
    },
    Node {
        place: usize,
        // The run its newest own run hangs under.
        run_id: RunId,
        state: RunState,
    },
}

impl LinkSubject {
    fn state(&self) -> RunState {
        match self {
            Self::Run { state, .. } | Self::Node { state, .. } => *state,
        }
    }
}

// Walks a link's ancestry, reading each run's agent once per tree read.
struct AncestryWalk<'tree> {
    tree: &'tree SessionTree,
    agents: RunAgentReader<'tree>,
    session_id: &'tree SessionId,
    agent_of_run: HashMap<RunId, AgentId>,
}

impl AncestryWalk<'_> {
    // A node's ancestry from the lead down to its parent: up its parent nodes, then up the runs
    // from the topmost one's carrying run.
    fn node_ancestry(&mut self, place: usize) -> Result<Vec<AgentTreeMember>, AgentTreeReadError> {
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
    fn run_ancestry(
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

// Each of `run_ids` with its newest readable usage row naming a model: the row's place in the log
// and the model, which fails the read when longer than a binding's model holds.
fn read_newest_models(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
    run_ids: &[RunId],
) -> rusqlite::Result<HashMap<RunId, (i64, ProviderToken)>> {
    reader
        .prepare_cached(&SELECT_NEWEST_MODELS_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_ids": run_ids_json(run_ids),
                "@read_bound": read_bound,
            },
            |row| {
                Ok((
                    text_column(row, 0, |text| RunId::new(&text))?,
                    (row.get(1)?, text_column(row, 2, ProviderToken::new)?),
                ))
            },
        )?
        .collect()
}

// Each of `run_ids` that has usage rows with its token count.
fn read_token_counts(
    reader: &Connection,
    session_id: &SessionId,
    run_ids: &[RunId],
) -> rusqlite::Result<HashMap<RunId, SafeInt<0>>> {
    reader
        .prepare_cached(&SELECT_TOKEN_COUNTS_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_ids": run_ids_json(run_ids),
            },
            |row| {
                Ok((
                    text_column(row, 0, |text| RunId::new(&text))?,
                    safe_int_column::<0>(row, 1)?,
                ))
            },
        )?
        .collect()
}

// The readable refused creates that name a parent run, in log order; one naming none belongs to
// no child.
fn read_rejected_creates(
    reader: &Connection,
    session_id: &SessionId,
    read_bound: i64,
) -> rusqlite::Result<Vec<ChildRunRejection>> {
    let mut statement = reader.prepare_cached(&SELECT_REJECTED_CREATES_SQL)?;
    let rows = statement.query_map(
        named_params! {
            "@session_id": session_id.text().as_str(),
            "@read_bound": read_bound,
        },
        |row| {
            Ok((
                text_column(row, 0, WireInstant::try_from)?,
                text_column(row, 1, |text| {
                    serde_json::from_str::<AgentRunRejectedPayload>(&text)
                        .map_err(StoredJsonFault::from)
                })?,
            ))
        },
    )?;
    let mut rejections = Vec::new();
    for row in rows {
        let (occurred_at, rejected) = row?;
        if let Some(parent_run_id) = rejected.parent_run_id {
            rejections.push(ChildRunRejection {
                parent_run_id,
                target_agent_id: rejected.target_agent_id,
                reason: rejected.reason,
                detail: rejected.detail,
                occurred_at,
            });
        }
    }
    Ok(rejections)
}

// The own spend of the first entry whose member `is_member` takes, 0 where none is.
fn own_spend(
    agent_spend: &[AgentSpend],
    is_member: impl Fn(&AgentTreeMember) -> bool,
) -> UsdMicros {
    agent_spend
        .iter()
        .find(|spend| is_member(&spend.agent))
        .map_or(UsdMicros(SafeInt::ZERO), |spend| spend.own_usd_micros)
}

fn count_of(count: usize) -> SafeInt<0> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a count of links held in memory is a safe integer")
}

/// The run a node's own run hangs under. An own run is a provider subagent's, written with its
/// parent, so one with none fails as a column that does not read as its type.
pub(crate) fn own_run_parent(parent_run_id: Option<RunId>) -> Result<RunId, AgentTreeReadError> {
    parent_run_id.ok_or_else(|| {
        AgentTreeReadError::Read(rusqlite::Error::InvalidColumnType(
            1,
            "parent_run_id".to_owned(),
            Type::Null,
        ))
    })
}

#[cfg(test)]
pub(crate) mod tests;
