//! Every name a session knows on Claude Code: its commands and the agents it offers, read from its
//! live process or, at rest, from the one process its command list starts, offered its helpers.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandEntry,
};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::declarations::{
    ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::claude::spawn::launch::control_only::compose_claude_short_initialize_request;
use crate::driver::claude::spawn::launch::initialize_reply::{
    ClaudeListedCommand, read_claude_initialize_declaration,
};
use crate::driver::claude::spawn::launch::session_listing::ClaudeSessionListing;
use crate::driver::contract::known_names::{KnownNamesParams, ProviderAgent, ProviderKnownNames};
use crate::driver::session_control::SubagentDefinition;
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;

fn binding() -> ProviderCommandBinding {
    ProviderCommandBinding {
        provider_name: DESCRIPTOR.provider_id(),
        provider_account_id: test_provider_account_id(),
    }
}

fn text<const MAX: usize>(text: &str) -> FreeFormText<MAX> {
    FreeFormText::new(text.to_owned()).expect("the test's text fits")
}

fn command(name: &str, description: Option<&str>) -> ProviderCommandEntry {
    ProviderCommandEntry::Command {
        name: text(name),
        description: description.map(text),
        argument_hint: None,
        scope: None,
        enabled: None,
        binding: binding(),
        server: None,
        title: None,
    }
}

fn agent(name: &str, description: Option<&str>) -> ProviderAgent {
    ProviderAgent {
        name: name.to_owned(),
        description: description.map(str::to_owned),
    }
}

fn planner() -> SubagentDefinition {
    SubagentDefinition {
        name: "planner".to_owned(),
        prompt: "Plan it.".to_owned(),
        description: "Plans the work".to_owned(),
        model: None,
        tools: None,
        effort: None,
        max_turns: None,
    }
}

// Killed by the agents dropped live or at rest, by a description dropped, by the live session
// read again at rest, by a second process started for the agents, by the helpers not handed to the
// resting read, and by an empty `agents` map composed for none; that the read's process is sent
// that `initialize` is the resting read's own test.
#[rstest]
#[case::live(true, Vec::new())]
#[case::at_rest(false, Vec::new())]
#[case::at_rest_offering_helpers(false, vec![planner()])]
#[tokio::test(start_paused = true)]
async fn a_session_knows_its_commands_and_agents_live_and_at_rest(
    #[case] is_live: bool,
    #[case] offered: Vec<SubagentDefinition>,
) {
    let fixture = ScriptedDriver::new();
    let session_id = if is_live {
        fixture
            .starts
            .script_initialize(ClaudeInitializeDeclaration {
                models: vec![ClaudeOfferedModel {
                    value: "opus".to_owned(),
                    resolved_model: None,
                    display_name: None,
                    effort_levels: None,
                }],
                commands: vec!["review".to_owned()],
                agents: vec![
                    agent("Explore", Some("Fast codebase search")),
                    agent("reviewer", None),
                ],
                ..ClaudeInitializeDeclaration::default()
            });
        fixture.create(&Arc::new(ScriptedChannel::default())).await
    } else {
        new_session_id()
    };
    fixture.starts.script_session_listing(ClaudeSessionListing {
        commands: vec![ClaudeListedCommand {
            name: "review".to_owned(),
            description: Some("Review the diff".to_owned()),
            argument_hint: None,
        }],
        agents: vec![agent("reviewer", Some("Reviews code"))],
    });

    let known = fixture
        .driver
        .list_known_names(KnownNamesParams {
            session_id,
            binding: binding(),
            subagent_definitions: offered.clone(),
        })
        .await
        .expect("the names read");

    let expected = if is_live {
        ProviderKnownNames {
            entries: vec![command("review", None)],
            agents: vec![
                agent("Explore", Some("Fast codebase search")),
                agent("reviewer", None),
            ],
        }
    } else {
        ProviderKnownNames {
            entries: vec![command("review", Some("Review the diff"))],
            agents: vec![agent("reviewer", Some("Reviews code"))],
        }
    };
    assert_eq!(known, expected);
    let offers = fixture.starts.take_session_listing_offers();
    if is_live {
        assert!(offers.is_empty(), "a live session starts no read");
    } else {
        assert_eq!(
            offers,
            vec![offered.clone()],
            "one read, offered the helpers"
        );
    }
    let request = compose_claude_short_initialize_request(&offered);
    let ClaudeControlRequest::Initialize { agents, .. } = request else {
        panic!("the short process is sent an initialize");
    };
    let offered_names: Vec<String> = offered.iter().map(|helper| helper.name.clone()).collect();
    assert_eq!(
        agents.map(|agents| agents.into_keys().collect::<Vec<_>>()),
        (!offered_names.is_empty()).then_some(offered_names),
        "the helpers offered by name, and no agents member for none"
    );
}

// Killed by a row naming no agent kept, and by an empty description kept as one.
#[test]
fn the_reply_agent_rows_keep_each_named_agent_and_its_description() {
    let reply = json!({"agents": [
        {"name": "Explore", "description": "Fast search"},
        {"description": "no name"},
        {"name": "x", "description": ""},
    ]});
    let reply = serde_json::value::to_raw_value(&reply).expect("a test reply serializes");

    assert_eq!(
        read_claude_initialize_declaration(Some(&reply)).agents,
        vec![agent("Explore", Some("Fast search")), agent("x", None),]
    );
}
