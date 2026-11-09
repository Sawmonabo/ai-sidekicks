//! The usage rows no figure names yet, as the held requests' repricing reads them: at start only
//! the distinct keys a price list prices them by, never a row, and once a key is priced its rows a
//! page at a time, regrouped into the requests they belong to, a request never split across pages.
//! A page reads only rows their driver handed over and rows another daemon start wrote, so no read
//! reaches a request the live path is still metering.

use std::borrow::Cow;
use std::num::NonZeroU32;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, Row};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, json_list_binding, named_bindings, nullable_text_binding,
    text_binding,
};
use sidekicks_store::database::stored_column::{
    optional_safe_int_column, optional_text_column, text_column,
};

use crate::account::registry::StoredValueRefused;

/// A request key or a speed, region or thread tier as its token event carried it.
type RequestFact = BoundedText<1, EVENT_FIELD_MAX_LEN>;

// Read from the unpriced index alone.
const SELECT_UNPRICED_KEYS_SQL: &str = "
  SELECT DISTINCT provider, account_id, model_id, speed, processing_region
    FROM provider_account_usage_turns
   WHERE cost_usd_micros IS NULL";

// One key's rows with no figure that are held or that another daemon start wrote, a rebuilt row's
// NULL start among them, in request order; `IS` matches a NULL selector as a value.
const UNPRICED_ROWS_SQL: &str = "
  SELECT turn_id, session_id, run_id, subagent_id, occurred_at, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, cache_write_extended_tokens,
         web_search_requests, request_key, thread_speed
    FROM provider_account_usage_turns
   WHERE cost_usd_micros IS NULL AND provider = @provider AND account_id = @account_id
     AND model_id IS @model_id AND speed IS @speed AND processing_region IS @processing_region
     AND (is_held = 1 OR daemon_started_at IS NOT @daemon_started_at)";

// A handed-over request's rows still unpriced; a row a removal took is simply not there.
const MARK_HELD_SQL: &str = "
  UPDATE provider_account_usage_turns SET is_held = 1
   WHERE turn_id IN (SELECT value FROM json_each(@turn_ids)) AND cost_usd_micros IS NULL";

static FIRST_PAGE_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{UNPRICED_ROWS_SQL} ORDER BY request_key, turn_id LIMIT @page_rows"));

// Keyless rows sort first, so past a keyless row come the keyless rows after its turn id, then
// every keyed row. A row-value comparison would read NULL against the NULL key and skip them all.
static AFTER_KEYLESS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{UNPRICED_ROWS_SQL}
     AND ((request_key IS NULL AND turn_id > @turn_id) OR request_key IS NOT NULL)
   ORDER BY request_key, turn_id LIMIT @page_rows"
    )
});

static AFTER_KEYED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{UNPRICED_ROWS_SQL}
     AND request_key >= @request_key
     AND (request_key > @request_key OR turn_id > @turn_id)
   ORDER BY request_key, turn_id LIMIT @page_rows"
    )
});

// The rest of a request a page's limit cut into.
static REQUEST_REST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{UNPRICED_ROWS_SQL}
     AND request_key = @request_key AND turn_id > @turn_id
   ORDER BY turn_id"
    )
});

/// What a price list prices a held row by: its account and the account's provider, and the
/// request's model, speed and region as its token event carried them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UnpricedUsageKey {
    /// The account's provider.
    pub provider: ProviderId,
    /// The account the rows are charged to.
    pub account_id: ProviderAccountId,
    /// The model the requests ran on, `None` where the provider named none.
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The speed tier, `None` for the standard rates.
    pub speed: Option<RequestFact>,
    /// The processing region, `None` for no region multiplier.
    pub processing_region: Option<RequestFact>,
}

