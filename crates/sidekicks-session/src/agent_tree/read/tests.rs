use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::orchestration::{
    AgentChildRunLinkListResponse, ChildRunCounts, ChildRunHead, ChildRunLink,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::cost::{AgentSpend, UsdMicros};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::instant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};
use sidekicks_store::events::session::read::session_read_bound;

use super::{AgentTreeReadError, ResolvedChild, read_agent_tree, resolve_child};
use crate::agent_tree::store::{NewAgentTreeNode, bind_newest_run, insert_node, mint_child_handle};
use crate::agents::projection::test_fixture::{
    binding, project, resolved_run_queued, run_statements, session_created, write_log_row,
};

/// The provider that names every helper of these tests, in its started rows and its nodes alike.
pub(crate) const HELPER_PROVIDER: &str = "test-provider";

/// The instant `second` seconds into the tests' minute, so rows written in order also start in
/// order.
pub(crate) fn at(second: u32) -> String {
    format!("2026-10-28T09:00:{second:02}.000Z")
}

/// A fresh agent id.
pub(crate) fn agent_id() -> AgentId {
    AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id")
}

fn agent_member(agent_id: AgentId) -> AgentTreeMember {
    AgentTreeMember::Agent { agent_id }
}

fn helper_member(run_id: RunId, handle: &ChildHandle) -> AgentTreeMember {
    AgentTreeMember::ProviderChild {
        run_id,
        child_handle: handle.clone(),
    }
}

/// What a test node's first start named, each `None` where it named nothing.
#[derive(Default)]
pub(crate) struct NodeStart<'start> {
    /// The name its provider gave it.
    pub(crate) name: Option<&'start str>,
    /// The role it started in.
    pub(crate) role: Option<&'start str>,
    /// The ask it was started with.
    pub(crate) ask: Option<&'start str>,
    /// The model its start named.
    pub(crate) model_id: Option<&'start str>,
    /// The effort its start named.
    pub(crate) effort: Option<&'start str>,
}

/// One session's runs, nodes and log, on a database holding the agent tree's and the agents'
/// tables, with a lead agent whose `agents` row runs on `model-lead` at `medium`.
pub(crate) struct SessionLog {
    /// The database, which a test may open the event log on.
    pub(crate) database: TestDatabase,
    /// The connection every row is written and read through.
    pub(crate) connection: Connection,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The sequence the next row of the log takes.
    pub(crate) sequence: i64,
    /// The session's lead agent.
    pub(crate) lead: AgentId,
}

impl SessionLog {
    /// A fresh session with its lead.
    pub(crate) fn new() -> Self {
        let database = TestDatabase::new(
            crate::agent_tree::schema::schema_parts()
                .with_parts(crate::agents::schema::schema_parts()),
        );
        let connection = database.opener()().expect("the test opens its database");
        let session_id = test_session_id();
        let lead = agent_id();
        let mut lead_binding = binding(PROVIDERS[0].id, "model-lead");
        lead_binding["effort"] = json!("medium");
        project(
            &connection,
            session_id,
            &session_created(session_id, lead.text().as_str(), &lead_binding),
        );
        Self {
            database,
            connection,
            session_id,
            sequence: 0,
            lead,
        }
    }

    /// Writes one row of the log at `occurred_at`, filed under `run_id` where it names one, and
    /// answers its sequence.
    pub(crate) fn event(
        &mut self,
        event_type: SessionEventType,
        payload: &Value,
        run_id: Option<RunId>,
        occurred_at: &str,
    ) -> i64 {
        let sequence = self.sequence;
        write_log_row(
            &self.connection,
            self.session_id,
            sequence,
            (event_type, payload),
            run_id,
            occurred_at,
        );
        self.sequence += 1;
        sequence
    }

    /// A run in `state` for `agent_id`, under `parent` reached as it names, queued at `queued_at`.
    pub(crate) fn run(
        &mut self,
        parent: Option<(RunId, ChildRunProvenance)>,
        state: RunState,
        agent_id: AgentId,
        queued_at: &str,
    ) -> RunId {
        let run_id = test_run_id();
        self.connection
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state,
                                   run_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![
                    run_id.text().as_str(),
                    self.session_id.text().as_str(),
                    parent.map(|(parent_run_id, _)| parent_run_id.text().as_str().to_owned()),
                    parent.map(|(_, reached_by)| <&'static str>::from(reached_by)),
                    <&'static str>::from(state),
                ],
            )
            .expect("the test writes the run");
        self.event(
            SessionEventType::AgentRunQueued,
            &json!({ "agentId": agent_id }),
            Some(run_id),
            queued_at,
        );
        run_id
    }

