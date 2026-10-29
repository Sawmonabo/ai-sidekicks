use sidekicks_contracts::attention::provider_build::{
    AttentionProviderBuild, AttentionProviderBuildItem, ProviderBuildTrigger, WithheldBannerState,
};
use sidekicks_contracts::attention::{
    AttentionItem, AttentionSubscribeRequest, AttentionSubscribeScope, InformationalSeverity,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::settings::PROVIDER_VERSION_MAX_LEN;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::build_record::{RecordedProviderBuild, record_statements};
use sidekicks_store::database::schema::session_directory::insert_session_row;

use super::{provider_build_moment_id, record_change_statements};
use crate::attention::read::read_attention_projection;
use crate::attention::test_log::AttentionTestLog;

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a provider id")
}

fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("a test instant")
}

fn text(text: &str) -> NonEmptyText {
    NonEmptyText::new(text.to_owned()).expect("a test text")
}

fn version(text: &str) -> FreeFormText<PROVIDER_VERSION_MAX_LEN> {
    FreeFormText::new(text.to_owned()).expect("a test version")
}

/// Records `build` through the record's own write, carrying the projection's bump.
async fn record(log: &AttentionTestLog, build: RecordedProviderBuild) {
    log.writer
        .write(record_statements(&build, &record_change_statements))
        .await
        .expect("the build is recorded");
}

fn machine_version(log: &AttentionTestLog) -> i64 {
    log.database
        .reader()
        .query_row(
            "SELECT version FROM attention_versions WHERE scope_key = ''",
            [],
            |row| row.get(0),
        )
        .expect("the machine's count has a row")
}

// The whole projection lists each recorded build as the third arm, the address only on a build
// moved to and minted from the new build, and no read narrowed by a session holds one. Killed by
// the session filter missing from a narrowed read, by the address minted from `fromVersion`, by an
// address on an available build, and by a record write that bumps no count.
#[tokio::test]
async fn the_whole_projection_lists_each_recorded_build_and_a_sessions_read_none() {
    let log = AttentionTestLog::new().await;
    insert_session_row(
        &log.database.reader(),
        log.session_id.text().as_str(),
        Some("Release notes"),
        None,
    );
    let claude = provider("claude");
    let codex = provider("codex");
    record(
        &log,
        RecordedProviderBuild {
            provider: claude.clone(),
            version: "2.1.294".to_owned(),
            from_version: Some("2.1.293".to_owned()),
            recorded_at: instant("2026-10-28T12:00:00.000Z"),
        },
    )
    .await;
    record(
        &log,
        RecordedProviderBuild {
            provider: codex.clone(),
            version: "0.163.0".to_owned(),
            from_version: None,
            recorded_at: instant("2026-10-28T11:00:00.000Z"),
        },
    )
    .await;
    assert_eq!(
        machine_version(&log),
        2,
        "each record write wakes the followers"
    );

    let whole = read_attention_projection(
        &log.database.reader(),
        &AttentionSubscribeRequest {
            session_id: None,
            scope: None,
            run_id: None,
        },
    )
    .expect("the whole projection reads");
    let claude_id = provider_build_moment_id(&claude, "2.1.294");
    let codex_id = provider_build_moment_id(&codex, "0.163.0");
    assert_eq!(
        whole.items,
        vec![
            AttentionItem::ProviderBuild(AttentionProviderBuildItem {
                id: claude_id.clone(),
                moment_id: claude_id,
                trigger: ProviderBuildTrigger::Value,
                severity: InformationalSeverity::Value,
                display_name: text("Claude Code"),
                state_word: text("updated · 2.1.293 → 2.1.294"),
                provider_build: AttentionProviderBuild {
                    provider: claude,
                    from_version: Some(version("2.1.293")),
                    to_version: version("2.1.294"),
                    release_notes_address: HttpsAddress::new(
                        "https://code.claude.com/docs/en/changelog#2-1-294"
                    ),
                },
                created_at: instant("2026-10-28T12:00:00.000Z"),
                banner_state: WithheldBannerState::Value,
            }),
            AttentionItem::ProviderBuild(AttentionProviderBuildItem {
                id: codex_id.clone(),
                moment_id: codex_id,
                trigger: ProviderBuildTrigger::Value,
                severity: InformationalSeverity::Value,
                display_name: text("Codex"),
                state_word: text("0.163.0 available"),
                provider_build: AttentionProviderBuild {
                    provider: codex,
                    from_version: None,
                    to_version: version("0.163.0"),
                    release_notes_address: None,
                },
                created_at: instant("2026-10-28T11:00:00.000Z"),
                banner_state: WithheldBannerState::Value,
            }),
        ]
    );

    for scope in [None, Some(AttentionSubscribeScope::Session)] {
        let narrowed = read_attention_projection(
            &log.database.reader(),
            &AttentionSubscribeRequest {
                session_id: Some(log.session_id),
                scope,
                run_id: None,
            },
        )
        .expect("the session's projection reads");
        assert_eq!(narrowed.items, Vec::new(), "scope {scope:?}");
    }
}
