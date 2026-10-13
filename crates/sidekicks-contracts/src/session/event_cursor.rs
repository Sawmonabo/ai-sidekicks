//! The event cursor: an opaque position in a session's event log, and the codec that writes a
//! position as a cursor and reads it back, refusing a cursor that names no position.

use crate::internal::branded::branded_text_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::typescript::{TypeScriptModule, ts_constants};
use crate::wire::integer::MAX_SAFE_INTEGER;

/// The longest event cursor accepted, in code points; a guard against pathological lengths.
pub const EVENT_CURSOR_MAX_LEN: usize = 256;

branded_text_id! {
    /// An opaque position in a session's event log, passed through unchanged. Its format belongs
    /// to the daemon, which writes it with `encode_event_cursor`.
    EventCursor, EVENT_CURSOR_MAX_LEN
}

ts_constants! {
    /// The refusal for an event cursor that names no position in its session's log.
    EVENT_CURSOR_UNRESOLVABLE_CODE = RefusalCode::EventCursorUnresolvable;
    /// The log position before a session's first event, where a read of the whole log starts.
    pub const START_OF_LOG_POSITION: i64 = -1;
}

/// A cursor that names no log position: it is not a canonical decimal integer of at least -1
/// within JavaScript's safe range. Holds the refused cursor, so the refusal can name it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the event cursor {cursor:?} does not name a position in the session's log")]
pub struct EventCursorUnresolvable {
    /// The refused cursor's text.
    pub cursor: String,
}

/// A position no cursor can name: below the start of the log or past JavaScript's safe range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("an event cursor position must be an integer from -1 to 2^53 - 1, not {position}")]
pub struct EventCursorPositionOutOfRange {
    /// The refused position.
    pub position: i64,
}

/// Writes a log position as an [`EventCursor`]: -1 for the start of the log, otherwise an event's
/// sequence. Refuses a position below -1 or past 2^53 − 1.
pub fn encode_event_cursor(position: i64) -> Result<EventCursor, EventCursorPositionOutOfRange> {
    let is_in_range = u64::try_from(position).map_or(position == START_OF_LOG_POSITION, |at| {
        at <= MAX_SAFE_INTEGER
    });
    if !is_in_range {
        return Err(EventCursorPositionOutOfRange { position });
    }
    // At most 16 digits and a sign, inside the cursor's bound.
    Ok(EventCursor::new(position.to_string()).expect("a position's digits fit the cursor bound"))
}

/// Reads the log position an [`EventCursor`] names. Accepts only what [`encode_event_cursor`]
/// writes, so `007`, `+1`, `1e3` and `-0` are refused with [`EventCursorUnresolvable`].
pub fn decode_event_cursor(cursor: &EventCursor) -> Result<i64, EventCursorUnresolvable> {
    let text = cursor.as_str();
    let is_canonical = text == "-1"
        || text == "0"
        || (text.starts_with(|first: char| ('1'..='9').contains(&first))
            && text.bytes().all(|digit| digit.is_ascii_digit()));
    let position = is_canonical
        .then(|| text.parse::<i64>().ok())
        .flatten()
        .filter(|&position| {
            u64::try_from(position)
                .ok()
                .is_none_or(|at| at <= MAX_SAFE_INTEGER)
        });
    position.ok_or_else(|| EventCursorUnresolvable {
        cursor: text.to_owned(),
    })
}

/// The module's TypeScript face: the constants a client reads; the cursor's type sits with the
/// session's ids.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/event-cursor",
    doc: "The event cursor's constants: its refusal code and the position before a session's \
          first event.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{EventCursor, decode_event_cursor, encode_event_cursor};

    /// The table the client's cursor codec suite reads too.
    const CASES: &str = include_str!("../../tests/fixtures/event-cursor.json");

    /// A position and the one cursor that names it, or `null` when none does.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EncodeCase {
        position: i64,
        cursor: Option<String>,
    }

    /// A cursor and the position it names, or `null` when it names none.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct DecodeCase {
        cursor: String,
        position: Option<i64>,
    }

    /// The table: what each position writes and what each cursor reads back.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CursorCases {
        encode: Vec<EncodeCase>,
        decode: Vec<DecodeCase>,
    }

    #[test]
    fn the_codec_writes_one_spelling_per_position_and_refuses_every_other() {
        let cases: CursorCases = serde_json::from_str(CASES).expect("the cases read");
        for case in cases.encode {
            let written = encode_event_cursor(case.position).ok();
            assert_eq!(
                written.as_ref().map(EventCursor::as_str),
                case.cursor.as_deref(),
                "position {}",
                case.position
            );
        }
        for case in cases.decode {
            let cursor = EventCursor::new(case.cursor).expect("a cursor within bounds");
            assert_eq!(
                decode_event_cursor(&cursor).ok(),
                case.position,
                "cursor {cursor:?}"
            );
        }
    }
}
