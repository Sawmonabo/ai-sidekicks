//! `session_list`'s handler: every session in the directory, the hosted ones with what each is
//! doing, its group and the person's last message to it read in one statement, one line each.
//! `session_search` prints its hits with the same lines.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::named_params;
use sidekicks_agent::tools::session::list::{
    EMPTY, SessionListArguments, SessionListLine, SessionListState,
};
use sidekicks_contracts::attention::AttentionTrigger;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::session::controls::methods::TerminalProviderSessionState;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::directory::run_activity::{WORKING_RUN_STATES, session_activity_sql};
use sidekicks_session::plan_holds::PlanHolds;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::schema::SESSION_EVENTS_TABLE;
use sidekicks_store::database::sql_list::sql_list_of;

use crate::agent_tools::AgentToolError;
use crate::orchestration::session_directory::{
    SessionDirectory, SessionDirectoryEntry, SessionOrigin,
};

/// The one read of the hosted sessions' list facts, its statement composed once with the
/// condition under which a session reads as waiting on a plan's card.
pub(crate) struct SessionLineReads {
    pool: Arc<DatabaseReadPool>,
    facts_sql: String,
}

/// One session as the reading tools name it: its directory entry, its group, and its line.
pub(crate) struct ListedSession {
    /// The session's directory entry.
    pub(crate) entry: SessionDirectoryEntry,
    /// The name of its group; `None` outside a group.
    pub(crate) group: Option<String>,
    /// The session as `session_list` prints it.
    pub(crate) line: SessionListLine,
}

// One hosted session's list facts as the statement reads them.
struct HostedFacts {
    group: Option<String>,
    first_message_preview: Option<String>,
    last_message: Option<String>,
    // The working run's newest tool, else its state; `None` unless the session is working.
    doing: Option<String>,
    // The open ask's trigger, empty for a plan's card; `None` unless the session waits.
    waiting_on: Option<String>,
}

impl SessionLineReads {
    /// The read on `pool`, a session reading waiting while `plan_holds` has a plan of its waiting.
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, plan_holds: &dyn PlanHolds) -> Self {
        let events = SESSION_EVENTS_TABLE;
        let working = sql_list_of(WORKING_RUN_STATES.iter().map(<&'static str>::from));
        let asks = sql_list_of(
            [
                AttentionTrigger::PendingApproval,
                AttentionTrigger::PendingInput,
            ]
            .iter()
            .map(<&'static str>::from),
        );
        let user_message = SessionEventType::UserMessageSent.as_str();
        let tool_call = SessionEventType::AgentToolCallInvoked.as_str();
        let running = <&'static str>::from(SessionActivity::Running);
        let waiting = <&'static str>::from(SessionActivity::Waiting);
        let facts_sql = format!(
            "WITH facts AS (
               SELECT s.id AS id, {activity} AS activity, g.name AS group_name,
                      s.first_message_preview AS preview,
                      (SELECT CASE WHEN json_valid(event.payload)
                                   THEN json_extract(event.payload, '$.message') END
                         FROM {events} AS event
                        WHERE event.session_id = s.id AND event.type = '{user_message}'
                        ORDER BY event.sequence DESC LIMIT 1) AS last_message
                 FROM json_each(@sessionIds) AS wanted
                 JOIN sessions AS s ON s.id = wanted.value
                 LEFT JOIN session_groups AS g ON g.id = s.group_id)
             SELECT facts.id, facts.group_name, facts.preview, facts.last_message,
                    CASE WHEN facts.activity = '{running}' THEN COALESCE(
                      (SELECT CASE WHEN json_valid(event.payload)
                                   THEN json_extract(event.payload, '$.toolName') END
                         FROM runs
                         JOIN {events} AS event
                           ON event.session_id = runs.session_id AND event.run_id = runs.run_id
                        WHERE runs.session_id = facts.id AND runs.state IN ({working})
                          AND event.type = '{tool_call}'
                        ORDER BY event.sequence DESC LIMIT 1),
                      (SELECT runs.state FROM runs
                        WHERE runs.session_id = facts.id AND runs.state IN ({working}) LIMIT 1))
                    END,
                    CASE WHEN facts.activity = '{waiting}' THEN COALESCE(
                      (SELECT entry.trigger FROM attention_entries AS entry
                        WHERE entry.session_id = facts.id AND entry.resolved_at IS NULL
                          AND entry.trigger IN ({asks})
                        ORDER BY entry.created_at DESC LIMIT 1), '')
                    END
               FROM facts",
            activity = session_activity_sql(
                "s.id",
                "s.last_run_outcome",
                &plan_holds.waiting_plan_sql("s.id")
            ),
        );
        Self { pool, facts_sql }
    }

    // The facts of each hosted session among `session_ids` that still has a row, by id.
    async fn read_facts(
        &self,
        session_ids: Vec<String>,
    ) -> Result<HashMap<String, HostedFacts>, AgentToolError> {
        let facts_sql = self.facts_sql.clone();
        let session_ids = serde_json::to_string(&session_ids).map_err(AgentToolError::failed)?;
        let read = self.pool.read(ReadLength::Long, move |reader| {
            reader
                .prepare_cached(&facts_sql)?
                .query_map(named_params! { "@sessionIds": session_ids }, |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        HostedFacts {
                            group: row.get(1)?,
                            first_message_preview: row.get(2)?,
                            last_message: row.get(3)?,
                            doing: row.get(4)?,
                            waiting_on: row.get(5)?,
                        },
                    ))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()
                .map_err(AgentToolError::from)
        });
        read.await
    }
}

