use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionReadRequest;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_test_event, test_session_id,
};

use super::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use crate::agents::projection::test_fixture::{
    binding, binding_changed, project, resolved_run_queued, session_created,
};
use crate::questions::schema::schema_parts;

/// The session's lead, on `claude` until a move in the log takes it off.
const LEAD: &str = "019a0000-0000-7000-8000-000000000002";

/// A second agent of the session, on `codex` until a move in the log takes it off.
const REVIEWER: &str = "019a0000-0000-7000-8000-000000000003";

/// A session with the lead on `claude` and the reviewer on `codex`, whose log holds `notices`,
/// each a `session.notice.posted` payload but its session, or a whole event where it names its
/// `type`, in order, a binding change also moving its agent; answers the notice payloads of its
/// read's standing events, in sequence order.
async fn standing_notices(notices: &[Value]) -> Vec<Value> {
    let database =
        TestDatabase::new(schema_parts().with_parts(crate::agents::schema::schema_parts()));
    let session_id = test_session_id();
    let writer = database.opener()().expect("the test creates its database");
    insert_session_row(&writer, session_id.text().as_str(), None, None);
    project(
        &writer,
        session_id,
        &session_created(session_id, LEAD, &binding("claude", "model-a")),
    );
    project(
        &writer,
        session_id,
        &resolved_run_queued(
            session_id,
            "019a0000-0000-7000-8000-000000000004",
            REVIEWER,
            &binding("codex", "model-a"),
        ),
    );
    for notice in notices {
        let event = if notice.get("type").is_some() {
            let mut event = notice.clone();
            event["payload"]["sessionId"] = json!(session_id);
            if event["type"] == "agent.providerBinding.changed" {
                let moved: SessionEvent =
                    serde_json::from_value(event.clone()).expect("the move reads as its event");
                project(&writer, session_id, &moved);
            }
            event
        } else {
            let mut payload = notice.clone();
            payload["sessionId"] = json!(session_id);
            json!({ "type": "session.notice.posted", "payload": payload })
        };
        insert_test_event(&writer, session_id, event, None, "2026-11-09T09:00:00.000Z");
    }
    let read = SessionService::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_SERVICE_STATEMENT_CAPACITY,
        )),
        Arc::new(|_: &SessionId| None),
        Arc::new(|_: &ProviderId| None),
    )
    .read_session(SessionReadRequest { session_id })
    .await
    .expect("the session reads");
    read.standing_events
        .into_iter()
        .filter(|standing| standing.event.event_type.as_str() == "session.notice.posted")
        .map(|standing| {
            let mut payload = standing.event.payload;
            payload.remove("sessionId");
            Value::Object(payload)
        })
        .collect()
}

fn crash_loop(provider: &str) -> Value {
    json!({ "kind": "providerCrashLoop", "provider": provider, "exitCode": 1 })
}

fn ignored_at_line(file: &str, line: u32) -> Value {
    json!({ "kind": "settingsIgnored", "provider": "codex", "file": file, "line": line })
}

fn ignored_at_key(file: &str, key: &str) -> Value {
    json!({ "kind": "settingsIgnored", "provider": "claude", "file": file, "key": key })
}

/// A crash loop stands until the restart, the build move or the new start's reading that ends it,
/// per provider, and a later crash loop draws it again; a reading of one file ends none. Killed by
/// dropping the crash-loop arm, by keeping the newest row of either kind, by grouping across
/// providers, by a build move or a new start's reading that leaves the loop standing, and by a
/// file's clean load that ends it.
#[tokio::test]
async fn a_crash_loop_stands_until_its_restart() {
    let restarted = json!({ "kind": "providerRestarted", "provider": "codex" });
    let moved = json!({
        "kind": "providerUpdated",
        "provider": "codex",
        "fromVersion": "0.166.0",
        "toVersion": "0.167.0",
    });
    let started = json!({ "kind": "settingsLoaded", "provider": "codex" });
    let file_loaded =
        json!({ "kind": "settingsLoaded", "provider": "codex", "file": "/c/config.toml" });
    // The build move ends the loop and stands itself until a send.
    assert_eq!(
        standing_notices(&[crash_loop("codex"), moved.clone()]).await,
        [moved]
    );
    assert_eq!(
        standing_notices(&[crash_loop("codex"), started]).await,
        Vec::<Value>::new()
    );
    assert_eq!(
        standing_notices(&[crash_loop("codex"), file_loaded]).await,
        [crash_loop("codex")]
    );
    assert_eq!(
        standing_notices(&[crash_loop("codex"), crash_loop("claude"), restarted.clone(),]).await,
        [crash_loop("claude")]
    );
    assert_eq!(
        standing_notices(&[crash_loop("codex"), restarted, crash_loop("codex")]).await,
        [crash_loop("codex")]
    );
}

