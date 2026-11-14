//! The per-turn usage rows each `usage.tokenCount.recorded` event projects: one row per event,
//! keyed by its id, charged to the account and credential generation the event itself names, which
//! is the account the run's binding held when the turn was metered. A turn that spans a switch
//! therefore lands as one row per account. A live append's row carries the daemon start that wrote
//! it, and a rebuilt row none, so the repricing reads only rows no live request still meters. Rows
//! the observer writes for a turn no session owns carry no session, so a session's rebuild never
//! clears them, are charged to the generation the account holds at the write, and are written held,
//! since each is a whole request.

use std::borrow::Cow;

use rusqlite::types::Value;
use serde::Deserialize as _;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::{
    UsageCostSource, UsageCostUpdatedPayload, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

use crate::driver::contract::account::WindowTurnSpend;

pub mod sightings;
pub mod unpriced;

// The provider column is the account's own, so a row is written only while its account is held:
// a rebuild after the account's removal writes nothing for it, as the removal's cascade left it.
const INSERT_USAGE_TURN_SQL: &str = "INSERT INTO provider_account_usage_turns
  (turn_id, account_id, provider, occurred_at, session_id, run_id, model_id, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, request_key, speed,
   processing_region, cache_write_extended_tokens, web_search_requests, thread_speed, subagent_id,
   observed_credential_generation, daemon_started_at)
SELECT @turn_id, account_id, provider, @occurred_at, @session_id, @run_id, @model_id,
  @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
  @request_key, @speed, @processing_region, @cache_write_extended_tokens, @web_search_requests,
  @thread_speed, @subagent_id, @observed_credential_generation, @daemon_started_at
FROM provider_accounts WHERE account_id = @account_id";

// A turn no session owns: no session or run, the generation the account's row holds now, the
// daemon start that wrote it, and held, since nothing meters it further.
const INSERT_SESSIONLESS_USAGE_TURN_SQL: &str = "INSERT INTO provider_account_usage_turns
  (turn_id, account_id, provider, occurred_at, model_id, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, reasoning_tokens, speed,
   observed_credential_generation, daemon_started_at, is_held)
SELECT @turn_id, account_id, provider, @occurred_at, @model_id, @input_tokens, @output_tokens,
  @cache_read_tokens, @cache_write_tokens, @reasoning_tokens, @speed, credential_generation,
  @daemon_started_at, 1
FROM provider_accounts WHERE account_id = @account_id AND removal_intent = 0";

// A turn's figure is set once: a priced row keeps its figure, and a row its account's removal
// took is gone, so the row count is not checked.
const SET_USAGE_TURN_COST_SQL: &str = "UPDATE provider_account_usage_turns
   SET cost_usd_micros = @cost_usd_micros, cost_source = @cost_source
 WHERE turn_id = @turn_id AND cost_usd_micros IS NULL";

// As the figure above, on a turn no session owns, which no cost event names.
const SET_SESSIONLESS_USAGE_TURN_COST_SQL: &str = "UPDATE provider_account_usage_turns
   SET cost_usd_micros = @cost_usd_micros, cost_source = @cost_source
 WHERE turn_id = @turn_id AND session_id IS NULL AND cost_usd_micros IS NULL";

// Only the session's own rows: a turn no session owns has no session and survives.
const CLEAR_USAGE_TURNS_SQL: &str = "DELETE FROM provider_account_usage_turns WHERE session_id = ?";

const USAGE_TURN_EVENT_TYPES: [SessionEventType; 2] = [
    SessionEventType::UsageTokenCountRecorded,
    SessionEventType::UsageCostUpdated,
];

/// The statements that write a usage event's rows in the append's own write: the row of a
/// `usage.tokenCount.recorded` event, marked with `daemon_started_at`, the running daemon's start
/// in the stored form, the figure a `usage.cost.updated` event sets on each row it names, and none
/// for any other event. Fails when the stored payload does not read as its variant, which the
/// append's own checks rule out.
pub fn usage_turn_projection_statements(
    envelope: &UnsequencedEventEnvelope,
    daemon_started_at: &WireInstant,
) -> Result<Vec<WriteStatement>, serde_json::Error> {
    let event_type = envelope.event_type();
    if event_type == SessionEventType::UsageTokenCountRecorded {
        let recorded = UsageTokenCountRecordedPayload::deserialize(envelope.payload())?;
        return Ok(vec![insert_usage_turn_statement(
            envelope.id.as_str(),
            envelope.occurred_at.as_str(),
            envelope.session_id(),
            &recorded,
            Some(daemon_started_at),
        )]);
    }
    if event_type == SessionEventType::UsageCostUpdated {
        let cost = UsageCostUpdatedPayload::deserialize(envelope.payload())?;
        return Ok(usage_cost_statements(&cost).collect());
    }
    Ok(Vec::new())
}

/// The `provider_account_usage_turns` rows of each session's usage events, as a rebuild replaces
/// them, each with no daemon start, so the repricing reads it. Its fold keeps no state, so the
/// projection is its own fold.
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
                None,
            ));
        } else if let SessionEvent::UsageCostUpdated(cost) = event {
            statements.extend(usage_cost_statements(cost));
        }
        Ok(())
    }
}