/// One held row as a repricing quotes and records it: the token event it projects, where it was
/// spent, and its counts, each `None` where the provider reported none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnpricedUsageRow {
    /// The token event's id, or the minted id of a turn no session owns.
    pub turn_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The session, `None` on a turn no session owns, whose row takes its figure directly.
    pub session_id: Option<SessionId>,
    /// The run within that session.
    pub run_id: Option<RunId>,
    /// The helper the turn is attributed to.
    pub subagent_id: Option<SubagentId>,
    /// When the turn was spent.
    pub occurred_at: WireInstant,
    /// Input, output, cache-read, cache-write and reasoning tokens, in that order.
    pub tokens: [Option<SafeInt<0>>; 5],
    /// The cache write's share at the longer lifetime.
    pub cache_write_extended_tokens: Option<SafeInt<0>>,
    /// The web searches the request ran.
    pub web_search_requests: Option<SafeInt<0>>,
    /// The tier the turn's thread declared, which prices the helpers it spawned.
    pub thread_speed: Option<RequestFact>,
}

/// One held request: the rows sharing its request key, or one keyless row, which is a request of
/// its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnpricedRequest {
    /// The provider's id of the request, `None` for a keyless row.
    pub request_key: Option<RequestFact>,
    /// Its rows in turn id order; never empty.
    pub rows: Vec<UnpricedUsageRow>,
}

/// Where the next page of a key's held rows starts: past the last row a page read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnpricedPageCursor {
    request_key: Option<RequestFact>,
    turn_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// One page of a key's held requests, each whole, and the cursor to the next page, `None` once
/// the key's rows are read to their end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnpricedPage {
    /// The page's requests in request key order, keyless rows first.
    pub(crate) requests: Vec<UnpricedRequest>,
    /// Where the next page starts.
    pub(crate) next: Option<UnpricedPageCursor>,
}

/// The distinct keys of the rows no figure names, and no row; fails as the read or a stored value
/// a key's type refuses fails.
pub(crate) fn read_unpriced_keys(
    connection: &Connection,
) -> rusqlite::Result<Vec<UnpricedUsageKey>> {
    connection
        .prepare_cached(SELECT_UNPRICED_KEYS_SQL)?
        .query_map([], |row| {
            Ok(UnpricedUsageKey {
                provider: text_column(row, 0, |text| {
                    ProviderId::new(text).ok_or(StoredValueRefused("provider id"))
                })?,
                account_id: text_column(row, 1, |text| {
                    ProviderAccountId::new(text).ok_or(StoredValueRefused("account id"))
                })?,
                model_id: optional_text_column(row, 2, FreeFormText::new)?,
                speed: optional_text_column(row, 3, request_fact)?,
                processing_region: optional_text_column(row, 4, request_fact)?,
            })
        })?
        .collect()
}

/// The statement that marks the usage rows `row_ids` of a request its driver left unpriced held,
/// so a page read takes them before the next start; a row already priced keeps its figure unmarked,
/// and one its account's removal took is gone, so neither is refused.
pub fn held_mark_statement(row_ids: &[FreeFormText<EVENT_FIELD_MAX_LEN>]) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(MARK_HELD_SQL),
        bindings: StatementBindings::Named(vec![json_list_binding("@turn_ids", &row_ids)]),
        expected_row_count: None,
    }
}

/// About `page_rows` of `key`'s rows with no figure after `after` (from the first with `None`),
/// then the rest of the last request's rows, grouped into requests: only rows marked held and rows
/// a daemon start other than `daemon_started_at`, this one's, wrote. Fails as the read or a stored
/// value a row's type refuses fails.
pub(crate) fn read_unpriced_page(
    connection: &Connection,
    key: &UnpricedUsageKey,
    daemon_started_at: &WireInstant,
    after: Option<&UnpricedPageCursor>,
    page_rows: NonZeroU32,
) -> rusqlite::Result<UnpricedPage> {
    let mut bindings = page_bindings(key, daemon_started_at);
    bindings.push((
        Cow::Borrowed("@page_rows"),
        Value::Integer(i64::from(page_rows.get())),
    ));
    let sql: &str = match after {
        None => &FIRST_PAGE_SQL,
        Some(cursor) => {
            bindings.push(text_binding("@turn_id", cursor.turn_id.as_str()));
            match &cursor.request_key {
                None => &AFTER_KEYLESS_SQL,
                Some(request_key) => {
                    bindings.push(text_binding("@request_key", request_key.as_str()));
                    &AFTER_KEYED_SQL
                }
            }
        }
    };
    let mut rows = query_rows(connection, sql, &bindings)?;
    let is_full = u32::try_from(rows.len()).is_ok_and(|count| count >= page_rows.get());
    let last = rows.last().map(|(request_key, row)| UnpricedPageCursor {
        request_key: request_key.clone(),
        turn_id: row.turn_id.clone(),
    });
    let mut next = None;
    if let Some(mut cursor) = last.filter(|_| is_full) {
        if let Some(request_key) = &cursor.request_key {
            let mut rest_bindings = page_bindings(key, daemon_started_at);
            rest_bindings.push(text_binding("@request_key", request_key.as_str()));
            rest_bindings.push(text_binding("@turn_id", cursor.turn_id.as_str()));
            let rest = query_rows(connection, &REQUEST_REST_SQL, &rest_bindings)?;
            if let Some((_, row)) = rest.last() {
                cursor.turn_id = row.turn_id.clone();
            }
            rows.extend(rest);
        }
        next = Some(cursor);
    }
    Ok(UnpricedPage {
        requests: group_requests(rows),
        next,
    })
}

