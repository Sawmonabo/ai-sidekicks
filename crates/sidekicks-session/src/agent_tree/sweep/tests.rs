use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_store::events::session::read::session_read_bound;

use super::{Descendant, DescendantStop, SweepRoot, read_descendants};
use crate::agent_tree::read::tests::{HELPER_PROVIDER, SessionLog, agent_id, at};

fn agent_run(agent_id: AgentId, run_id: RunId, state: RunState) -> Descendant {
    Descendant {
        member: AgentTreeMember::Agent { agent_id },
        state,
        stop: DescendantStop::Run { run_id },
    }
}

// The helper `handle` running in `carrying_run`, its newest own run `own_run` in `state`.
fn helper(
    carrying_run: RunId,
    handle: &ChildHandle,
    own_run: RunId,
    subagent_id: &str,
    state: RunState,
) -> Descendant {
    Descendant {
        member: AgentTreeMember::ProviderChild {
            run_id: carrying_run,
            child_handle: handle.clone(),
        },
        state,
        stop: DescendantStop::Helper {
            provider_name: ProviderId::new(HELPER_PROVIDER.to_owned()).expect("a provider id"),
            run_id: own_run,
            subagent_id: SubagentId::new(subagent_id.to_owned()).expect("a helper id"),
        },
    }
}

fn descendants(
    session: &SessionLog,
    root: SweepRoot,
    started_after: Option<i64>,
) -> Vec<Descendant> {
    let read_bound = session_read_bound(|_| None, &session.session_id, None);
    read_descendants(
        &session.connection,
        &session.session_id,
        &root,
        started_after,
        read_bound,
    )
    .expect("the descendants read")
}

// A lead run L1 with a bridged run B, a completed workflow run W, the helper T, and the helper H1;
// H2 under H1, H3 (interrupted) under H2, and a bridged run B3 under H2's own run; T resumed under
// L1 after H1 was queued; a second lead run L2 with the helper G. Killed by a walk of depth 1
// only, by the root's own helper listed, by bridged or workflow runs skipped, by an ended run
// included, by an interrupted run left out, by G missing under the session, and by
// `started_after` dropped or read off a helper's first own run.
#[test]
fn every_live_or_interrupted_descendant_is_listed_once_in_dispatch_order() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let first_lead_run = session.run(None, RunState::Running, lead, &at(0));
    let bridged_agent = agent_id();
    let bridged = session.run(
        Some((first_lead_run, ChildRunProvenance::BridgeRun)),
        RunState::Running,
        bridged_agent,
        &at(1),
    );
    session.run(
        Some((first_lead_run, ChildRunProvenance::WorkflowStep)),
        RunState::Completed,
        agent_id(),
        &at(2),
    );
    let first_run_of_t = session.own_run(first_lead_run, "t", RunState::Completed, &at(3));
    let t = session.node(first_run_of_t, "t", None, &at(3));
    // `own_run` writes the run's queued row first, so it takes the sequence the log is at.
    let queued_of_h1 = session.sequence;
    let run_of_h1 = session.own_run(first_lead_run, "h1", RunState::Running, &at(4));
    let h1 = session.node(run_of_h1, "h1", None, &at(4));
    let run_of_h2 = session.own_run(run_of_h1, "h2", RunState::WaitingForApproval, &at(5));
    let h2 = session.node(run_of_h2, "h2", Some(&h1), &at(5));
    let run_of_h3 = session.own_run(run_of_h2, "h3", RunState::Interrupted, &at(6));
    let h3 = session.node(run_of_h3, "h3", Some(&h2), &at(6));
    let nested_bridged_agent = agent_id();
    let nested_bridged = session.run(
        Some((run_of_h2, ChildRunProvenance::BridgeRun)),
        RunState::Running,
        nested_bridged_agent,
        &at(7),
    );
    let resumed_run_of_t = session.own_run(first_lead_run, "t", RunState::Running, &at(8));
    session.bind(&t, resumed_run_of_t, &at(8));
    let second_lead_run = session.run(None, RunState::Running, lead, &at(9));
    let run_of_g = session.own_run(second_lead_run, "g", RunState::Running, &at(10));
    let g = session.node(run_of_g, "g", None, &at(10));

    let entry_b = agent_run(bridged_agent, bridged, RunState::Running);
    let entry_t = helper(first_lead_run, &t, resumed_run_of_t, "t", RunState::Running);
    let entry_h1 = helper(first_lead_run, &h1, run_of_h1, "h1", RunState::Running);
    let entry_h2 = helper(
        run_of_h1,
        &h2,
        run_of_h2,
        "h2",
        RunState::WaitingForApproval,
    );
    let entry_h3 = helper(run_of_h2, &h3, run_of_h3, "h3", RunState::Interrupted);
    let entry_b3 = agent_run(nested_bridged_agent, nested_bridged, RunState::Running);
    let entry_g = helper(second_lead_run, &g, run_of_g, "g", RunState::Running);

    let below_first_lead_run = vec![
        entry_b,
        entry_t.clone(),
        entry_h1,
        entry_h2.clone(),
        entry_h3.clone(),
        entry_b3.clone(),
    ];
    assert_eq!(
        descendants(&session, SweepRoot::Run(first_lead_run), None),
        below_first_lead_run,
        "a helper orders by its first start"
    );
    assert_eq!(
        descendants(&session, SweepRoot::Run(run_of_h1), None),
        [entry_h2.clone(), entry_h3.clone(), entry_b3.clone()],
        "the root's own helper is not listed"
    );
    let mut below_session = below_first_lead_run;
    below_session.push(entry_g.clone());
    assert_eq!(
        descendants(&session, SweepRoot::Session, None),
        below_session
    );
    assert_eq!(
        descendants(&session, SweepRoot::Session, Some(queued_of_h1)),
        [entry_t, entry_h2, entry_h3, entry_b3, entry_g],
        "a helper is kept by its newest own run's queued row"
    );
}
