//! The per-turn usage rows each `usage.tokenCount.recorded` event projects: one row per event,
//! keyed by its id, charged to the account and credential generation the event itself names, which
//! is the account the run's binding held when the turn was metered. A turn that spans a switch
//! therefore lands as one row per account. Rows the observer writes for a turn no session owns
//! carry no session, so a session's rebuild never clears them.

use std::borrow::Cow;

use rusqlite::types::Value;
use serde::Deserialize as _;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::UsageTokenCountRecordedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

// The provider column is the account's own, so a row is written only while its account is held:
// a rebuild after the account's removal writes nothing for it, as the removal's cascade left it.
const INSERT_USAGE_TURN_SQL: &str = "INSERT INTO provider_account_usage_turns
  (turn_id, account_id, provider, occurred_at, session_id, run_id, model_id, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
   observed_credential_generation)
SELECT @turn_id, account_id, provider, @occurred_at, @session_id, @run_id, @model_id,
  @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
  @observed_credential_generation
FROM provider_accounts WHERE account_id = @account_id";

// Only the session's own rows: a turn no session owns has no session and survives.
const CLEAR_USAGE_TURNS_SQL: &str = "DELETE FROM provider_account_usage_turns WHERE session_id = ?";

const USAGE_TURN_EVENT_TYPES: [SessionEventType; 1] = [SessionEventType::UsageTokenCountRecorded];

/// The statements that write the usage row of a `usage.tokenCount.recorded` event in the append's
/// own write; none for any other event. Fails when the stored payload does not read as its
/// variant, which the append's own checks rule out.
pub fn usage_turn_projection_statements(
    envelope: &UnsequencedEventEnvelope,
) -> Result<Vec<WriteStatement>, serde_json::Error> {
    if envelope.event_type() != SessionEventType::UsageTokenCountRecorded {
        return Ok(Vec::new());
    }
    let recorded = UsageTokenCountRecordedPayload::deserialize(envelope.payload())?;
    Ok(vec![insert_usage_turn_statement(
        envelope.id.as_str(),
        envelope.occurred_at.as_str(),
        envelope.session_id(),
        &recorded,
    )])
}

/// The `provider_account_usage_turns` rows of each session's usage events, as a rebuild replaces
/// them. Its fold keeps no state, so the projection is its own fold.
#[derive(Clone, Copy, Debug)]
pub struct UsageTurnsProjection;

impl SessionProjection for UsageTurnsProjection {
    fn name(&self) -> &'static str {
        "providerAccountUsageTurns"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &USAGE_TURN_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_USAGE_TURNS_SQL),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for UsageTurnsProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        if let SessionEvent::UsageTokenCountRecorded(recorded) = event {
            statements.push(insert_usage_turn_statement(
                envelope.id.as_str(),
                envelope.occurred_at.as_str(),
                envelope.session_id,
                recorded,
            ));
        }
        Ok(())
    }
}

