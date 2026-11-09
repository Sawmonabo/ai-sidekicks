//! A helper of a session's agent tree found by what a tool call names, its id, its name or its
//! path in its provider's tree, with its newest own run's state and stop trigger, for the drivers'
//! hooks through [`StoredAgentTreeLookup`].

use std::error::Error;
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension as _, Row, ToSql, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use crate::agent_tree::read::{held_stop_exists_sql, own_run_state_with_held_stop};
use crate::agent_tree::store::read_child_handle;

/// The statements the agent tree lookup keeps prepared: one per way a helper is named.
pub const AGENT_TREE_LOOKUP_STATEMENT_CAPACITY: usize = 3;

// A node with its own run's state, the trigger of that run's newest stop, and whether a helper
// stop of the session names that run as the helper's own, in the order `helper_of_row` reads them,
// filtered by `filter`. The unary `+` drops the node's run id column's affinity, which would keep
// the log's run index from serving.
fn select_helpers_sql(filter: &str) -> String {
    let stopped = SessionEventType::AgentRunStopped;
    format!(
        "SELECT n.child_handle, n.subagent_id, n.provider_path, n.own_run_id, r.state,
    (SELECT json_extract(e.payload, '$.trigger') FROM session_events AS e
      WHERE e.session_id = n.session_id AND e.run_id = +n.own_run_id
        AND e.category = '{category}' AND e.type = '{stopped_type}'
      ORDER BY e.sequence DESC LIMIT 1),
    {held_stop}
  FROM agent_tree_nodes AS n JOIN runs AS r ON r.run_id = n.own_run_id
  {filter}",
        category = stopped.category().as_str(),
        stopped_type = stopped.as_str(),
        held_stop = held_stop_exists_sql("n.session_id", "n.own_run_id"),
    )
}

// The provider's own key, which holds one node at most.
static SELECT_HELPER_BY_SUBAGENT_ID_SQL: LazyLock<String> = LazyLock::new(|| {
    select_helpers_sql(
        "WHERE n.session_id = @sessionId AND n.provider_name = @providerName
    AND n.subagent_id = @subagentId",
    )
});

// Several nodes may share a name; the newest-bound one wins.
static SELECT_HELPER_BY_NAME_SQL: LazyLock<String> = LazyLock::new(|| {
    select_helpers_sql(
        "WHERE n.session_id = @sessionId AND n.name = @name
  ORDER BY n.updated_at DESC, n.child_handle DESC LIMIT 1",
    )
});

// Several nodes may share a path; the newest-bound one wins.
static SELECT_HELPER_BY_PROVIDER_PATH_SQL: LazyLock<String> = LazyLock::new(|| {
    select_helpers_sql(
        "WHERE n.session_id = @sessionId AND n.provider_path = @providerPath
  ORDER BY n.updated_at DESC, n.child_handle DESC LIMIT 1",
    )
});

// A helper whose own run a held stop folds to stopped reads as stopped by a stop of every agent.
fn helper_of_row(row: &Row<'_>) -> rusqlite::Result<AgentTreeHelper> {
    let stored_state = text_column(row, 4, closed_word::<RunState>)?;
    let own_run_state = own_run_state_with_held_stop(stored_state, row.get(6)?);
    let own_run_stop_trigger = if own_run_state == stored_state {
        optional_text_column(row, 5, closed_word::<StopTrigger>)?
    } else {
        Some(StopTrigger::StopAll)
    };
    Ok(AgentTreeHelper {
        child_handle: text_column(row, 0, read_child_handle)?,
        subagent_id: row.get(1)?,
        provider_path: row.get(2)?,
        own_run_id: text_column(row, 3, |text| RunId::new(&text))?,
        own_run_state,
        own_run_stop_trigger,
    })
}

// The one helper `sql` finds with `params`, or `None`. Fails when SQLite refuses the read or a
// stored column does not read as its type, an unknown stop trigger among them.
fn read_helper(
    reader: &Connection,
    sql: &str,
    params: &[(&str, &dyn ToSql)],
) -> rusqlite::Result<Option<AgentTreeHelper>> {
    reader
        .prepare_cached(sql)?
        .query_row(params, helper_of_row)
        .optional()
}