/// Every session in `directory` as it is now, in its order, each with its line for a call
/// `caller` makes. Fails as the directory's read, a provider's lookup or the facts' read fails.
pub(crate) async fn read_listed_sessions(
    directory: &SessionDirectory,
    line_reads: &SessionLineReads,
    providers: &ProviderRegistry,
    caller: &SessionId,
) -> Result<Vec<ListedSession>, AgentToolError> {
    let entries = directory
        .read_entries()
        .await
        .map_err(AgentToolError::failed)?;
    let hosted_ids = entries
        .iter()
        .filter(|entry| entry.origin == SessionOrigin::Hosted)
        .map(|entry| entry.id.clone())
        .collect();
    let mut facts = line_reads.read_facts(hosted_ids).await?;
    let caller_id = caller.to_string();
    entries
        .into_iter()
        .map(|entry| {
            let provider = providers
                .descriptor(&entry.provider)
                .map_err(AgentToolError::failed)?
                .name();
            let facts = facts.remove(&entry.id);
            let group = facts.as_ref().and_then(|facts| facts.group.clone());
            let line = line_of(&entry, provider, facts);
            let line = SessionListLine {
                is_calling_session: entry.id == caller_id,
                ..line
            };
            Ok(ListedSession { entry, group, line })
        })
        .collect()
}

// A session's line from its entry and, for a hosted one, its facts.
fn line_of(
    entry: &SessionDirectoryEntry,
    provider: &str,
    facts: Option<HostedFacts>,
) -> SessionListLine {
    let (state, last_message, preview) = match facts {
        None => (terminal_state_of(entry.origin), None, None),
        Some(facts) => (
            state_of(facts.doing, facts.waiting_on),
            facts.last_message.map(|message| one_line(&message)),
            facts.first_message_preview,
        ),
    };
    SessionListLine {
        name: entry
            .name
            .clone()
            .or(preview)
            .unwrap_or_else(|| entry.id.clone()),
        id: entry.id.clone(),
        provider: provider.to_owned(),
        model: entry.model.clone(),
        project: entry.project.clone(),
        computer: entry.computer.to_string(),
        state,
        last_message,
        is_calling_session: false,
    }
}

// What a session typed in a terminal is doing, as the provider's shared service reports it; one
// the service does not hold or answer for reads idle.
fn terminal_state_of(origin: SessionOrigin) -> SessionListState {
    match origin {
        SessionOrigin::TypedInTerminal {
            shared_service_state: Some(TerminalProviderSessionState::Working),
        } => SessionListState::Working {
            doing: "a turn in its terminal".to_owned(),
        },
        SessionOrigin::Hosted
        | SessionOrigin::TypedInTerminal {
            shared_service_state:
                None
                | Some(TerminalProviderSessionState::Idle | TerminalProviderSessionState::Unreachable),
        } => SessionListState::Idle,
    }
}

// What the session is doing from what its working run does or what it waits on.
fn state_of(doing: Option<String>, waiting_on: Option<String>) -> SessionListState {
    if let Some(doing) = doing {
        return SessionListState::Working { doing };
    }
    let Some(trigger) = waiting_on else {
        return SessionListState::Idle;
    };
    let what = if trigger == <&'static str>::from(AttentionTrigger::PendingApproval) {
        "an approval"
    } else if trigger == <&'static str>::from(AttentionTrigger::PendingInput) {
        "a question"
    } else {
        "a plan"
    };
    SessionListState::WaitingOnPerson {
        what: what.to_owned(),
    }
}

