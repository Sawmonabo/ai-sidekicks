//! The session tools' arguments as the tool route reads them: the received check before serde,
//! the line range's and the reminder delay's written forms, and the rules between fields that
//! garde and the schema hold alike.

use std::num::NonZeroU64;

use garde::Validate;
use rstest::rstest;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::schema::{closed_schema_for, received_check};

use crate::tools::session::ask::SessionAskArguments;
use crate::tools::session::group::SessionGroupArguments;
use crate::tools::session::list::SessionListArguments;
use crate::tools::session::read::{LineRange, SessionReadArguments};
use crate::tools::session::remind::{ReminderDelay, SessionRemindArguments};
use crate::tools::session::search::SessionSearchArguments;
use crate::tools::session::send::SessionSendArguments;
use crate::tools::session::start::SessionStartArguments;
use crate::tools::session::stop::SessionStopArguments;
use crate::tools::session::update::SessionUpdateArguments;
use crate::tools::session::wait::SessionWaitArguments;

/// Reads `message` as the tool route does: the received check, then serde, then garde.
fn read_received<T>(message: Value) -> Result<T, String>
where
    T: JsonSchema + DeserializeOwned + Validate<Context = ()> + 'static,
{
    let check = received_check::<T>().expect("the received check builds");
    if !check.is_valid(&message) {
        return Err("the received check refused it".to_owned());
    }
    let arguments: T = serde_json::from_value(message).map_err(|error| error.to_string())?;
    arguments.validate().map_err(|error| error.to_string())?;
    Ok(arguments)
}

/// Whether garde, and then the type's whole schema, take `message`.
fn taken_by_garde_and_schema<T>(message: &Value) -> (bool, bool)
where
    T: JsonSchema + DeserializeOwned + Validate<Context = ()>,
{
    let arguments: T = serde_json::from_value(message.clone()).expect("the case reads");
    let schema = closed_schema_for::<T>().expect("the schema writes");
    let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
    (arguments.validate().is_ok(), check.is_valid(message))
}

// Every tool's received check builds, and the boundary refuses an unknown member, a camelCase
// spelling of a member and a NUL in a session's name. Killed by dropping `deny_unknown_fields`
// from `SessionReadArguments` or `SessionStartArguments`: the check then lets the member through
// and serde ignores it.
#[test]
fn the_tool_route_builds_each_check_and_refuses_an_unknown_member_or_a_nul() {
    let checks = [
        received_check::<SessionListArguments>(),
        received_check::<SessionSearchArguments>(),
        received_check::<EmptyPayload>(),
        received_check::<SessionReadArguments>(),
        received_check::<SessionUpdateArguments>(),
        received_check::<SessionGroupArguments>(),
        received_check::<SessionStartArguments>(),
        received_check::<SessionSendArguments>(),
        received_check::<SessionAskArguments>(),
        received_check::<SessionWaitArguments>(),
        received_check::<SessionStopArguments>(),
        received_check::<SessionRemindArguments>(),
    ];
    for check in checks {
        check.expect("the received check builds");
    }

    let read = read_received::<SessionReadArguments>(json!({ "session": "builder" }))
        .expect("a plain read is taken");
    assert_eq!(read.session.as_str(), "builder");
    let unknown = json!({ "session": "builder", "session_id": "s-8f21" });
    assert!(read_received::<SessionReadArguments>(unknown).is_err());
    let nul = json!({ "session": "build\u{0}er" });
    assert!(read_received::<SessionReadArguments>(nul).is_err());

    let copy = json!({ "message": "Try Decimal.", "from_session": "builder" });
    let start = read_received::<SessionStartArguments>(copy).expect("a copy's start is taken");
    assert_eq!(
        start
            .from_session
            .map(|session| session.as_str().to_owned()),
        Some("builder".to_owned())
    );
    let camel_case = json!({ "message": "Try Decimal.", "fromSession": "builder" });
    assert!(read_received::<SessionStartArguments>(camel_case).is_err());
    let send = json!({ "to": "builder", "message": "Use Money.", "wait": true });
    read_received::<SessionSendArguments>(send).expect("a send is taken");
    let unknown = json!({ "to": "builder", "message": "Use Money.", "reply_to": "s-8f21" });
    assert!(read_received::<SessionSendArguments>(unknown).is_err());
    let remind = json!({ "in": "20m", "note": "Check CI." });
    let remind = read_received::<SessionRemindArguments>(remind).expect("a reminder is taken");
    assert_eq!(remind.delay.minutes(), 20);
}