// The key's and the start's bindings every page read shares.
fn page_bindings(
    key: &UnpricedUsageKey,
    daemon_started_at: &WireInstant,
) -> Vec<(Cow<'static, str>, Value)> {
    vec![
        text_binding("@daemon_started_at", daemon_started_at.as_str()),
        text_binding("@provider", key.provider.as_str()),
        text_binding("@account_id", key.account_id.as_str()),
        nullable_text_binding("@model_id", key.model_id.as_ref().map(FreeFormText::as_str)),
        nullable_text_binding("@speed", key.speed.as_ref().map(BoundedText::as_str)),
        nullable_text_binding(
            "@processing_region",
            key.processing_region.as_ref().map(BoundedText::as_str),
        ),
    ]
}

fn query_rows(
    connection: &Connection,
    sql: &str,
    bindings: &[(Cow<'static, str>, Value)],
) -> rusqlite::Result<Vec<(Option<RequestFact>, UnpricedUsageRow)>> {
    connection
        .prepare_cached(sql)?
        .query_map(named_bindings(bindings).as_slice(), read_row)?
        .collect()
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<(Option<RequestFact>, UnpricedUsageRow)> {
    let request_key = optional_text_column(row, 12, request_fact)?;
    Ok((
        request_key,
        UnpricedUsageRow {
            turn_id: text_column(row, 0, FreeFormText::new)?,
            session_id: optional_text_column(row, 1, |text| SessionId::new(&text))?,
            run_id: optional_text_column(row, 2, |text| RunId::new(&text))?,
            subagent_id: optional_text_column(row, 3, SubagentId::new)?,
            occurred_at: text_column(row, 4, WireInstant::try_from)?,
            tokens: [
                optional_safe_int_column(row, 5)?,
                optional_safe_int_column(row, 6)?,
                optional_safe_int_column(row, 7)?,
                optional_safe_int_column(row, 8)?,
                optional_safe_int_column(row, 9)?,
            ],
            cache_write_extended_tokens: optional_safe_int_column(row, 10)?,
            web_search_requests: optional_safe_int_column(row, 11)?,
            thread_speed: optional_text_column(row, 13, request_fact)?,
        },
    ))
}

fn request_fact(text: String) -> Result<RequestFact, StoredValueRefused> {
    BoundedText::new(text).ok_or(StoredValueRefused("request fact"))
}

// Rows in request order become requests: a run of rows sharing a key is one, a keyless row its own.
fn group_requests(rows: Vec<(Option<RequestFact>, UnpricedUsageRow)>) -> Vec<UnpricedRequest> {
    let mut requests: Vec<UnpricedRequest> = Vec::new();
    for (request_key, row) in rows {
        match requests.last_mut() {
            Some(request) if request_key.is_some() && request.request_key == request_key => {
                request.rows.push(row);
            }
            Some(_) | None => requests.push(UnpricedRequest {
                request_key,
                rows: vec![row],
            }),
        }
    }
    requests
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;
    use sidekicks_contracts::wire::instant::instant;
    use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
    use sidekicks_store::events::test_log::SessionTestLog;

    use super::*;
    use crate::account::usage_turns::tests::{
        EARLIER_START, LEAD_MODEL, Turn, append, log_with_accounts, priced, recorded_with, turn_id,
    };

    const OTHER_MODEL: &str = "claude-sonnet-4-5";
    // The start the reads run as, after the one that wrote every row, so every unpriced row is
    // read.
    const THIS_START: &str = "2026-10-14T09:00:00.000Z";

    // One row's every field as plain values, so a test reads each one.
    type RowFacts = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        [Option<i64>; 5],
        Option<i64>,
        Option<i64>,
        Option<String>,
    );

    fn row_facts(row: &UnpricedUsageRow) -> RowFacts {
        let count = |count: Option<SafeInt<0>>| count.map(i64::from);
        (
            row.turn_id.as_str().to_owned(),
            row.session_id
                .map(|session| session.text().as_str().to_owned()),
            row.run_id.map(|run| run.text().as_str().to_owned()),
            row.subagent_id
                .as_ref()
                .map(|helper| helper.as_str().to_owned()),
            row.occurred_at.as_str().to_owned(),
            row.tokens.map(count),
            count(row.cache_write_extended_tokens),
            count(row.web_search_requests),
            row.thread_speed
                .as_ref()
                .map(|speed| speed.as_str().to_owned()),
        )
    }

    // Each request's key and its rows' turn ids, in the page's order.
    fn request_turns(page: &UnpricedPage) -> Vec<(Option<String>, Vec<String>)> {
        page.requests
            .iter()
            .map(|request| {
                (
                    request
                        .request_key
                        .as_ref()
                        .map(|key| key.as_str().to_owned()),
                    request
                        .rows
                        .iter()
                        .map(|row| row.turn_id.as_str().to_owned())
                        .collect(),
                )
            })
            .collect()
    }

    // A Fast, US row of the lead model on `account-a` with `counts`, and `members` besides.
    fn fast_us(
        log: &SessionTestLog,
        counts: [u64; 5],
        members: &serde_json::Value,
    ) -> UnsequencedEventEnvelope {
        let mut facts = json!({"speed": "fast", "processingRegion": "us"});
        if let (Some(facts), Some(members)) = (facts.as_object_mut(), members.as_object()) {
            facts.extend(members.clone());
        }
        recorded_with(
            log,
            &Turn {
                account: "account-a",
                generation: 1,
                model: LEAD_MODEL,
                subagent: None,
                counts,
            },
            &facts,
        )
    }

    fn page(
        log: &SessionTestLog,
        key: &UnpricedUsageKey,
        after: Option<&UnpricedPageCursor>,
    ) -> UnpricedPage {
        let page_rows = NonZeroU32::new(2).expect("two is not zero");
        read_unpriced_page(&log.reader(), key, &instant(THIS_START), after, page_rows)
            .expect("the page reads")
    }

    // The turn ids of every page of `key`'s rows, sorted.
    fn every_page_turn(log: &SessionTestLog, key: &UnpricedUsageKey) -> Vec<String> {
        let mut read = Vec::new();
        let mut after = None;
        loop {
            let page = page(log, key, after.as_ref());
            read.extend(
                request_turns(&page)
                    .into_iter()
                    .flat_map(|(_, turns)| turns),
            );
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        read.sort();
        read
    }

    fn fast_us_key() -> UnpricedUsageKey {
        UnpricedUsageKey {
            provider: ProviderId::new("claude".to_owned()).expect("a provider id"),
            account_id: ProviderAccountId::new("account-a".to_owned()).expect("an account id"),
            model_id: Some(FreeFormText::new(LEAD_MODEL.to_owned()).expect("a model id")),
            speed: BoundedText::new("fast".to_owned()),
            processing_region: BoundedText::new("us".to_owned()),
        }
    }

    // Fails when the start read returns anything but the held keys with their selectors as
    // stored, when a page leaves rows ungrouped by request key or splits a request at its edge,
    // when a priced row or another key's row is read again, or when a cursor past a keyless row
    // compares a NULL key as a row value and loses the keyless rows after the first page.
    #[test]
    fn held_rows_read_as_keys_then_as_whole_requests_a_page_at_a_time() {
        let log = log_with_accounts();
        let request_part = fast_us(
            &log,
            [10, 2, 0, 40, 0],
            &json!({"requestKey": "msg-1", "cacheWriteExtendedTokens": 30, "threadSpeed": "fast"}),
        );
        let request_rest = fast_us(&log, [5, 1, 0, 0, 0], &json!({"requestKey": "msg-1"}));
        let keyless = fast_us(&log, [3, 1, 0, 0, 0], &json!({}));
        let other_model = recorded_with(
            &log,
            &Turn {
                account: "account-a",
                generation: 1,
                model: OTHER_MODEL,
                subagent: None,
                counts: [1, 1, 0, 0, 0],
            },
            &json!({}),
        );
        let priced_row = fast_us(&log, [7, 1, 0, 0, 0], &json!({"requestKey": "msg-2"}));
        let cost = priced(&log, &[(&priced_row, 50)]);
        append(
            &log,
            EARLIER_START,
            &[
                request_part.clone(),
                request_rest.clone(),
                keyless.clone(),
                other_model,
                priced_row,
                cost,
            ],
        );

        let keys: HashSet<_> = read_unpriced_keys(&log.reader())
            .expect("the keys read")
            .into_iter()
            .map(|key| {
                (
                    key.provider.as_str().to_owned(),
                    key.account_id.as_str().to_owned(),
                    key.model_id.map(FreeFormText::into_string),
                    key.speed.map(|speed| speed.as_str().to_owned()),
                    key.processing_region
                        .map(|region| region.as_str().to_owned()),
                )
            })
            .collect();
        let held = |model: &str, speed: Option<&str>, region: Option<&str>| {
            (
                "claude".to_owned(),
                "account-a".to_owned(),
                Some(model.to_owned()),
                speed.map(str::to_owned),
                region.map(str::to_owned),
            )
        };
        assert_eq!(
            keys,
            HashSet::from([
                held(LEAD_MODEL, Some("fast"), Some("us")),
                held(OTHER_MODEL, None, None),
            ])
        );

        let fast_us_key = fast_us_key();
        let first = page(&log, &fast_us_key, None);
        let mut request_rows = [&request_part, &request_rest].map(turn_id).to_vec();
        request_rows.sort();
        assert_eq!(
            request_turns(&first),
            [
                (None, vec![turn_id(&keyless)]),
                (Some("msg-1".to_owned()), request_rows.clone()),
            ]
        );
        let session = Some(log.session_id.text().as_str().to_owned());
        let run = Some(log.run_id.text().as_str().to_owned());
        let part_facts: RowFacts = (
            turn_id(&request_part),
            session.clone(),
            run.clone(),
            None,
            request_part.occurred_at.as_str().to_owned(),
            [Some(10), Some(2), Some(0), Some(40), Some(0)],
            Some(30),
            None,
            Some("fast".to_owned()),
        );
        let rest_facts: RowFacts = (
            turn_id(&request_rest),
            session,
            run,
            None,
            request_rest.occurred_at.as_str().to_owned(),
            [Some(5), Some(1), Some(0), Some(0), Some(0)],
            None,
            None,
            None,
        );
        let mut expected_rows = vec![part_facts, rest_facts];
        expected_rows.sort();
        assert_eq!(
            first.requests[1]
                .rows
                .iter()
                .map(row_facts)
                .collect::<Vec<_>>(),
            expected_rows
        );
        let end = page(&log, &fast_us_key, first.next.as_ref());
        assert_eq!((end.requests.len(), end.next), (0, None));

        let more_keyless: Vec<_> = (0..3)
            .map(|_| fast_us(&log, [1, 0, 0, 0, 0], &json!({})))
            .collect();
        append(&log, EARLIER_START, &more_keyless);
        let mut expected: Vec<_> = more_keyless.iter().map(turn_id).collect();
        expected.extend([turn_id(&keyless)]);
        expected.extend(request_rows);
        expected.sort();
        assert_eq!(every_page_turn(&log, &fast_us_key), expected);
    }
}
