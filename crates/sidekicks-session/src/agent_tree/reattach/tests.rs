use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_provider::driver::run_control::ReattachedHelper;

use super::read_helpers_to_reattach;
use crate::agent_tree::read::tests::{NodeStart, SessionLog, at};

fn helper(
    run_id: RunId,
    parent_run_id: RunId,
    subagent_id: &str,
    was_live: bool,
) -> ReattachedHelper {
    ReattachedHelper {
        run_id,
        parent_run_id,
        subagent_id: SubagentId::new(subagent_id.to_owned()).expect("a helper id"),
        parent_subagent_id: None,
        start_call_id: None,
        provider_path: None,
        model_id: None,
        was_live,
    }
}

// A lead run L0, then L1. H1 first ran under L0 and runs again under L1; H2 runs under H1 and
// started before it; P completed under L1 with the live child C; Q completed with nothing live
// below it; X runs under L1 but is not in the list. Killed by a child before its parent, by P
// missing, by Q or X included, by P marked live, by the store's order alone (H2 first), and by
// H1's `parent_run_id` read off its first own run (L0); C carries the model its node names,
// killed by the node's model left off.
#[test]
fn live_helpers_come_with_their_ancestors_parents_first() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let first_lead_run = session.run(None, RunState::Completed, lead, &at(0));
    let lead_run = session.run(None, RunState::Running, lead, &at(1));

    let h1_first_run = session.own_run(first_lead_run, "h1", RunState::Interrupted, &at(2));
    let h1 = session.node(h1_first_run, "h1", None, &at(5));
    let h1_run = session.own_run(lead_run, "h1", RunState::Running, &at(6));
    session.bind(&h1, h1_run, &at(6));
    let h2_run = session.own_run(h1_run, "h2", RunState::Running, &at(7));
    session.node(h2_run, "h2", Some(&h1), &at(3));

    let p_run = session.own_run(lead_run, "p", RunState::Completed, &at(8));
    let p = session.node(p_run, "p", None, &at(8));
    let c_run = session.own_run(p_run, "c", RunState::Running, &at(9));
    session.node_on(
        c_run,
        "c",
        Some(&p),
        &at(9),
        &NodeStart {
            model_id: Some("gpt-5.4-mini"),
            effort: Some("low"),
            ..NodeStart::default()
        },
    );

    let q_run = session.own_run(lead_run, "q", RunState::Completed, &at(10));
    session.node(q_run, "q", None, &at(10));
    let x_run = session.own_run(lead_run, "x", RunState::Running, &at(11));
    session.node(x_run, "x", None, &at(11));

    let helpers = read_helpers_to_reattach(
        &session.connection,
        session.session_id,
        &[h2_run, c_run, h1_run],
    )
    .expect("the helpers read");

    assert_eq!(
        helpers,
        vec![
            helper(h1_run, lead_run, "h1", true),
            helper(p_run, lead_run, "p", false),
            helper(h2_run, h1_run, "h2", true),
            ReattachedHelper {
                model_id: Some(ProviderToken::new("gpt-5.4-mini".to_owned()).expect("a model id")),
                ..helper(c_run, p_run, "c", true)
            },
        ]
    );
}