// A reminder's delay reads whole minutes or hours of at least 1 into minutes, and refuses a zero,
// a missing unit or count, another unit and a count past the minutes it can hold. Killed by
// dropping the `at least 1` check: `0m` then reads as no delay.
#[rstest]
#[case::minutes("20m", Some(20))]
#[case::hours("2h", Some(120))]
#[case::zero("0m", None)]
#[case::no_unit("20", None)]
#[case::days("2d", None)]
#[case::no_count("m", None)]
#[case::signed("+5m", None)]
#[case::count_overflows("4294967296m", None)]
#[case::hours_overflow("71582789h", None)]
fn a_reminder_delay_reads_minutes_or_hours(#[case] text: &str, #[case] minutes: Option<u32>) {
    let read = text.parse::<ReminderDelay>().ok();
    assert_eq!(read.map(ReminderDelay::minutes), minutes, "{text}");
}

/// A line number in a case table.
fn line(number: u64) -> NonZeroU64 {
    NonZeroU64::new(number).expect("a case's line is not zero")
}

// A line range reads its two forms and refuses a backward span, a zero and other text. Killed by
// dropping the `first <= last` check.
#[rstest]
#[case::span("1-200", Some(LineRange::Span { first: line(1), last: line(200) }))]
#[case::last("-50", Some(LineRange::Last(line(50))))]
#[case::backward("200-1", None)]
#[case::zero_first("0-5", None)]
#[case::zero_count("-0", None)]
#[case::words("abc", None)]
fn a_line_range_reads_a_span_or_a_last_count(
    #[case] text: &str,
    #[case] expected: Option<LineRange>,
) {
    assert_eq!(text.parse::<LineRange>().ok(), expected, "{text}");
}

// Each rule between fields is held by garde and by the schema alike, so the route and any other
// reader of the schema refuse the same call. Killed by dropping any one garde rule, or its
// schema twin.
#[rstest]
#[case::search_names_words(
    taken_by_garde_and_schema::<SessionSearchArguments>,
    json!({ "query": "stripe webhook" }),
    true
)]
#[case::search_names_nothing(
    taken_by_garde_and_schema::<SessionSearchArguments>,
    json!({ "relevance": "high", "project": "shop-api" }),
    false
)]
#[case::update_archives(
    taken_by_garde_and_schema::<SessionUpdateArguments>,
    json!({ "session": "tax-fix", "archived": true }),
    true
)]
#[case::update_changes_nothing(
    taken_by_garde_and_schema::<SessionUpdateArguments>,
    json!({ "session": "tax-fix" }),
    false
)]
#[case::group_deletes(
    taken_by_garde_and_schema::<SessionGroupArguments>,
    json!({ "group": "auth work", "delete": true }),
    true
)]
#[case::group_deletes_and_adds(
    taken_by_garde_and_schema::<SessionGroupArguments>,
    json!({ "group": "auth work", "add": ["builder"], "delete": true }),
    false
)]
#[case::group_does_nothing(
    taken_by_garde_and_schema::<SessionGroupArguments>,
    json!({ "group": "auth work", "delete": false }),
    false
)]
#[case::read_lines_of_an_output(
    taken_by_garde_and_schema::<SessionReadArguments>,
    json!({ "session": "builder", "output": "o-31", "lines": "1-200" }),
    true
)]
#[case::read_lines_without_output(
    taken_by_garde_and_schema::<SessionReadArguments>,
    json!({ "session": "builder", "lines": "-50" }),
    false
)]
#[case::read_turns_and_around(
    taken_by_garde_and_schema::<SessionReadArguments>,
    json!({ "session": "builder", "turns": 3, "around": "h-12" }),
    false
)]
fn a_call_is_taken_only_when_its_fields_combine(
    #[case] taken_by: fn(&Value) -> (bool, bool),
    #[case] message: Value,
    #[case] is_taken: bool,
) {
    let (by_garde, by_schema) = taken_by(&message);
    assert_eq!(by_garde, is_taken, "garde: {message}");
    assert_eq!(by_schema, is_taken, "schema: {message}");
}