// The row of the event `event_id`, on `session_id`'s log at `occurred_at`, with its cost unpriced,
// written by the daemon started at `daemon_started_at`, `None` for a rebuild.
fn insert_usage_turn_statement(
    event_id: &str,
    occurred_at: &str,
    session_id: SessionId,
    recorded: &UsageTokenCountRecordedPayload,
    daemon_started_at: Option<&WireInstant>,
) -> WriteStatement {
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
            model_binding(recorded.model_id.as_ref()),
            count_binding("@input_tokens", recorded.input_tokens),
            count_binding("@output_tokens", recorded.output_tokens),
            count_binding("@cache_read_tokens", recorded.cache_read_tokens),
            count_binding("@cache_write_tokens", recorded.cache_write_tokens),
            count_binding("@reasoning_tokens", recorded.reasoning_tokens),
            nullable_text_binding(
                "@request_key",
                recorded.request_key.as_ref().map(BoundedText::as_str),
            ),
            nullable_text_binding("@speed", recorded.speed.as_ref().map(BoundedText::as_str)),
            nullable_text_binding(
                "@processing_region",
                recorded.processing_region.as_ref().map(BoundedText::as_str),
            ),
            count_binding(
                "@cache_write_extended_tokens",
                recorded.cache_write_extended_tokens,
            ),
            count_binding("@web_search_requests", recorded.web_search_requests),
            nullable_text_binding(
                "@thread_speed",
                recorded.thread_speed.as_ref().map(BoundedText::as_str),
            ),
            nullable_text_binding(
                "@subagent_id",
                recorded.subagent_id.as_ref().map(SubagentId::as_str),
            ),
            credential_generation_binding(
                "@observed_credential_generation",
                recorded.credential_generation,
            ),
            nullable_text_binding(
                "@daemon_started_at",
                daemon_started_at.map(WireInstant::as_str),
            ),
        ]),
        expected_row_count: None,
    }
}

/// A new id for a turn no session owns, which its row is keyed by.
pub fn mint_sessionless_turn_id() -> FreeFormText<EVENT_FIELD_MAX_LEN> {
    FreeFormText::new(mint_uuid_v7().to_string()).expect("a UUID is a usage row id")
}