    /// A helper's own run under `parent_run_id`, for the lead's agent as a provider subagent's is,
    /// with the helper start that names it.
    pub(crate) fn own_run(
        &mut self,
        parent_run_id: RunId,
        subagent_id: &str,
        state: RunState,
        queued_at: &str,
    ) -> RunId {
        let run_id = self.run(
            Some((parent_run_id, ChildRunProvenance::ProviderSubagent)),
            state,
            self.lead,
            queued_at,
        );
        self.event(
            SessionEventType::AgentSubagentStarted,
            &json!({
                "sessionId": self.session_id,
                "runId": parent_run_id,
                "provider": HELPER_PROVIDER,
                "subagentId": subagent_id,
                "childRunId": run_id,
            }),
            Some(parent_run_id),
            queued_at,
        );
        run_id
    }

    /// A node whose first start named no model or effort.
    pub(crate) fn node(
        &self,
        own_run_id: RunId,
        subagent_id: &str,
        parent_child_handle: Option<&ChildHandle>,
        started_at: &str,
    ) -> ChildHandle {
        self.node_on(
            own_run_id,
            subagent_id,
            parent_child_handle,
            started_at,
            &NodeStart::default(),
        )
    }

    /// The one place a test builds and writes a node, its first start naming what `start` names.
    pub(crate) fn node_on(
        &self,
        own_run_id: RunId,
        subagent_id: &str,
        parent_child_handle: Option<&ChildHandle>,
        started_at: &str,
        start: &NodeStart<'_>,
    ) -> ChildHandle {
        let handle = mint_child_handle();
        let statement = insert_node(&NewAgentTreeNode {
            child_handle: handle.clone(),
            session_id: self.session_id,
            provider_name: ProviderId::new(HELPER_PROVIDER.to_owned()).expect("a provider id"),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: parent_child_handle.cloned(),
            name: start.name.map(str::to_owned),
            role: start.role.map(str::to_owned),
            provider_path: None,
            ask: start.ask.map(str::to_owned),
            model_id: start.model_id.map(str::to_owned),
            effort: start.effort.map(str::to_owned),
            start_call_id: None,
            own_run_id,
            started_at: instant(started_at),
        });
        run_statements(&self.connection, &[statement]);
        handle
    }

    /// Binds the node `handle` to its newest own run `own_run_id`.
    pub(crate) fn bind(&self, handle: &ChildHandle, own_run_id: RunId, updated_at: &str) {
        let updated_at = instant(updated_at);
        run_statements(
            &self.connection,
            &[bind_newest_run(handle, own_run_id, None, &updated_at)],
        );
    }

    // A usage row on `run_id`: 10 in, 5 out, and cache and reasoning figures no count takes.
    fn usage(&mut self, run_id: RunId, model_id: &str, occurred_at: &str) {
        self.event(
            SessionEventType::UsageTokenCountRecorded,
            &json!({
                "runId": run_id,
                "inputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 100,
                "reasoningTokens": 7,
                "modelId": model_id,
            }),
            Some(run_id),
            occurred_at,
        );
    }

    fn read_before(
        &self,
        before_sequence: Option<i64>,
        agent_spend: &[AgentSpend],
    ) -> AgentChildRunLinkListResponse {
        let read_bound = session_read_bound(|_| None, &self.session_id, before_sequence);
        read_agent_tree(&self.connection, &self.session_id, read_bound, agent_spend)
            .expect("the tree reads")
    }

    /// The whole tree, every row of the log read.
    pub(crate) fn read(&self) -> AgentChildRunLinkListResponse {
        self.read_before(None, &[])
    }
}

/// The head of `link`.
pub(crate) fn head(link: &ChildRunLink) -> &ChildRunHead {
    match link {
        ChildRunLink::Run { head, .. } | ChildRunLink::ProviderChild { head, .. } => head,
    }
}