// A message on one line, cut to a session name's length, so a line stays one line.
fn one_line(message: &str) -> String {
    let flattened: String = message.split_whitespace().collect::<Vec<_>>().join(" ");
    match flattened.char_indices().nth(SESSION_NAME_MAX_LEN) {
        Some((cut, _)) => format!("{}…", &flattened[..cut]),
        None => flattened,
    }
}

/// `session_list` for a call `caller` makes: the sessions `arguments` narrows to, one line each,
/// or [`EMPTY`] when none is listed but the caller's. Fails as [`read_listed_sessions`] does.
pub(crate) async fn list_sessions(
    directory: &SessionDirectory,
    line_reads: &SessionLineReads,
    providers: &ProviderRegistry,
    caller: &SessionId,
    arguments: SessionListArguments,
) -> Result<String, AgentToolError> {
    let is_archived = arguments.archived.unwrap_or(false);
    let group = arguments.group.map(|group| fold_name(group.as_str()));
    let project = arguments.project.map(|project| fold_name(project.as_str()));
    let is_named = |name: Option<&str>, wanted: Option<&str>| {
        wanted.is_none_or(|wanted| name.is_some_and(|name| fold_name(name) == wanted))
    };
    let listed: Vec<ListedSession> = read_listed_sessions(directory, line_reads, providers, caller)
        .await?
        .into_iter()
        .filter(|session| session.entry.is_archived == is_archived)
        .filter(|session| is_named(session.group.as_deref(), group.as_deref()))
        .filter(|session| is_named(session.entry.project.as_deref(), project.as_deref()))
        .collect();
    if listed.iter().all(|session| session.line.is_calling_session) {
        return Ok(EMPTY.to_owned());
    }
    let lines: Vec<String> = listed
        .iter()
        .map(|session| session.line.to_string())
        .collect();
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use sidekicks_agent::tools::session::list::SessionListArguments;
    use sidekicks_artifact::plans::store::StoredPlanHolds;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::test_registry::registry_of_first_providers;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_session_id,
    };

    use super::{SessionLineReads, list_sessions};
    use crate::daemon::schema::schema_parts;
    use crate::orchestration::session_directory::SessionDirectory;

    // A session on each provider is listed with its own provider's name, the caller's marked.
    // Killed by listing one provider's sessions only, or naming every session by one provider.
    #[tokio::test]
    async fn session_list_names_a_session_of_the_other_provider() {
        let database = TestDatabase::new(schema_parts());
        let reader = database.opener()().expect("the test creates its database");
        reader
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
                 VALUES (1, ?1, ?2, 'this Mac', ?3)",
                [
                    mint_uuid_v7().to_string(),
                    mint_uuid_v7().to_string(),
                    WireInstant::now().as_str().to_owned(),
                ],
            )
            .expect("the test records this machine");
        let planner: SessionId = test_session_id();
        insert_session_row(&reader, planner.text().as_str(), Some("planner"), None);
        insert_lead(&database, planner, PROVIDERS[0].id);
        let reviewer: SessionId = test_session_id();
        insert_session_row(&reader, reviewer.text().as_str(), Some("reviewer"), None);
        insert_lead(&database, reviewer, PROVIDERS[1].id);

        let drivers = [MockProviderDriver::new(), MockProviderDriver::new()].map(|mut driver| {
            driver
                .expect_list_terminal_sessions()
                .returning(|| async { Ok(Vec::new()) }.boxed());
            driver
                .expect_list_standalone_terminal_sessions()
                .returning(|| async { Ok(Vec::new()) }.boxed());
            Arc::new(driver) as Arc<dyn ProviderDriver>
        });
        let pool = Arc::new(DatabaseReadPool::new(database.path(), 8));
        let providers = Arc::new(registry_of_first_providers(Vec::from(drivers)));
        let directory = SessionDirectory {
            pool: Arc::clone(&pool),
            providers: Arc::clone(&providers),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        };
        let line_reads = SessionLineReads::new(pool, &StoredPlanHolds);
        let arguments = SessionListArguments {
            group: None,
            project: None,
            archived: None,
        };

        let listed = list_sessions(&directory, &line_reads, &providers, &planner, arguments)
            .await
            .expect("the list reads");
        assert_eq!(
            listed,
            format!(
                "planner · {planner} · {} test-model · this Mac · this session\n\
                 reviewer · {reviewer} · {} test-model · this Mac · idle",
                PROVIDERS[0].name(),
                PROVIDERS[1].name(),
            )
        );
    }
}
