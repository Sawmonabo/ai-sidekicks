use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandEntry, ProviderCommandListResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    CodexCommandSource, CodexProviderCommandCache, CodexSkillRejection, read_codex_skill_listing,
};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::port::registration::PortRegistration;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// A listed skill's name, description, scope and switch.
type SkillFields<'entry> = (
    &'entry str,
    Option<&'entry str>,
    Option<&'entry str>,
    Option<bool>,
);

fn skills_reply(names: &[&str]) -> Value {
    let skills: Vec<Value> = names
        .iter()
        .map(|name| json!({"name": name, "path": format!("/skills/{name}/SKILL.md")}))
        .collect();
    json!({"data": [{"cwd": "/work", "skills": skills}]})
}

fn listed_names(list: &ProviderCommandListResponse) -> Vec<String> {
    list.bindings
        .as_slice()
        .iter()
        .flat_map(|group| &group.entries)
        .map(|entry| {
            let entry = serde_json::to_value(entry).expect("an entry writes as JSON");
            entry["name"]
                .as_str()
                .expect("every entry has a name")
                .to_owned()
        })
        .collect()
}

async fn next_skills_request(scripted: &mut ScriptedCodexService) -> Value {
    let request = scripted.script.next_sent().await;
    assert_eq!(request["method"], "skills/list", "{request}");
    request
}

// Fails when a `skills/list` read before Codex's skills changed is kept once it lands after the
// read that followed the change: a generation counted again from the start for each session, or
// one the change does not end, keeps the stale listing.
#[tokio::test]
async fn a_skills_refresh_never_stores_a_listing_read_before_the_change() {
    let mut scripted = start_scripted_codex_service();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let source = CodexCommandSource {
        session_id,
        service: Arc::clone(&scripted.service),
        provider_account_id: None,
        working_directory: "/work".to_owned(),
        run_id: None,
    };
    let lookup_source = source.clone();
    let cache = CodexProviderCommandCache::new(
        Arc::new(PortRegistration::new("server prompts")),
        Arc::new(move |_session_id| Some(lookup_source.clone())),
    );
    let compose = |cache: &Arc<CodexProviderCommandCache>| {
        let cache = Arc::clone(cache);
        let source = source.clone();
        tokio::spawn(async move {
            cache
                .compose_provider_command_list(&source)
                .await
                .expect("the list composes")
        })
    };

    let before_change = compose(&cache);
    let read_before_change = next_skills_request(&mut scripted).await;
    cache.refresh(session_id);
    let after_change = compose(&cache);
    let read_after_change = next_skills_request(&mut scripted).await;
    scripted
        .script
        .answer(&read_after_change, &skills_reply(&["new-skill"]));
    let after_change = after_change.await.expect("the read ends");
    scripted
        .script
        .answer(&read_before_change, &skills_reply(&["old-skill"]));
    let before_change = before_change.await.expect("the read ends");
    let held = compose(&cache).await.expect("the read ends");

    assert_eq!(listed_names(&before_change), ["old-skill"]);
    assert_eq!(listed_names(&after_change), ["new-skill"]);
    assert_eq!(listed_names(&held), ["new-skill"]);
    assert!(
        scripted.script.sent.try_recv().is_err(),
        "the held listing was read again"
    );
}

// Fails when a skill whose name the contract refuses is kept, a refused description or scope
// drops its skill, a blank description reads as refused, a skill with no file is offered to
// pick, or a reply with no list reads as no skills.
#[test]
fn a_codex_skill_listing_keeps_what_the_contract_takes_and_records_each_refusal() {
    let reply = json!({"data": [
        {"skills": [
            {"name": "review", "path": "/skills/review/SKILL.md", "description": "Reviews",
                "scope": "user", "enabled": false},
            {"name": "x".repeat(10_000), "path": "/skills/long/SKILL.md"},
            "not a skill",
        ]},
        {"skills": [
            {"name": "plain", "description": "  ", "scope": 7},
            {"name": "wordy", "path": "/skills/wordy/SKILL.md", "description": "y".repeat(100_000)},
        ]},
    ]});

    let reading = read_codex_skill_listing(&reply, None).expect("the reply has a list");
    let no_list = read_codex_skill_listing(&json!({"skills": []}), None);

    let entries: Vec<SkillFields<'_>> = reading
        .listing
        .entries
        .iter()
        .map(|entry| match entry {
            ProviderCommandEntry::Skill {
                name,
                description,
                scope,
                enabled,
                ..
            } => (
                name.as_str(),
                description.as_ref().map(FreeFormText::as_str),
                scope.as_ref().map(FreeFormText::as_str),
                *enabled,
            ),
            ProviderCommandEntry::Command { .. } | ProviderCommandEntry::Prompt { .. } => {
                unreachable!("a skill list holds only skills")
            }
        })
        .collect();
    assert_eq!(
        entries,
        [
            ("review", Some("Reviews"), Some("user"), Some(false)),
            ("plain", None, None, None),
            ("wordy", None, None, None),
        ]
    );
    let skill_files: Vec<(&str, &str)> = reading
        .listing
        .skill_files
        .iter()
        .map(|skill| (skill.name.as_str(), skill.path.as_str()))
        .collect();
    assert_eq!(
        skill_files,
        [
            ("review", "/skills/review/SKILL.md"),
            ("wordy", "/skills/wordy/SKILL.md"),
        ]
    );
    assert_eq!(
        reading.rejections,
        [
            CodexSkillRejection::Name {
                name_length: Some(10_000)
            },
            CodexSkillRejection::NotAnObject,
            CodexSkillRejection::Scope {
                name_length: Some(5),
                value_length: None
            },
            CodexSkillRejection::Description {
                name_length: Some(5),
                value_length: Some(100_000)
            },
        ]
    );
    assert!(no_list.is_err());
}