fn ancestry(link: &ChildRunLink) -> Vec<AgentTreeMember> {
    head(link).ancestry.as_slice().to_vec()
}

/// The link a helper's handle names.
pub(crate) fn helper_link<'tree>(
    tree: &'tree AgentChildRunLinkListResponse,
    handle: &ChildHandle,
) -> &'tree ChildRunLink {
    tree.children
        .iter()
        .find(|link| {
            matches!(link, ChildRunLink::ProviderChild { child_handle, .. }
                if child_handle == handle)
        })
        .expect("the helper is listed")
}

/// The link of the run `run_id`.
pub(crate) fn run_link(tree: &AgentChildRunLinkListResponse, run_id: RunId) -> &ChildRunLink {
    tree.children
        .iter()
        .find(|link| {
            matches!(link, ChildRunLink::Run { child_run_id, .. } if *child_run_id == run_id)
        })
        .expect("the run is listed")
}

// A lead run L; a bridged run B under it for the agent X, whose `agents` row names it `reviewer`
// on `model-b` at effort `high`; a workflow run W under L for the lead; the helper H1, its first
// own run R1 under L and its newest R1b under L; and H2 under H1, its own run R2 under R1.
struct Fixture {
    session: SessionLog,
    lead_run: RunId,
    bridged: RunId,
    bridged_agent: AgentId,
    workflow: RunId,
    first_helper: ChildHandle,
    first_helper_first_run: RunId,
    nested_helper: ChildHandle,
    nested_helper_run: RunId,
}

impl Fixture {
    fn new() -> Self {
        let mut session = SessionLog::new();
        let lead = session.lead;
        let lead_run = session.run(None, RunState::Running, lead, &at(0));
        let bridged_agent = agent_id();
        let bridged = session.run(
            Some((lead_run, ChildRunProvenance::BridgeRun)),
            RunState::Running,
            bridged_agent,
            &at(1),
        );
        let mut bridged_binding = binding(PROVIDERS[0].id, "model-b");
        bridged_binding["effort"] = json!("high");
        project(
            &session.connection,
            session.session_id,
            &resolved_run_queued(
                session.session_id,
                bridged.text().as_str(),
                bridged_agent.text().as_str(),
                &bridged_binding,
            ),
        );
        let workflow = session.run(
            Some((lead_run, ChildRunProvenance::WorkflowStep)),
            RunState::Running,
            lead,
            &at(2),
        );
        let first_helper_first_run = session.own_run(lead_run, "h1", RunState::Completed, &at(3));
        let first_helper = session.node(first_helper_first_run, "h1", None, &at(3));
        let nested_helper_run =
            session.own_run(first_helper_first_run, "h2", RunState::Running, &at(4));
        let nested_helper = session.node(nested_helper_run, "h2", Some(&first_helper), &at(4));
        let first_helper_newest_run = session.own_run(lead_run, "h1", RunState::Running, &at(5));
        session.bind(&first_helper, first_helper_newest_run, &at(5));
        Self {
            session,
            lead_run,
            bridged,
            bridged_agent,
            workflow,
            first_helper,
            first_helper_first_run,
            nested_helper,
            nested_helper_run,
        }
    }
}