fn read_helper_by_subagent_id(
    reader: &Connection,
    session_id: SessionId,
    provider_name: &ProviderId,
    subagent_id: &str,
) -> rusqlite::Result<Option<AgentTreeHelper>> {
    read_helper(
        reader,
        &SELECT_HELPER_BY_SUBAGENT_ID_SQL,
        named_params! {
            "@sessionId": session_id.text().as_str(),
            "@providerName": provider_name.as_str(),
            "@subagentId": subagent_id,
        },
    )
}

fn read_helper_by_name(
    reader: &Connection,
    session_id: SessionId,
    name: &str,
) -> rusqlite::Result<Option<AgentTreeHelper>> {
    read_helper(
        reader,
        &SELECT_HELPER_BY_NAME_SQL,
        named_params! { "@sessionId": session_id.text().as_str(), "@name": name },
    )
}

fn read_helper_by_provider_path(
    reader: &Connection,
    session_id: SessionId,
    provider_path: &str,
) -> rusqlite::Result<Option<AgentTreeHelper>> {
    read_helper(
        reader,
        &SELECT_HELPER_BY_PROVIDER_PATH_SQL,
        named_params! {
            "@sessionId": session_id.text().as_str(),
            "@providerPath": provider_path,
        },
    )
}

/// The session's agent tree as the drivers' hooks look a helper up in it, each lookup one short
/// read through the daemon's read pool.
pub struct StoredAgentTreeLookup {
    pool: Arc<DatabaseReadPool>,
}

impl StoredAgentTreeLookup {
    /// The lookups read through `pool`.
    pub fn new(pool: Arc<DatabaseReadPool>) -> Self {
        Self { pool }
    }
}

