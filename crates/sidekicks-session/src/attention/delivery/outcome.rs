//! The outcome row each delivery channel keeps: its last attempt, overwritten by every attempt and
//! removed with the channel's secret, and the count of messages given up on since its last
//! delivery, which a give-up before any attempt keeps on a row with no attempt yet. A test send
//! writes no row. The writes are statements, so a sender puts each in the write that settles its
//! message.

use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, Row};
use sidekicks_contracts::attention::{
    AttentionDeliveryChannel, AttentionDeliveryOutcome, AttentionDeliveryResult,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{BoundedInt, SafeInt};
use sidekicks_store::database::schema::SchemaPart;
use sidekicks_store::database::sql_list::sql_list_of_every;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::attention::projection::{binding, statement};

// An attempt overwrites the last one; a delivery also clears the count of messages given up on.
static RECORD_ATTEMPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO attention_delivery_outcomes
    (channel, attempted_at, result, http_status, undelivered)
  VALUES (@channel, @attempted_at, @result, @http_status, 0)
  ON CONFLICT (channel) DO UPDATE SET
    attempted_at = excluded.attempted_at,
    result = excluded.result,
    http_status = excluded.http_status,
    undelivered = CASE WHEN excluded.result = '{delivered}' THEN 0 ELSE undelivered END",
        delivered = <&'static str>::from(AttentionDeliveryResult::Delivered),
    )
});

// A give-up before any attempt keeps its count on a row with no attempt yet.
const COUNT_UNDELIVERED_SQL: &str =
    "INSERT INTO attention_delivery_outcomes (channel, undelivered) VALUES (@channel, 1)
  ON CONFLICT (channel) DO UPDATE SET undelivered = undelivered + 1";

const REMOVE_OUTCOME_SQL: &str = "DELETE FROM attention_delivery_outcomes WHERE channel = @channel";

const READ_OUTCOMES_SQL: &str = "SELECT channel, attempted_at, result, http_status, undelivered FROM attention_delivery_outcomes";

/// The outcome table's schema part, one row per channel.
pub(crate) fn delivery_outcome_schema_part() -> SchemaPart {
    let channels = sql_list_of_every::<AttentionDeliveryChannel>();
    let results = sql_list_of_every::<AttentionDeliveryResult>();
    SchemaPart::new(
        "attention_delivery_outcomes",
        format!(
            "
-- Each delivery channel's last attempt and the messages given up on since its last delivery.
CREATE TABLE attention_delivery_outcomes (
  channel       TEXT PRIMARY KEY CHECK(channel IN ({channels})),
  attempted_at  TEXT,
  result        TEXT CHECK(result IN ({results})),
  http_status   INTEGER CHECK(http_status BETWEEN 100 AND 599),
  undelivered   INTEGER NOT NULL DEFAULT 0 CHECK(undelivered >= 0),
  CHECK((attempted_at IS NULL) = (result IS NULL))
) STRICT;
"
        ),
    )
}

/// The write of `channel`'s attempt at `attempted_at`: how it ended and the address's HTTP status,
/// if it answered; a delivery also clears the count of messages given up on.
pub(crate) fn attempt_outcome_statement(
    channel: AttentionDeliveryChannel,
    attempted_at: &WireInstant,
    result: AttentionDeliveryResult,
    http_status: Option<BoundedInt<100, 599>>,
) -> WriteStatement {
    statement(
        &RECORD_ATTEMPT_SQL,
        vec![
            channel_binding(channel),
            binding(
                "@attempted_at",
                Value::Text(attempted_at.as_str().to_owned()),
            ),
            binding(
                "@result",
                Value::Text(<&'static str>::from(result).to_owned()),
            ),
            binding(
                "@http_status",
                Value::from(http_status.map(BoundedInt::get)),
            ),
        ],
    )
}

/// The write that counts one more message of `channel` given up on.
pub(crate) fn undelivered_count_statement(channel: AttentionDeliveryChannel) -> WriteStatement {
    statement(COUNT_UNDELIVERED_SQL, vec![channel_binding(channel)])
}

/// The write that removes `channel`'s outcome row, with the channel's secret.
pub fn outcome_removal_statement(channel: AttentionDeliveryChannel) -> WriteStatement {
    statement(REMOVE_OUTCOME_SQL, vec![channel_binding(channel)])
}

/// What one channel's row holds: its last attempt, `None` before any, and the messages given up on
/// since its last delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelOutcome {
    /// The last attempt, or `None`.
    pub last_outcome: Option<AttentionDeliveryOutcome>,
    /// The messages given up on since the last delivery.
    pub undelivered: SafeInt<0>,
}

/// Both channels' rows, a channel with no row reading as no attempt and nothing given up on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryOutcomes {
    /// The web address's.
    pub web_address: ChannelOutcome,
    /// The email digest's.
    pub email_digest: ChannelOutcome,
}