// The row of the event `event_id`, on `session_id`'s log at `occurred_at`, with its cost unpriced.
fn insert_usage_turn_statement(
    event_id: &str,
    occurred_at: &str,
    session_id: SessionId,
    recorded: &UsageTokenCountRecordedPayload,
) -> WriteStatement {
    let count = |name: &'static str, count: Option<SafeInt<0>>| {
        (
            Cow::Borrowed(name),
            count.map_or(Value::Null, |count| Value::Integer(i64::from(count))),
        )
    };
    WriteStatement {
        sql: Cow::Borrowed(INSERT_USAGE_TURN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@turn_id", event_id),
            text_binding("@account_id", recorded.provider_account_id.as_str()),
            text_binding("@occurred_at", occurred_at),
            text_binding("@session_id", session_id.text().as_str()),
            (
                Cow::Borrowed("@run_id"),
                Value::from(
                    recorded
                        .run_id
                        .map(|run_id| run_id.text().as_str().to_owned()),
                ),
            ),
            (
                Cow::Borrowed("@model_id"),
                Value::from(
                    recorded
                        .model_id
                        .as_ref()
                        .map(|model_id| model_id.as_str().to_owned()),
                ),
            ),
            count("@input_tokens", recorded.input_tokens),
            count("@output_tokens", recorded.output_tokens),
            count("@cache_read_tokens", recorded.cache_read_tokens),
            count("@cache_write_tokens", recorded.cache_write_tokens),
            count("@reasoning_tokens", recorded.reasoning_tokens),
            (
                Cow::Borrowed("@observed_credential_generation"),
                Value::Integer(
                    serde_json::to_value(recorded.credential_generation)
                        .ok()
                        .and_then(|generation| generation.as_i64())
                        .expect("a credential generation is a safe integer"),
                ),
            ),
        ]),
        expected_row_count: None,
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params, params_from_iter};
    use serde_json::{Value as Json, json};
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::schema::schema_parts;
    use sidekicks_store::database::statement::named_bindings;
    use sidekicks_store::database::writer::test_file::test_envelope;
    use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
    use sidekicks_store::events::test_log::{AT, SessionTestLog};

    use super::*;

    const LEAD_MODEL: &str = "claude-opus-4-5";
    const HELPER_MODEL: &str = "claude-haiku-4-5";

    // One turn's figures: the account and generation charged, the model and the five counts.
    struct Turn<'a> {
        account: &'a str,
        generation: u64,
        model: &'a str,
        subagent: Option<&'a str>,
        counts: [u64; 5],
    }

    // A session log beside the accounts `account-a` and `account-b`.
    fn log_with_accounts() -> SessionTestLog {
        let log = SessionTestLog::new(schema_parts());
        for (account, provider) in [("account-a", "claude"), ("account-b", "claude")] {
            log.writer
                .execute(
                    "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                       billing_mode, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'subscription', ?4, ?4)",
                    params![account, provider, format!("/homes/{account}"), AT],
                )
                .expect("the test registers its account");
        }
        log
    }

    // The envelope a live append stores for `turn` on the log's lead run.
    fn recorded(log: &SessionTestLog, turn: &Turn<'_>) -> UnsequencedEventEnvelope {
        let [input, output, cache_read, cache_write, reasoning] = turn.counts;
        let mut payload = json!({
            "sessionId": log.session_id,
            "runId": log.run_id,
            "inputTokens": input,
            "outputTokens": output,
            "cacheReadTokens": cache_read,
            "cacheWriteTokens": cache_write,
            "reasoningTokens": reasoning,
            "containment": "confirmedSubtracted",
            "providerAccountId": turn.account,
            "credentialGeneration": turn.generation,
            "modelId": turn.model,
        });
        if let Some(subagent) = turn.subagent {
            payload["subagentId"] = json!(subagent);
        }
        let event: SessionEvent = serde_json::from_value(
            json!({"type": "usage.tokenCount.recorded", "payload": payload}),
        )
        .expect("the test writes a usage event");
        test_envelope(log.session_id, &event)
    }

    // The stored form of `envelope` at `sequence`, as a rebuild reads it back from the log.
    fn stored(envelope: &UnsequencedEventEnvelope, sequence: usize) -> EventEnvelope {
        serde_json::from_value(json!({
            "id": envelope.id.as_str(),
            "sessionId": envelope.session_id(),
            "sequence": sequence,
            "occurredAt": envelope.occurred_at.as_str(),
            "category": envelope.category(),
            "type": "usage.tokenCount.recorded",
            "payload": envelope.payload(),
            "version": &*SESSION_EVENT_VERSION,
        }))
        .expect("the stored envelope reads")
    }

    fn run(connection: &Connection, statements: &[WriteStatement]) {
        for statement in statements {
            match &statement.bindings {
                StatementBindings::None => connection.execute(&statement.sql, []),
                StatementBindings::Positional(values) => {
                    connection.execute(&statement.sql, params_from_iter(values))
                }
                StatementBindings::Named(values) => {
                    connection.execute(&statement.sql, named_bindings(values).as_slice())
                }
            }
            .expect("the projection's statement runs");
        }
    }

    // Writes each envelope's row as the append's own write does.
    fn append(log: &SessionTestLog, envelopes: &[UnsequencedEventEnvelope]) {
        for envelope in envelopes {
            run(
                &log.writer,
                &usage_turn_projection_statements(envelope).expect("the payload reads"),
            );
        }
    }

    // Clears the session's rows and folds its log again, as the projection rebuild does.
    fn rebuild(log: &SessionTestLog, envelopes: &[UnsequencedEventEnvelope]) {
        let projection = UsageTurnsProjection;
        let mut statements = projection.clear_statements(&log.session_id);
        let mut fold = projection.fold(&log.session_id);
        for (sequence, envelope) in envelopes.iter().enumerate() {
            let envelope = stored(envelope, sequence + 1);
            let event = SessionEvent::from_envelope(&envelope).expect("the event reads");
            fold.apply(&envelope, &event, &mut statements)
                .expect("the fold takes the event");
        }
        run(&log.writer, &statements);
    }

    // Every row, ordered by its turn id, each column as stored.
    fn rows(log: &SessionTestLog) -> Vec<Vec<Value>> {
        let reader = log.reader();
        let mut statement = reader
            .prepare(
                "SELECT turn_id, account_id, provider, occurred_at, session_id, run_id, model_id,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, cost_usd_micros, cost_source, observed_credential_generation
                 FROM provider_account_usage_turns ORDER BY turn_id",
            )
            .expect("the read prepares");
        statement
            .query_map([], |row| {
                (0..15).map(|column| row.get::<_, Value>(column)).collect()
            })
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    fn text(value: &str) -> Value {
        Value::Text(value.to_owned())
    }

    // Fails when an event lands as anything but one row keyed by its id, holding its session, run,
    // model, five counts and generation, with the account's provider and no cost.
    #[test]
    fn each_usage_event_projects_one_row_keyed_by_its_id() {
        let log = log_with_accounts();
        let envelopes = [
            recorded(
                &log,
                &Turn {
                    account: "account-a",
                    generation: 2,
                    model: LEAD_MODEL,
                    subagent: None,
                    counts: [10, 4, 300, 20, 7],
                },
            ),
            recorded(
                &log,
                &Turn {
                    account: "account-a",
                    generation: 2,
                    model: LEAD_MODEL,
                    subagent: None,
                    counts: [5, 1, 0, 0, 0],
                },
            ),
        ];
        append(&log, &envelopes);

        let mut expected: Vec<Vec<Value>> = envelopes
            .iter()
            .zip([[10, 4, 300, 20, 7], [5, 1, 0, 0, 0]])
            .map(|(envelope, counts)| {
                let mut row = vec![
                    text(envelope.id.as_str()),
                    text("account-a"),
                    text("claude"),
                    text(envelope.occurred_at.as_str()),
                    text(log.session_id.text().as_str()),
                    text(log.run_id.text().as_str()),
                    text(LEAD_MODEL),
                ];
                row.extend(counts.map(Value::Integer));
                row.extend([Value::Null, Value::Null, Value::Integer(2)]);
                row
            })
            .collect();
        expected.sort_by(|left, right| format!("{left:?}").cmp(&format!("{right:?}")));
        assert_eq!(rows(&log), expected);
    }

    // Fails when the account is read from anything but each event's own payload, such as the run's
    // admission: a turn that spans a switch's acknowledgment must split by account under one total.
    #[test]
    fn a_turn_spanning_a_switch_lands_as_one_row_per_account() {
        let log = log_with_accounts();
        append(
            &log,
            &[
                recorded(
                    &log,
                    &Turn {
                        account: "account-a",
                        generation: 1,
                        model: LEAD_MODEL,
                        subagent: None,
                        counts: [100, 10, 0, 0, 0],
                    },
                ),
                recorded(
                    &log,
                    &Turn {
                        account: "account-b",
                        generation: 3,
                        model: LEAD_MODEL,
                        subagent: None,
                        counts: [50, 5, 0, 0, 0],
                    },
                ),
            ],
        );

        let reader = log.reader();
        let by_account: Vec<(String, i64, i64, i64)> = reader
            .prepare(
                "SELECT account_id, observed_credential_generation, SUM(input_tokens),
                   SUM(output_tokens)
                 FROM provider_account_usage_turns WHERE run_id = ?1
                 GROUP BY account_id ORDER BY account_id",
            )
            .expect("the read prepares")
            .query_map([log.run_id.text().as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads");
        assert_eq!(
            by_account,
            [
                ("account-a".to_owned(), 1, 100, 10),
                ("account-b".to_owned(), 3, 50, 5),
            ]
        );
        let total: (i64, i64) = reader
            .query_row(
                "SELECT SUM(input_tokens), SUM(output_tokens)
                 FROM provider_account_usage_turns WHERE run_id = ?1",
                [log.run_id.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the total reads");
        assert_eq!(total, (150, 15));
    }

    // Fails when a rebuild's clear reaches rows no session owns, or leaves the session's own rows
    // to be written twice. Mutation: the clear deleting every row.
    #[test]
    fn a_rebuild_rewrites_event_rows_once_and_keeps_a_sessionless_row() {
        let log = log_with_accounts();
        let envelopes = [
            recorded(
                &log,
                &Turn {
                    account: "account-a",
                    generation: 1,
                    model: LEAD_MODEL,
                    subagent: None,
                    counts: [10, 4, 0, 0, 0],
                },
            ),
            recorded(
                &log,
                &Turn {
                    account: "account-b",
                    generation: 1,
                    model: HELPER_MODEL,
                    subagent: None,
                    counts: [3, 2, 0, 0, 0],
                },
            ),
        ];
        append(&log, &envelopes);
        log.writer
            .execute(
                "INSERT INTO provider_account_usage_turns (turn_id, account_id, provider,
                   occurred_at, model_id, input_tokens, output_tokens,
                   observed_credential_generation)
                 VALUES (?1, 'account-a', 'claude', ?2, ?3, 8, 1, 1)",
                params![mint_uuid_v7().to_string(), AT, HELPER_MODEL],
            )
            .expect("the observer's sessionless row is written");
        let live = rows(&log);

        rebuild(&log, &envelopes);
        rebuild(&log, &envelopes);

        assert_eq!(rows(&log), live);
        assert_eq!(live.len(), envelopes.len() + 1);
    }

    // Fails when a helper conversation's spend is left out of the rows or folded into the lead's
    // model: summed by model, a Claude turn's rows match the provider's per-model block.
    #[test]
    fn a_claude_turn_with_a_helper_sums_to_the_per_model_block() {
        let log = log_with_accounts();
        let per_model_block = json!({
            LEAD_MODEL: {"inputTokens": 30, "outputTokens": 12, "cacheReadInputTokens": 500,
                         "cacheCreationInputTokens": 40},
            HELPER_MODEL: {"inputTokens": 200, "outputTokens": 25, "cacheReadInputTokens": 0,
                           "cacheCreationInputTokens": 100},
        });
        append(
            &log,
            &[
                recorded(
                    &log,
                    &Turn {
                        account: "account-a",
                        generation: 1,
                        model: LEAD_MODEL,
                        subagent: None,
                        counts: [10, 4, 500, 40, 0],
                    },
                ),
                recorded(
                    &log,
                    &Turn {
                        account: "account-a",
                        generation: 1,
                        model: HELPER_MODEL,
                        subagent: Some("helper"),
                        counts: [200, 25, 0, 100, 0],
                    },
                ),
                recorded(
                    &log,
                    &Turn {
                        account: "account-a",
                        generation: 1,
                        model: LEAD_MODEL,
                        subagent: None,
                        counts: [20, 8, 0, 0, 0],
                    },
                ),
            ],
        );

        let reader = log.reader();
        let mut statement = reader
            .prepare(
                "SELECT model_id, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                   SUM(cache_write_tokens)
                 FROM provider_account_usage_turns WHERE run_id = ?1 GROUP BY model_id",
            )
            .expect("the read prepares");
        let summed: serde_json::Map<String, Json> = statement
            .query_map([log.run_id.text().as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    json!({
                        "inputTokens": row.get::<_, i64>(1)?,
                        "outputTokens": row.get::<_, i64>(2)?,
                        "cacheReadInputTokens": row.get::<_, i64>(3)?,
                        "cacheCreationInputTokens": row.get::<_, i64>(4)?,
                    }),
                ))
            })
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads");
        assert_eq!(Json::Object(summed), per_model_block);
    }
}