impl AgentTreeLookup for StoredAgentTreeLookup {
    fn helper_by_subagent_id(
        &self,
        session_id: SessionId,
        provider_name: ProviderId,
        subagent_id: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok(read_helper_by_subagent_id(
                    reader,
                    session_id,
                    &provider_name,
                    &subagent_id,
                )?)
            })
            .boxed()
    }

    fn helper_by_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok(read_helper_by_name(reader, session_id, &name)?)
            })
            .boxed()
    }

    fn helper_by_provider_path(
        &self,
        session_id: SessionId,
        provider_path: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok(read_helper_by_provider_path(
                    reader,
                    session_id,
                    &provider_path,
                )?)
            })
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::{Connection, params};
    use serde_json::json;
    use sidekicks_contracts::agent::tree::ChildHandle;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::control::StopTrigger;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::instant;
    use sidekicks_provider::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::statement::run_statement;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_test_event, test_run_id, test_session_id,
    };

    use super::{AGENT_TREE_LOOKUP_STATEMENT_CAPACITY, StoredAgentTreeLookup};
    use crate::agent_tree::schema::schema_parts;
    use crate::agent_tree::store::{NewAgentTreeNode, bind_newest_run, insert_node};

    const PROVIDER: &str = "test-provider";

    fn provider(name: &str) -> ProviderId {
        ProviderId::new(name.to_owned()).expect("a provider id")
    }

    fn handle(text: &str) -> ChildHandle {
        ChildHandle::new(text.to_owned()).expect("a child handle")
    }

    // Writes a run of `session_id` in `state`.
    fn insert_run(writer: &Connection, session_id: SessionId, state: &str) -> RunId {
        let run_id = test_run_id();
        writer
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, ?3, 2)",
                params![run_id.text().as_str(), session_id.text().as_str(), state],
            )
            .expect("the test writes the run");
        run_id
    }

    // Writes `run_id`'s `agent.run.stopped`, carrying `trigger` where one is given.
    fn write_stopped(
        writer: &Connection,
        session_id: SessionId,
        run_id: RunId,
        trigger: Option<&str>,
    ) {
        let mut payload = json!({
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 2,
            "previousState": "running",
            "newState": "stopped",
        });
        if let Some(trigger) = trigger {
            payload["trigger"] = json!(trigger);
        }
        insert_test_event(
            writer,
            session_id,
            json!({ "type": "agent.run.stopped", "payload": payload }),
            None,
            "2026-10-14T09:00:00.000Z",
        );
    }

    // Writes the `agent.subagent.stopped` of the helper whose own run is `own_run_id`, filed under
    // `carrying_run_id`, the run it runs under.
    fn write_held_stop(
        writer: &Connection,
        session_id: SessionId,
        carrying_run_id: RunId,
        own_run_id: RunId,
    ) {
        insert_test_event(
            writer,
            session_id,
            json!({
                "type": "agent.subagent.stopped",
                "payload": {
                    "sessionId": session_id,
                    "runId": carrying_run_id,
                    "provider": PROVIDER,
                    "subagentId": "thread-helper",
                    "childRunId": own_run_id,
                },
            }),
            None,
            "2026-10-14T09:00:00.000Z",
        );
    }

    // A node of `subagent_id` under `provider_name` with `name` and `provider_path`, its first own
    // run `own_run_id` started at `started_at`.
    fn node(
        (session_id, provider_name): (SessionId, &str),
        (child_handle, subagent_id): (&str, &str),
        (name, provider_path): (Option<&str>, Option<&str>),
        own_run_id: RunId,
        started_at: &str,
    ) -> NewAgentTreeNode {
        NewAgentTreeNode {
            child_handle: handle(child_handle),
            session_id,
            provider_name: provider(provider_name),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: name.map(str::to_owned),
            role: None,
            provider_path: provider_path.map(str::to_owned),
            ask: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id,
            started_at: instant(started_at),
        }
    }

    fn write_node(writer: &Connection, node: &NewAgentTreeNode) {
        run_statement(writer, &insert_node(node)).expect("the test writes the node");
    }

    fn helper(
        (child_handle, subagent_id): (&str, &str),
        provider_path: Option<&str>,
        own_run_id: RunId,
        (own_run_state, own_run_stop_trigger): (RunState, Option<StopTrigger>),
    ) -> AgentTreeHelper {
        AgentTreeHelper {
            child_handle: handle(child_handle),
            subagent_id: subagent_id.to_owned(),
            provider_path: provider_path.map(str::to_owned),
            own_run_id,
            own_run_state,
            own_run_stop_trigger,
        }
    }

    // One session holds `earlier`, stopped with no trigger, and `helper`, which shares its name and
    // path, inserted after it with a handle that sorts before it, and bound later to a newer own run
    // in `own_state` after a first run that completed; an interrupted own run is then stopped with
    // every agent by an `agent.subagent.stopped` filed under another run. Beside them a node with
    // no name or path whose own run is interrupted, a node under another provider, and a newer node
    // of the same name and path in another session. Killed by the session filter dropped
    // (`thread-elsewhere` found, and by name or path the other session's newer node answered), by
    // the provider filter dropped from the id read (`thread-foreign` found), by the state read from
    // a run other than the node's own (the first run's `completed` or another node's state
    // answered), by the trigger read from another run's event (`earlier` reading `tokenLimit` when
    // the helper stops with it), by `ORDER BY` reversed or dropped (`earlier` answered by name or
    // path), by a NULL column matched (the unnamed node answered for a name or path no node holds),
    // by the helper stop ignored (the helper reading `interrupted`), by the helper stop matched on
    // a run other than the node's own (the helper reading `interrupted` when matched on the run it
    // is filed under, the unnamed node reading `stopped` when matched on none), and by a method of
    // the registered lookup answering another method's read (each key's text names no node under
    // the other keys).
    #[rstest]
    #[case::running("running", None, RunState::Running, None)]
    #[case::completed("completed", None, RunState::Completed, None)]
    #[case::stopped_at_its_token_limit(
        "stopped",
        Some("tokenLimit"),
        RunState::Stopped,
        Some(StopTrigger::TokenLimit)
    )]
    #[case::stopped_with_every_agent_once_interrupted(
        "interrupted",
        None,
        RunState::Stopped,
        Some(StopTrigger::StopAll)
    )]
    #[tokio::test]
    async fn a_helper_is_found_by_each_name_with_its_own_run(
        #[case] own_state: &str,
        #[case] own_trigger: Option<&str>,
        #[case] expected_state: RunState,
        #[case] expected_trigger: Option<StopTrigger>,
    ) {
        let database = TestDatabase::new(schema_parts());
        let writer = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        let other_session_id = test_session_id();
        let scout = (Some("scout"), Some("/root/scout"));

        let earlier_run = insert_run(&writer, session_id, "stopped");
        write_stopped(&writer, session_id, earlier_run, None);
        write_node(
            &writer,
            &node(
                (session_id, PROVIDER),
                ("handle-b", "thread-earlier"),
                scout,
                earlier_run,
                "2026-10-14T08:00:00.000Z",
            ),
        );
        let first_run = insert_run(&writer, session_id, "completed");
        write_node(
            &writer,
            &node(
                (session_id, PROVIDER),
                ("handle-a", "thread-helper"),
                scout,
                first_run,
                "2026-10-14T07:00:00.000Z",
            ),
        );
        let own_run = insert_run(&writer, session_id, own_state);
        run_statement(
            &writer,
            &bind_newest_run(
                &handle("handle-a"),
                own_run,
                None,
                &instant("2026-10-14T08:30:00.000Z"),
            ),
        )
        .expect("the test binds the helper's newer run");
        if own_state == "stopped" {
            write_stopped(&writer, session_id, own_run, own_trigger);
        }
        let unnamed_run = insert_run(&writer, session_id, "interrupted");
        if own_state == "interrupted" {
            write_held_stop(&writer, session_id, test_run_id(), own_run);
        }
        write_node(
            &writer,
            &node(
                (session_id, PROVIDER),
                ("handle-c", "agent-unnamed"),
                (None, None),
                unnamed_run,
                "2026-10-14T08:40:00.000Z",
            ),
        );
        let foreign_run = insert_run(&writer, session_id, "running");
        write_node(
            &writer,
            &node(
                (session_id, "other-provider"),
                ("handle-d", "thread-foreign"),
                (None, None),
                foreign_run,
                "2026-10-14T08:45:00.000Z",
            ),
        );
        let elsewhere_run = insert_run(&writer, other_session_id, "running");
        write_node(
            &writer,
            &node(
                (other_session_id, PROVIDER),
                ("handle-e", "thread-elsewhere"),
                scout,
                elsewhere_run,
                "2026-10-14T09:00:00.000Z",
            ),
        );

        let lookup: Arc<dyn AgentTreeLookup> = Arc::new(StoredAgentTreeLookup::new(Arc::new(
            DatabaseReadPool::new(database.path(), AGENT_TREE_LOOKUP_STATEMENT_CAPACITY),
        )));
        let found = Some(helper(
            ("handle-a", "thread-helper"),
            Some("/root/scout"),
            own_run,
            (expected_state, expected_trigger),
        ));
        let by_id = async |provider_name: &str, subagent_id: &str| {
            lookup
                .helper_by_subagent_id(session_id, provider(provider_name), subagent_id.to_owned())
                .await
                .expect("the id read reads")
        };
        assert_eq!(by_id(PROVIDER, "thread-helper").await, found);
        assert_eq!(
            by_id(PROVIDER, "thread-earlier").await,
            Some(helper(
                ("handle-b", "thread-earlier"),
                Some("/root/scout"),
                earlier_run,
                (RunState::Stopped, None),
            ))
        );
        assert_eq!(
            by_id(PROVIDER, "agent-unnamed").await,
            Some(helper(
                ("handle-c", "agent-unnamed"),
                None,
                unnamed_run,
                (RunState::Interrupted, None),
            ))
        );
        assert_eq!(by_id(PROVIDER, "thread-foreign").await, None);
        assert_eq!(by_id(PROVIDER, "thread-elsewhere").await, None);
        assert_eq!(by_id(PROVIDER, "thread-nobody").await, None);

        let by_name = async |name: &str| {
            lookup
                .helper_by_name(session_id, name.to_owned())
                .await
                .expect("the name read reads")
        };
        assert_eq!(by_name("scout").await, found);
        assert_eq!(by_name("nobody").await, None);

        let by_path = async |path: &str| {
            lookup
                .helper_by_provider_path(session_id, path.to_owned())
                .await
                .expect("the path read reads")
        };
        assert_eq!(by_path("/root/scout").await, found);
        assert_eq!(by_path("/root/nobody").await, None);
    }
}