/// The statement that writes the turn `turn_id` no session owns, `spend` at its model and tier on
/// `provider_account_id`'s account at `occurred_at` under the daemon start `daemon_started_at`:
/// held from the write, as a whole request, and charged to the account's generation as its row
/// stands at the write. Refused by its row count for an account not registered.
pub fn sessionless_usage_turn_statement(
    turn_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    provider_account_id: &ProviderAccountId,
    occurred_at: &WireInstant,
    daemon_started_at: &WireInstant,
    spend: &WindowTurnSpend,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_SESSIONLESS_USAGE_TURN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@turn_id", turn_id.as_str()),
            text_binding("@account_id", provider_account_id.as_str()),
            text_binding("@occurred_at", occurred_at.as_str()),
            model_binding(spend.model_id.as_ref()),
            count_binding("@input_tokens", spend.input_tokens),
            count_binding("@output_tokens", spend.output_tokens),
            count_binding("@cache_read_tokens", spend.cache_read_tokens),
            count_binding("@cache_write_tokens", spend.cache_write_tokens),
            count_binding("@reasoning_tokens", spend.reasoning_tokens),
            nullable_text_binding("@speed", spend.speed.as_ref().map(BoundedText::as_str)),
            text_binding("@daemon_started_at", daemon_started_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that sets the figure of the turn `turn_id` no session owns, as the repricing
/// prices it directly: in whole micro-dollars, from `cost_source`. A turn already priced keeps its
/// figure, and one its account's removal took is gone, so neither is refused.
pub fn sessionless_usage_cost_statement(
    turn_id: &str,
    cost_usd_micros: UsdMicros,
    cost_source: UsageCostSource,
) -> WriteStatement {
    usage_cost_statement(
        SET_SESSIONLESS_USAGE_TURN_COST_SQL,
        turn_id,
        cost_usd_micros,
        cost_source,
    )
}

// One statement per token event the cost names, setting that row's own share once.
fn usage_cost_statements(
    cost: &UsageCostUpdatedPayload,
) -> impl Iterator<Item = WriteStatement> + '_ {
    cost.priced_events.as_slice().iter().map(|priced| {
        usage_cost_statement(
            SET_USAGE_TURN_COST_SQL,
            priced.event_id.as_str(),
            priced.cost_usd_micros,
            cost.cost_source,
        )
    })
}

fn usage_cost_statement(
    sql: &'static str,
    turn_id: &str,
    cost_usd_micros: UsdMicros,
    cost_source: UsageCostSource,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@turn_id", turn_id),
            (
                Cow::Borrowed("@cost_usd_micros"),
                Value::Integer(i64::from(cost_usd_micros.0)),
            ),
            // The source's wire word, which the table's check lists.
            text_binding("@cost_source", cost_source.into()),
        ]),
        expected_row_count: None,
    }
}

/// The binding of `generation`, a credential generation, as the integer its column stores.
pub(crate) fn credential_generation_binding(
    name: &'static str,
    generation: CredentialGeneration,
) -> (Cow<'static, str>, Value) {
    (Cow::Borrowed(name), Value::Integer(i64::from(generation)))
}

fn model_binding(
    model_id: Option<&FreeFormText<EVENT_FIELD_MAX_LEN>>,
) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed("@model_id"),
        Value::from(model_id.map(|model_id| model_id.as_str().to_owned())),
    )
}