/// The newest ignored-settings notice per provider and file stands; a clean load of its file ends
/// it, and a new start's reading ends every earlier one of its provider while what it posts again
/// stands. Killed by grouping by provider alone, by a clean load of one file ending another, by a
/// reading of one provider ending another's, and by an ending row before the notice counting.
#[tokio::test]
async fn an_ignored_settings_notice_stands_until_its_file_loads_cleanly() {
    let config = "/home/a/.codex/config.toml";
    let project = "/work/.codex/config.toml";
    let settings = "/work/.claude/settings.json";
    let clean = |provider: &str, file: Option<&str>| {
        let mut loaded = json!({ "kind": "settingsLoaded", "provider": provider });
        if let Some(file) = file {
            loaded["file"] = json!(file);
        }
        loaded
    };
    assert_eq!(
        standing_notices(&[
            clean("codex", Some(config)),
            ignored_at_line(config, 3),
            ignored_at_line(project, 7),
            ignored_at_line(config, 4),
            ignored_at_key(settings, "permissions.defaultMode"),
        ])
        .await,
        [
            ignored_at_line(project, 7),
            ignored_at_line(config, 4),
            ignored_at_key(settings, "permissions.defaultMode"),
        ]
    );
    assert_eq!(
        standing_notices(&[
            ignored_at_line(config, 4),
            ignored_at_line(project, 7),
            ignored_at_key(settings, "permissions.defaultMode"),
            clean("codex", Some(project)),
        ])
        .await,
        [
            ignored_at_line(config, 4),
            ignored_at_key(settings, "permissions.defaultMode"),
        ]
    );
    assert_eq!(
        standing_notices(&[
            ignored_at_line(config, 4),
            ignored_at_line(project, 7),
            ignored_at_key(settings, "permissions.defaultMode"),
            clean("codex", None),
            ignored_at_line(project, 7),
        ])
        .await,
        [
            ignored_at_key(settings, "permissions.defaultMode"),
            ignored_at_line(project, 7),
        ]
    );
}

/// An ignored-settings notice, which names no agent, stands while an agent of the session is on its
/// provider: the last one moving off ends it, another still on it keeps it, and a move back shows
/// it again. Killed by any move off the provider ending it, by a move between other providers
/// counting, and by a move off that ends it for good.
#[tokio::test]
async fn an_ignored_settings_notice_ends_when_no_agent_is_left_on_its_provider() {
    let settings = "/work/.claude/settings.json";
    let config = "/home/a/.codex/config.toml";
    let moved = |agent_id: &str, switch_id: &str, from: &str, to: &str| {
        serde_json::to_value(binding_changed(
            test_session_id(),
            agent_id,
            switch_id,
            &binding(from, "model-a"),
            &binding(to, "model-b"),
            "account-1",
        ))
        .expect("the move serializes")
    };
    let ignored = ignored_at_key(settings, "permissions.defaultMode");
    assert_eq!(
        standing_notices(&[ignored.clone(), moved(LEAD, "switch-1", "claude", "codex")]).await,
        Vec::<Value>::new()
    );
    assert_eq!(
        standing_notices(&[
            ignored.clone(),
            moved(REVIEWER, "switch-1", "codex", "other")
        ])
        .await,
        std::slice::from_ref(&ignored)
    );
    assert_eq!(
        standing_notices(&[
            ignored.clone(),
            moved(LEAD, "switch-1", "claude", "codex"),
            moved(LEAD, "switch-2", "codex", "claude"),
        ])
        .await,
        [ignored]
    );
    let ignored = ignored_at_line(config, 4);
    assert_eq!(
        standing_notices(&[
            ignored.clone(),
            moved(LEAD, "switch-1", "claude", "codex"),
            moved(LEAD, "switch-2", "codex", "claude"),
        ])
        .await,
        [ignored]
    );
}

/// A build move stands until the next message is sent, and each distinct provider warning stands
/// once. Killed by dropping either arm and by the send not ending the move.
#[tokio::test]
async fn a_build_move_stands_until_a_send_and_each_warning_once() {
    let moved = json!({
        "kind": "providerUpdated",
        "provider": "codex",
        "fromVersion": "0.166.0",
        "toVersion": "0.167.0",
    });
    let warning = json!({ "kind": "providerWarning", "source": "warning", "text": "Slow disk" });
    let sent = json!({
        "type": "user.message.sent",
        "payload": { "actor": "person", "message": "Go on" },
    });
    assert_eq!(
        standing_notices(&[moved.clone(), warning.clone(), warning.clone()]).await,
        [moved.clone(), warning.clone()]
    );
    assert_eq!(
        standing_notices(&[moved, warning.clone(), sent]).await,
        [warning]
    );
}