// Killed by a provider subagent's run listed as a run, by a lead run listed, by the nested
// helper's ancestry missing its parent helper, and by a helper's run id set to its own run
// instead of the run it hangs under.
#[test]
fn every_child_at_every_depth_is_one_row_with_its_ancestry() {
    let fixture = Fixture::new();
    let lead = fixture.session.lead;
    let tree = fixture.session.read();

    let rows: Vec<String> = tree
        .children
        .iter()
        .map(|link| match link {
            ChildRunLink::Run {
                child_run_id,
                parent_run_id,
                agent_id,
                ..
            } => format!("run {child_run_id} under {parent_run_id} for {agent_id}"),
            ChildRunLink::ProviderChild {
                run_id,
                child_handle,
                parent_child_handle,
                ..
            } => format!(
                "helper {} in {run_id} under {:?}",
                child_handle.as_str(),
                parent_child_handle.as_ref().map(ChildHandle::as_str)
            ),
        })
        .collect();
    assert_eq!(
        rows,
        [
            format!(
                "run {} under {} for {}",
                fixture.bridged, fixture.lead_run, fixture.bridged_agent
            ),
            format!(
                "run {} under {} for {lead}",
                fixture.workflow, fixture.lead_run
            ),
            format!(
                "helper {} in {} under None",
                fixture.first_helper.as_str(),
                fixture.lead_run
            ),
            format!(
                "helper {} in {} under Some({:?})",
                fixture.nested_helper.as_str(),
                fixture.first_helper_first_run,
                fixture.first_helper.as_str()
            ),
        ],
        "oldest first; the lead and the helpers' own runs are no rows"
    );

    let lead_only = vec![agent_member(lead)];
    assert_eq!(ancestry(run_link(&tree, fixture.bridged)), lead_only);
    assert_eq!(ancestry(run_link(&tree, fixture.workflow)), lead_only);
    assert_eq!(
        ancestry(helper_link(&tree, &fixture.first_helper)),
        lead_only
    );
    assert_eq!(
        ancestry(helper_link(&tree, &fixture.nested_helper)),
        [
            agent_member(lead),
            helper_member(fixture.lead_run, &fixture.first_helper)
        ],
    );
}

// T starts P, P starts N, then P's message resumes T under P's run, and a bridged run B2 hangs
// under T's first own run. Killed by the skip of a node already in the ancestry (a member
// repeats), by the skip of the child itself, and by runs mapped to their node by its newest own
// run alone (B2 then reads only the lead).
#[test]
fn crossing_node_and_run_chains_end_without_repeating_a_member() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    let first_run_of_t = session.own_run(lead_run, "t", RunState::Completed, &at(1));
    let t = session.node(first_run_of_t, "t", None, &at(1));
    let run_of_p = session.own_run(first_run_of_t, "p", RunState::Running, &at(2));
    let p = session.node(run_of_p, "p", Some(&t), &at(2));
    let run_of_n = session.own_run(run_of_p, "n", RunState::Running, &at(3));
    let n = session.node(run_of_n, "n", Some(&p), &at(3));
    let resumed_run_of_t = session.own_run(run_of_p, "t", RunState::Running, &at(4));
    session.bind(&t, resumed_run_of_t, &at(4));
    let bridged = session.run(
        Some((first_run_of_t, ChildRunProvenance::BridgeRun)),
        RunState::Running,
        lead,
        &at(5),
    );

    let tree = session.read();
    let member_t = helper_member(run_of_p, &t);
    let member_p = helper_member(first_run_of_t, &p);
    assert_eq!(
        ancestry(helper_link(&tree, &n)),
        [agent_member(lead), member_t.clone(), member_p.clone()]
    );
    assert_eq!(
        ancestry(helper_link(&tree, &t)),
        [agent_member(lead), member_p]
    );
    assert_eq!(
        ancestry(helper_link(&tree, &p)),
        [agent_member(lead), member_t.clone()]
    );
    assert_eq!(
        ancestry(run_link(&tree, bridged)),
        [agent_member(lead), member_t]
    );
}