// A count the provider reported, or NULL where it reported none.
fn count_binding(name: &'static str, count: Option<SafeInt<0>>) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        count.map_or(Value::Null, |count| Value::Integer(i64::from(count))),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use rusqlite::params;
    use serde_json::{Value as Json, json};
    use sidekicks_store::database::schema::schema_parts;
    use sidekicks_store::database::writer::test_file::test_envelope;
    use sidekicks_store::events::test_log::{
        AT, SessionTestLog, run_write_statements, stored_envelope,
    };

    use super::*;

    /// The lead run's model.
    pub(crate) const LEAD_MODEL: &str = "claude-opus-4-5";
    /// A daemon start before the one any test runs as, which a live append's row carries.
    pub(crate) const EARLIER_START: &str = "2026-10-14T08:00:00.000Z";
    const HELPER_MODEL: &str = "claude-haiku-4-5";

    /// One turn's figures: the account and generation charged, the model and the five counts.
    pub(crate) struct Turn<'a> {
        /// The account charged.
        pub(crate) account: &'a str,
        /// The account's credential generation charged.
        pub(crate) generation: u64,
        /// The model the turn ran on.
        pub(crate) model: &'a str,
        /// The helper the turn is attributed to.
        pub(crate) subagent: Option<&'a str>,
        /// Input, output, cache-read, cache-write and reasoning tokens.
        pub(crate) counts: [u64; 5],
    }

    /// A session log beside the accounts `account-a` and `account-b`.
    pub(crate) fn log_with_accounts() -> SessionTestLog {
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
        recorded_with(log, turn, &json!({}))
    }

    /// The envelope a live append stores for `turn` on the log's lead run, with each of `members`
    /// also set on the payload.
    pub(crate) fn recorded_with(
        log: &SessionTestLog,
        turn: &Turn<'_>,
        members: &Json,
    ) -> UnsequencedEventEnvelope {
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
        if let (Some(payload), Some(members)) = (payload.as_object_mut(), members.as_object()) {
            payload.extend(members.clone());
        }
        let event: SessionEvent = serde_json::from_value(
            json!({"type": "usage.tokenCount.recorded", "payload": payload}),
        )
        .expect("the test writes a usage event");
        test_envelope(log.session_id, &event)
    }

    /// The `usage.cost.updated` envelope pricing each `(event, figure)` of `priced` at the exact
    /// rates.
    pub(crate) fn priced(
        log: &SessionTestLog,
        priced: &[(&UnsequencedEventEnvelope, u64)],
    ) -> UnsequencedEventEnvelope {
        let event: SessionEvent = serde_json::from_value(json!({
            "type": "usage.cost.updated",
            "payload": {
                "sessionId": log.session_id,
                "costUsdMicros": priced.iter().map(|(_, figure)| figure).sum::<u64>(),
                "costSource": "derivedExact",
                "pricedEvents": priced
                    .iter()
                    .map(|(envelope, figure)| {
                        json!({"eventId": envelope.id.as_str(), "costUsdMicros": figure})
                    })
                    .collect::<Vec<_>>(),
                "modelId": LEAD_MODEL,
            },
        }))
        .expect("the test writes a cost event");
        test_envelope(log.session_id, &event)
    }

    /// `text`, an instant a test writes.
    pub(crate) fn instant(text: &str) -> WireInstant {
        WireInstant::try_from(text.to_owned()).expect("the test writes an instant")
    }

    /// The id of `envelope`'s event, its row's turn id.
    pub(crate) fn turn_id(envelope: &UnsequencedEventEnvelope) -> String {
        envelope.id.as_str().to_owned()
    }

    /// Writes each envelope's row as the append's own write does under a daemon started at
    /// `daemon_started_at`.
    pub(crate) fn append(
        log: &SessionTestLog,
        daemon_started_at: &str,
        envelopes: &[UnsequencedEventEnvelope],
    ) {
        let daemon_started_at = instant(daemon_started_at);
        for envelope in envelopes {
            run_write_statements(
                &log.writer,
                &usage_turn_projection_statements(envelope, &daemon_started_at)
                    .expect("the payload reads"),
            );
        }
    }

    /// Clears the session's rows and folds its log again, as the projection rebuild does.
    pub(crate) fn rebuild(log: &SessionTestLog, envelopes: &[UnsequencedEventEnvelope]) {
        let projection = UsageTurnsProjection;
        let mut statements = projection.clear_statements(&log.session_id);
        let mut fold = projection.fold(&log.session_id);
        for (sequence, envelope) in envelopes.iter().enumerate() {
            let envelope = stored_envelope(envelope, sequence + 1);
            let event = SessionEvent::from_envelope(&envelope).expect("the event reads");
            fold.apply(&envelope, &event, &mut statements)
                .expect("the fold takes the event");
        }
        run_write_statements(&log.writer, &statements);
    }

    // Every row, ordered by its turn id, each column as stored.
    fn rows(log: &SessionTestLog) -> Vec<Vec<Value>> {
        let reader = log.reader();
        let mut statement = reader
            .prepare(
                "SELECT turn_id, account_id, provider, occurred_at, session_id, run_id, model_id,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, request_key, speed, processing_region,
                   cache_write_extended_tokens, web_search_requests, thread_speed, subagent_id,
                   cost_usd_micros, cost_source, observed_credential_generation
                 FROM provider_account_usage_turns ORDER BY turn_id",
            )
            .expect("the read prepares");
        statement
            .query_map([], |row| {
                (0..22).map(|column| row.get::<_, Value>(column)).collect()
            })
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    fn text(value: &str) -> Value {
        Value::Text(value.to_owned())
    }

    // Fails when an event lands as anything but one row keyed by its id, holding its session, run,
    // model, five counts, request facts, helper and generation, with the account's provider and no
    // cost, or when a request fact's column is left unbound or bound to another's value.
    #[test]
    fn each_usage_event_projects_one_row_keyed_by_its_id() {
        let log = log_with_accounts();
        let envelopes = [
            recorded_with(
                &log,
                &Turn {
                    account: "account-a",
                    generation: 2,
                    model: LEAD_MODEL,
                    subagent: Some("helper"),
                    counts: [10, 4, 300, 20, 7],
                },
                &json!({
                    "requestKey": "msg-1",
                    "speed": "fast",
                    "processingRegion": "us",
                    "cacheWriteExtendedTokens": 12,
                    "webSearchRequests": 3,
                    "threadSpeed": "flex",
                }),
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
        append(&log, EARLIER_START, &envelopes);

        let request_facts = [
            vec![
                text("msg-1"),
                text("fast"),
                text("us"),
                Value::Integer(12),
                Value::Integer(3),
                text("flex"),
                text("helper"),
            ],
            vec![Value::Null; 7],
        ];
        let mut expected: Vec<Vec<Value>> = envelopes
            .iter()
            .zip([[10, 4, 300, 20, 7], [5, 1, 0, 0, 0]])
            .zip(request_facts)
            .map(|((envelope, counts), request_facts)| {
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
                row.extend(request_facts);
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
            EARLIER_START,
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
        append(&log, EARLIER_START, &envelopes);
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
            EARLIER_START,
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

    // Each row's figure and source, ordered by its turn id.
    fn figures(log: &SessionTestLog) -> Vec<(String, Option<i64>, Option<String>)> {
        log.reader()
            .prepare(
                "SELECT turn_id, cost_usd_micros, cost_source
                 FROM provider_account_usage_turns ORDER BY turn_id",
            )
            .expect("the read prepares")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    // Fails when a cost event's figures are not projected onto the rows it names, when a rebuild
    // drops or recomputes them, or when a second cost event naming a priced row reprices it.
    #[test]
    fn a_cost_event_sets_each_row_figure_once_and_a_rebuild_writes_the_same() {
        let log = log_with_accounts();
        let turn = |counts| Turn {
            account: "account-a",
            generation: 1,
            model: LEAD_MODEL,
            subagent: None,
            counts,
        };
        let first = recorded(&log, &turn([10, 4, 0, 0, 0]));
        let second = recorded(&log, &turn([12, 5, 0, 0, 0]));
        let cost = priced(&log, &[(&first, 5_000), (&second, 5_001)]);
        let envelopes = [first, second, cost];
        append(&log, EARLIER_START, &envelopes);

        let mut expected: Vec<_> = envelopes[..2]
            .iter()
            .zip([5_000, 5_001])
            .map(|(envelope, figure)| {
                let source = Some("derivedExact".to_owned());
                (envelope.id.as_str().to_owned(), Some(figure), source)
            })
            .collect();
        expected.sort();
        assert_eq!(figures(&log), expected);

        rebuild(&log, &envelopes);
        assert_eq!(figures(&log), expected);

        append(&log, EARLIER_START, &[priced(&log, &[(&envelopes[0], 9)])]);
        assert_eq!(figures(&log), expected);
    }
}
