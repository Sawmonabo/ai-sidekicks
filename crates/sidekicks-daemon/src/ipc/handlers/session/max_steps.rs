//! `session.maxSteps.update`, which sets or clears a session's own bound on the steps one turn may
//! take, from its next turn; a cleared bound leaves the machine's own value to apply.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::controls::methods::{
    SessionMaxStepsUpdate, SessionMaxStepsUpdateRequest, SessionMaxStepsUpdateResponse,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::console_state::max_steps_per_turn_change_statement;
use sidekicks_session::directory::lookups::write_while_session_exists;
use sidekicks_store::database::writer::DatabaseWriter;

/// Registers `session.maxSteps.update` over `writer`, refusing a session the daemon holds no row
/// for `session.notFound` and keeping nothing. Fails the start when the method is already
/// registered.
pub(crate) fn register_session_max_steps(
    registry: &mut MethodRegistryBuilder,
    writer: Arc<DatabaseWriter>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionMaxStepsUpdate, _>(
        move |request: SessionMaxStepsUpdateRequest, _context: HandlerContext| {
            let writer = Arc::clone(&writer);
            async move {
                let SessionMaxStepsUpdateRequest {
                    session_id,
                    max_steps_per_turn,
                } = request;
                let change = max_steps_per_turn_change_statement(
                    &session_id,
                    max_steps_per_turn,
                    WireInstant::now().as_str(),
                );
                write_while_session_exists(&writer, &session_id, change).await?;
                Ok(SessionMaxStepsUpdateResponse {
                    session_id,
                    max_steps_per_turn,
                })
            }
            .boxed()
        },
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::controls::methods::{
        SessionMaxStepsUpdate, SessionMaxStepsUpdateResponse, SessionMode,
    };
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch as _, DispatchError, MethodRegistry, MethodRegistryBuilder, Reply,
    };
    use sidekicks_session::console_state::{
        read_session_max_steps_per_turn, read_session_mode, session_mode_change_statement,
    };
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::register_session_max_steps;
    use crate::daemon::schema::schema_parts;

    async fn open_methods(database: &TestDatabase) -> (Arc<DatabaseWriter>, MethodRegistry) {
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens"),
        );
        let mut builder = MethodRegistryBuilder::new();
        register_session_max_steps(&mut builder, Arc::clone(&writer))
            .expect("the method registers");
        (writer, builder.freeze())
    }

    async fn update(registry: &MethodRegistry, params: &Value) -> Result<Reply, DispatchError> {
        registry
            .dispatch(
                request(SessionMaxStepsUpdate::DESCRIPTOR.method, Some(params)),
                context(1),
            )
            .await
    }

    fn stored_rows(database: &TestDatabase) -> i64 {
        database
            .reader()
            .query_row("SELECT COUNT(*) FROM session_console_state", [], |row| {
                row.get(0)
            })
            .expect("the test counts the rows")
    }

    // A bound below one is refused at the received check, and a session the daemon holds no row
    // for is refused `session.notFound`; neither keeps a row. Killed by a write before the
    // session's check, which keeps the unknown session's row.
    #[tokio::test]
    async fn a_bound_below_one_and_an_unknown_session_keep_nothing() {
        let database = TestDatabase::new(schema_parts());
        let (_writer, registry) = open_methods(&database).await;
        let held = test_session_id();
        insert_session_row(&database.reader(), held.text().as_str(), None, None);

        let below_one = json!({ "sessionId": held.text().as_str(), "maxStepsPerTurn": 0 });
        assert!(
            matches!(
                update(&registry, &below_one).await,
                Err(DispatchError::ParamsInvalid(_))
            ),
            "a bound below one is refused"
        );
        let unknown = json!({
            "sessionId": test_session_id().text().as_str(),
            "maxStepsPerTurn": 3,
        });
        let Err(DispatchError::Refused(refusal)) = update(&registry, &unknown).await else {
            panic!("an unknown session is refused");
        };
        assert_eq!(refusal.code, RefusalCode::SessionNotFound);
        assert_eq!(stored_rows(&database), 0);
    }

    // `null` clears the session's bound, so its next turn reads none and the machine's own value
    // applies, and the session's other settings stay. Killed by `null` stored as zero, which the
    // table refuses, and by an upsert that replaces the row.
    #[tokio::test]
    async fn a_null_bound_returns_the_session_to_the_machines_value() {
        let database = TestDatabase::new(schema_parts());
        let (writer, registry) = open_methods(&database).await;
        let session_id = test_session_id();
        let reader = database.reader();
        insert_session_row(&reader, session_id.text().as_str(), None, None);
        writer
            .write(vec![session_mode_change_statement(
                &session_id,
                SessionMode::Plan,
                "2026-11-08T12:00:00.000Z",
            )])
            .await
            .expect("the mode is written");
        let answer = |reply: Result<Reply, DispatchError>| {
            let Ok(Reply::Result(result)) = reply else {
                panic!("the update answers");
            };
            serde_json::from_slice::<SessionMaxStepsUpdateResponse>(&result.json)
                .expect("the answer is the method's response")
                .max_steps_per_turn
        };
        let stored =
            || read_session_max_steps_per_turn(&reader, &session_id).expect("the bound reads");

        let set = json!({ "sessionId": session_id.text().as_str(), "maxStepsPerTurn": 5 });
        assert_eq!(answer(update(&registry, &set).await), SafeInt::new(5));
        assert_eq!(stored(), SafeInt::new(5));

        let cleared = json!({ "sessionId": session_id.text().as_str(), "maxStepsPerTurn": null });
        assert_eq!(answer(update(&registry, &cleared).await), None);
        assert_eq!(stored(), None);
        assert_eq!(
            read_session_mode(&reader, &session_id).expect("the mode reads"),
            SessionMode::Plan
        );
    }
}