// A provider helper's head names the model it ran on, else the model and effort its node names,
// else those of the nearest node above it that names them, which it inherited, else its parent's
// binding. Killed by either model fallback dropped, by cache or reasoning counted, by the agent
// asked shown on a workflow run, by spend matched on the whole member, by a helper's model read
// from its newest own run only, by the node's values ignored (`h3` reads the lead's), by the
// node's model put before the usage row (`h4` reads `m-own`), by the parent node's values ignored
// (`h5` reads the lead's), and by the binding's fallback dropped (`h2` reads no effort).
#[test]
fn a_head_reads_its_model_effort_tokens_spend_and_start() {
    let mut fixture = Fixture::new();
    let session = &mut fixture.session;
    session.usage(fixture.bridged, "m1", &at(6));
    session.usage(fixture.bridged, "m2", &at(7));
    session.usage(fixture.first_helper_first_run, "mh", &at(8));
    let lead_run = fixture.lead_run;
    let named_run = session.own_run(lead_run, "h3", RunState::Running, &at(9));
    let named = session.node_on(
        named_run,
        "h3",
        None,
        &at(9),
        &NodeStart {
            model_id: Some("gpt-5.4-mini"),
            effort: Some("xhigh"),
            ..NodeStart::default()
        },
    );
    let inheriting_run = session.own_run(named_run, "h5", RunState::Running, &at(10));
    let inheriting = session.node(inheriting_run, "h5", Some(&named), &at(10));
    let used_run = session.own_run(lead_run, "h4", RunState::Running, &at(11));
    let used = session.node_on(
        used_run,
        "h4",
        None,
        &at(11),
        &NodeStart {
            model_id: Some("m-own"),
            effort: Some("low"),
            ..NodeStart::default()
        },
    );
    session.usage(used_run, "m-used", &at(12));
    let spend = |whole| UsdMicros(SafeInt::new(whole).expect("a small figure"));
    let agent_spend = [
        AgentSpend {
            agent: helper_member(fixture.nested_helper_run, &fixture.first_helper),
            own_usd_micros: spend(700),
            subtree_usd_micros: spend(900),
        },
        AgentSpend {
            agent: agent_member(fixture.bridged_agent),
            own_usd_micros: spend(300),
            subtree_usd_micros: spend(300),
        },
    ];
    let tree = session.read_before(None, &agent_spend);

    let bridged = head(run_link(&tree, fixture.bridged));
    assert_eq!(bridged.model_id.as_str(), "m2", "the newest usage model");
    assert_eq!(
        bridged.effort.as_ref().map(FreeFormText::as_str),
        Some("high")
    );
    assert_eq!(
        bridged.via_agent_name.as_ref().map(FreeFormText::as_str),
        Some("reviewer")
    );
    assert_eq!(bridged.tokens.get(), 30, "input plus output of both rows");
    assert_eq!(bridged.spend_usd_micros, spend(300));
    assert_eq!(bridged.started_at.as_str(), at(1));

    let workflow = head(run_link(&tree, fixture.workflow));
    assert_eq!(
        workflow.model_id.as_str(),
        "model-lead",
        "its agent's binding"
    );
    assert_eq!(workflow.via_agent_name, None);
    assert_eq!(workflow.tokens.get(), 0);
    assert_eq!(
        workflow.spend_usd_micros,
        spend(0),
        "the list names no lead"
    );

    let first_helper = head(helper_link(&tree, &fixture.first_helper));
    assert_eq!(
        first_helper.model_id.as_str(),
        "mh",
        "an older own run's model"
    );
    assert_eq!(first_helper.tokens.get(), 0, "its newest own run's count");
    assert_eq!(
        first_helper.spend_usd_micros,
        spend(700),
        "matched by handle"
    );
    assert_eq!(first_helper.started_at.as_str(), at(3));

    let nested_helper = head(helper_link(&tree, &fixture.nested_helper));
    assert_eq!(nested_helper.spend_usd_micros, spend(0));

    let model_and_effort = |handle: &ChildHandle| {
        let head = head(helper_link(&tree, handle));
        (
            head.model_id.as_str().to_owned(),
            head.effort
                .as_ref()
                .map(|effort| effort.as_str().to_owned()),
        )
    };
    let named_as = |model: &str, effort: &str| (model.to_owned(), Some(effort.to_owned()));
    assert_eq!(model_and_effort(&named), named_as("gpt-5.4-mini", "xhigh"));
    assert_eq!(
        model_and_effort(&inheriting),
        named_as("gpt-5.4-mini", "xhigh"),
        "what the helper above it started on"
    );
    assert_eq!(
        model_and_effort(&used),
        named_as("m-used", "low"),
        "the model it ran on before the one its start named"
    );
    assert_eq!(
        model_and_effort(&fixture.nested_helper),
        named_as("model-lead", "medium"),
        "its parent's binding where no node above it names either"
    );
}