/// Reads both channels' rows on `reader`. Fails when the read fails or a stored value does not read
/// as its column's.
pub fn read_delivery_outcomes(reader: &Connection) -> rusqlite::Result<DeliveryOutcomes> {
    let none = || ChannelOutcome {
        last_outcome: None,
        undelivered: SafeInt::ZERO,
    };
    let mut outcomes = DeliveryOutcomes {
        web_address: none(),
        email_digest: none(),
    };
    let mut statement = reader.prepare_cached(READ_OUTCOMES_SQL)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let (channel, outcome) = channel_outcome_of_row(row)?;
        match channel {
            AttentionDeliveryChannel::WebAddress => outcomes.web_address = outcome,
            AttentionDeliveryChannel::EmailDigest => outcomes.email_digest = outcome,
        }
    }
    Ok(outcomes)
}

fn channel_outcome_of_row(
    row: &Row<'_>,
) -> rusqlite::Result<(AttentionDeliveryChannel, ChannelOutcome)> {
    let channel = text_column(row, 0, closed_word)?;
    let undelivered = safe_int_column(row, 4)?;
    let attempted_at: Option<WireInstant> = optional_text_column(row, 1, WireInstant::try_from)?;
    let last_outcome = match attempted_at {
        None => None,
        Some(at) => {
            let http_status = match row.get::<_, Option<i64>>(3)? {
                None => None,
                Some(status) => Some(
                    BoundedInt::new(status)
                        .ok_or(rusqlite::Error::IntegralValueOutOfRange(3, status))?,
                ),
            };
            Some(AttentionDeliveryOutcome {
                at,
                result: text_column(row, 2, closed_word)?,
                http_status,
                undelivered,
            })
        }
    };
    Ok((
        channel,
        ChannelOutcome {
            last_outcome,
            undelivered,
        },
    ))
}

fn channel_binding(channel: AttentionDeliveryChannel) -> (std::borrow::Cow<'static, str>, Value) {
    binding(
        "@channel",
        Value::Text(<&'static str>::from(channel).to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::attention::{
        AttentionDeliveryChannel, AttentionDeliveryOutcome, AttentionDeliveryResult,
    };
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::{BoundedInt, SafeInt};
    use sidekicks_store::database::statement::WriteStatement;

    use super::{
        ChannelOutcome, attempt_outcome_statement, outcome_removal_statement,
        read_delivery_outcomes, undelivered_count_statement,
    };
    use crate::attention::test_log::AttentionTestLog;

    const CHANNEL: AttentionDeliveryChannel = AttentionDeliveryChannel::WebAddress;

    fn instant(text: &str) -> WireInstant {
        WireInstant::try_from(text.to_owned()).expect("a test instant")
    }

    async fn write(log: &AttentionTestLog, statements: Vec<WriteStatement>) {
        log.writer
            .write(statements)
            .await
            .expect("the outcome write is kept");
    }

    fn web_address(log: &AttentionTestLog) -> ChannelOutcome {
        read_delivery_outcomes(&log.database.reader())
            .expect("the outcomes read")
            .web_address
    }

    fn attempt(at: &str, result: AttentionDeliveryResult, status: Option<i64>) -> WriteStatement {
        attempt_outcome_statement(
            CHANNEL,
            &instant(at),
            result,
            status.map(|status| BoundedInt::new(status).expect("a test status")),
        )
    }

    /// Mutations: a give-up that needs an attempted row, a delivery that keeps the count, an
    /// attempt that inserts beside the row instead of overwriting it, a removal that keeps it.
    #[tokio::test]
    async fn a_give_up_counts_before_any_attempt_an_attempt_overwrites_and_a_removal_deletes() {
        let log = AttentionTestLog::new().await;
        write(&log, vec![undelivered_count_statement(CHANNEL)]).await;
        assert_eq!(
            web_address(&log),
            ChannelOutcome {
                last_outcome: None,
                undelivered: SafeInt::new(1).expect("one"),
            },
            "a give-up before any attempt is counted on a row with no attempt"
        );

        write(
            &log,
            vec![
                attempt(
                    "2026-10-29T09:00:00.000Z",
                    AttentionDeliveryResult::Refused,
                    Some(500),
                ),
                undelivered_count_statement(CHANNEL),
            ],
        )
        .await;
        write(
            &log,
            vec![attempt(
                "2026-10-29T09:00:05.000Z",
                AttentionDeliveryResult::TimedOut,
                None,
            )],
        )
        .await;
        let two = SafeInt::new(2).expect("two");
        assert_eq!(
            web_address(&log),
            ChannelOutcome {
                last_outcome: Some(AttentionDeliveryOutcome {
                    at: instant("2026-10-29T09:00:05.000Z"),
                    result: AttentionDeliveryResult::TimedOut,
                    http_status: None,
                    undelivered: two,
                }),
                undelivered: two,
            },
            "the later attempt overwrites the earlier and the count stands"
        );

        write(
            &log,
            vec![attempt(
                "2026-10-29T09:05:00.000Z",
                AttentionDeliveryResult::Delivered,
                Some(204),
            )],
        )
        .await;
        assert_eq!(
            web_address(&log).undelivered,
            SafeInt::ZERO,
            "a delivery clears the count"
        );

        write(&log, vec![outcome_removal_statement(CHANNEL)]).await;
        assert_eq!(
            web_address(&log),
            ChannelOutcome {
                last_outcome: None,
                undelivered: SafeInt::ZERO,
            }
        );
    }
}
