//! A session's command list, read from its live process or, at rest, from a process that keeps
//! nothing, which concurrent reads share and none keeps.

use std::pin::pin;
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup, ProviderCommandEntry,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::scripted::binding_id;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
use crate::driver::claude::spawn::launch::initialize_reply::read_claude_listed_command_rows;
use crate::driver::claude::spawn::launch::session_listing::ClaudeSessionListing;
use crate::driver::contract::params_and_results::ListProviderCommandsParams;
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::runtime_binding::test_store::test_provider_account_id;

fn binding() -> ProviderCommandBinding {
    ProviderCommandBinding {
        provider_name: DESCRIPTOR.provider_id(),
        provider_account_id: test_provider_account_id(),
    }
}

fn params(session_id: SessionId) -> ListProviderCommandsParams {
    ListProviderCommandsParams {
        session_id,
        binding_id: binding_id("lead"),
        binding: binding(),
        run_id: Some(new_run_id()),
    }
}

fn text<const MAX: usize>(text: &str) -> FreeFormText<MAX> {
    FreeFormText::new(text.to_owned()).expect("the test's text fits")
}

// The listing a resting session's `initialize` reply gives, its rows read as the read reads them:
// a command with the empty hint Claude Code lists for one that takes none, and a tool server's
// prompt.
fn listed_rows() -> ClaudeSessionListing {
    let reply = json!({"commands": [
        {"name": "review", "description": "Review the diff", "argumentHint": ""},
        {"name": "github:list_prs (MCP)", "description": "List PRs", "argumentHint": ""},
    ]});
    let reply = serde_json::value::to_raw_value(&reply).expect("a test reply serializes");
    ClaudeSessionListing {
        commands: read_claude_listed_command_rows(Some(&reply)),
        agents: Vec::new(),
    }
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

// Killed by starting the read for a live session, by dropping the listed description, by reading
// an empty hint as one, and by listing a tool server's prompt as a command.
#[rstest]
#[case::live(true)]
#[case::at_rest(false)]
#[tokio::test(start_paused = true)]
async fn a_live_session_lists_its_declaration_and_one_at_rest_its_read(#[case] is_live: bool) {
    let fixture = ScriptedDriver::new();
    let session_id = if is_live {
        let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
        let parts = fixture.driver.composed_parts().expect("composed");
        let live = parts
            .slots()
            .live_session(session_id)
            .expect("the session is live");
        parts.run_start.handshakes.observe_handshake_declaration(
            session_id,
            &live.provider_session_id,
            ClaudeHandshakeDeclaration {
                slash_commands: vec!["review".to_owned()],
                ..ClaudeHandshakeDeclaration::default()
            },
        );
        session_id
    } else {
        new_session_id()
    };
    let rows = listed_rows();
    // Read absent, not as a hint the entry's bounds would refuse and report.
    assert_eq!(rows.commands[0].argument_hint, None);
    fixture.starts.script_session_listing(rows);
    let asked = params(session_id);

    let listed = fixture
        .driver
        .list_provider_commands(asked.clone())
        .await
        .expect("the list reads");

    let entries = if is_live {
        vec![command("review", None)]
    } else {
        vec![
            command("review", Some("Review the diff")),
            ProviderCommandEntry::Prompt {
                name: text("list_prs"),
                description: Some(text("List PRs")),
                argument_hint: None,
                scope: None,
                enabled: None,
                binding: binding(),
                server: text("github"),
                title: None,
            },
        ]
    };
    assert_eq!(
        listed,
        ProviderCommandBindingGroup {
            run_id: asked.run_id,
            binding: asked.binding,
            entries,
        }
    );
    assert_eq!(
        fixture.starts.take_session_listing_read_count(),
        usize::from(!is_live)
    );
}

// Killed by a resting read that starts a process per caller, and by one held after it settles,
// which a later read would answer from.
#[tokio::test(start_paused = true)]
async fn concurrent_resting_reads_share_one_process_and_none_is_kept() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let release = fixture.starts.hold_next_session_listing_read();
    fixture.starts.script_session_listing(listed_rows());
    fixture.starts.script_session_listing(listed_rows());
    let asked = params(session_id);

    let mut first = pin!(fixture.driver.list_provider_commands(asked.clone()));
    let mut second = pin!(fixture.driver.list_provider_commands(asked.clone()));
    assert!(futures::poll!(first.as_mut()).is_pending());
    assert!(futures::poll!(second.as_mut()).is_pending());
    release.send(()).expect("the held read waits");
    let first = first.await.expect("the first read answers");
    let second = second.await.expect("the second read answers");

    assert_eq!(first, second);
    assert_eq!(fixture.starts.take_session_listing_read_count(), 1);

    let third = fixture
        .driver
        .list_provider_commands(asked)
        .await
        .expect("the third read answers");

    assert_eq!(third.entries, first.entries);
    assert_eq!(fixture.starts.take_session_listing_read_count(), 1);
}