// Killed by a terminal state counted as live, by waiting for input counted as waiting, by the
// parentless refusal kept, and by the read bound dropped.
#[test]
fn the_badge_counts_and_the_refused_creates_read_from_the_tree_and_the_log() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    for (second, state) in [
        RunState::Running,
        RunState::WaitingForApproval,
        RunState::WaitingForInput,
        RunState::Completed,
    ]
    .into_iter()
    .enumerate()
    {
        let second = u32::try_from(second).expect("a few seconds") + 1;
        session.run(
            Some((lead_run, ChildRunProvenance::BridgeRun)),
            state,
            lead,
            &at(second),
        );
    }
    let session_id = session.session_id;
    let refused = |parent: Option<RunId>| {
        let mut payload = json!({ "sessionId": session_id, "reason": "agent.notFound" });
        if let Some(parent_run_id) = parent {
            payload["parentRunId"] = json!(parent_run_id);
        }
        payload
    };
    let kept = refused(Some(lead_run));
    session.event(SessionEventType::AgentRunRejected, &kept, None, &at(6));
    let parentless = refused(None);
    session.event(
        SessionEventType::AgentRunRejected,
        &parentless,
        None,
        &at(7),
    );
    let unreadable = refused(Some(lead_run));
    let bound = session.event(
        SessionEventType::AgentRunRejected,
        &unreadable,
        None,
        &at(8),
    );

    let tree = session.read_before(Some(bound), &[]);
    let figure = |count| SafeInt::new(count).expect("a small count");
    assert_eq!(
        tree.counts,
        ChildRunCounts {
            live: figure(3),
            total: figure(4),
            waiting: figure(1),
        }
    );
    let rejected: Vec<(RunId, String)> = tree
        .rejected_creates
        .iter()
        .map(|rejection| {
            (
                rejection.parent_run_id,
                rejection.occurred_at.as_str().to_owned(),
            )
        })
        .collect();
    assert_eq!(rejected, [(lead_run, at(6))]);
}

// Killed by the session check dropped, by the node's first own run read instead of its newest, by
// a missing own run read as no child, by a held stop left unfolded (the held node reading
// `interrupted`), and by the fold taken where no helper stop names the own run (the unheld node
// reading `stopped`).
#[test]
fn a_handle_resolves_to_its_node_in_its_session_only() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    let other_lead_run = session.run(None, RunState::Running, lead, &at(1));
    let first_run = session.own_run(lead_run, "h", RunState::Completed, &at(2));
    let handle = session.node(first_run, "h", None, &at(2));
    let newest_run = session.own_run(other_lead_run, "h", RunState::WaitingForInput, &at(3));
    session.bind(&handle, newest_run, &at(3));
    let held_run = session.own_run(lead_run, "held", RunState::Interrupted, &at(4));
    let held = session.node(held_run, "held", None, &at(4));
    let unheld_run = session.own_run(lead_run, "unheld", RunState::Interrupted, &at(5));
    let unheld = session.node(unheld_run, "unheld", None, &at(5));
    let session_id = session.session_id;
    session.event(
        SessionEventType::AgentSubagentStopped,
        &json!({
            "sessionId": session_id,
            "runId": lead_run,
            "provider": HELPER_PROVIDER,
            "subagentId": "held",
            "childRunId": held_run,
        }),
        Some(lead_run),
        &at(6),
    );

    let resolve = |session_id: &SessionId, child_handle: &ChildHandle| {
        resolve_child(&session.connection, session_id, child_handle)
    };
    assert!(matches!(
        resolve(&session.session_id, &mint_child_handle()),
        Ok(None)
    ));
    assert!(matches!(resolve(&test_session_id(), &handle), Ok(None)));

    let resolved: ResolvedChild = resolve(&session.session_id, &handle)
        .expect("the handle resolves")
        .expect("the node is the session's");
    assert_eq!(resolved.node.own_run_id, newest_run);
    assert_eq!(resolved.state, RunState::WaitingForInput);
    assert_eq!(resolved.parent_run_id, other_lead_run);
    assert_eq!(resolved.member(), helper_member(other_lead_run, &handle));
    let state_of = |child_handle: &ChildHandle| {
        resolve(&session_id, child_handle)
            .expect("the handle resolves")
            .expect("the node is the session's")
            .state
    };
    assert_eq!(state_of(&held), RunState::Stopped);
    assert_eq!(state_of(&unheld), RunState::Interrupted);

    session
        .connection
        .execute(
            "DELETE FROM runs WHERE run_id = ?1",
            [newest_run.text().as_str()],
        )
        .expect("the test deletes the run");
    assert!(matches!(
        resolve(&session.session_id, &handle),
        Err(AgentTreeReadError::RunMissing { run_id }) if run_id == newest_run
    ));
}
