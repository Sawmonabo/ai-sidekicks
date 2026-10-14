//! A transcript row's body, and the reads for what a row does not carry: a row's large body or
//! full output (`transcript.bodyRead`), and every file patch a tool call left out
//! (`transcript.patchRead`). A body travels with its row unless it is large, when the row carries
//! its size alone. Both reads answer with the stored text, or `absent` when none is stored.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::declared_variants::{
    CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_PAYLOAD_PLAINTEXT_MAX, CONTENT_TRUNCATED_PAYLOAD_KEY,
};
use crate::event::envelope::HydratedContentUnavailableReason;
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::byte_length::{fits_budget, json_utf8_byte_length};
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::session::id::SessionId;
use crate::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText};
use crate::wire::{BoolLiteral, True};

/// A stored body: at most [`CONTENT_PAYLOAD_PLAINTEXT_MAX`] code points, the cap its event's
/// payload holds it to.
pub type StoredBodyText = BoundedText<0, CONTENT_PAYLOAD_PLAINTEXT_MAX>;

/// What a row read from history carries of its body: the body itself, why there is none, or the
/// size alone of a large one. An `available` body serializes to at most 32,768 JSON bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TranscriptRowContent {
    /// The body travels with its row.
    Available {
        /// The body; a prefix when `contentTruncated` is `true`. A body whose JSON takes more than
        /// [`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`] bytes belongs on the `large` arm.
        #[schemars(extend("maxJsonBytes" = TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES))]
        #[garde(custom(|body: &BoundedText<0, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES>, (): &()| {
            fits_budget(body, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES)
        }))]
        body: BoundedText<0, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES>,
        /// The whole body's UTF-8 byte length, echoed from the stored payload.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        content_length: Option<SafeInt<0>>,
        /// Present when the stored body is a prefix of a longer one the producer cut.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        content_truncated: Option<True>,
    },
    /// No body can be read.
    Unavailable {
        /// Why.
        reason: HydratedContentUnavailableReason,
    },
    /// The body is too large to travel with its row: its size alone.
    Large {
        /// The whole body's UTF-8 byte length, as the stored event states it.
        content_length: SafeInt<0>,
        /// Present when the stored body is a prefix of a longer one the producer cut.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        content_truncated: Option<True>,
    },
}

/// The length and truncation mark a stored event's payload states for its body, echoed rather
/// than recomputed: a length measured from a cut body would hide that anything was cut.
fn echoed_body_facts_of(
    payload: Option<&Map<String, Value>>,
) -> (Option<SafeInt<0>>, Option<True>) {
    let content_length = payload
        .and_then(|payload| payload.get(CONTENT_LENGTH_PAYLOAD_KEY))
        .and_then(Value::as_u64)
        .and_then(SafeInt::new);
    let content_truncated = payload
        .and_then(|payload| payload.get(CONTENT_TRUNCATED_PAYLOAD_KEY))
        .and_then(Value::as_bool)
        .filter(|is_truncated| *is_truncated)
        .map(|_| BoolLiteral);
    (content_length, content_truncated)
}

/// A `transcript.bodyRead` offset that is no place to resume from: inside a character, or past
/// the body's end. It is refused on the request's `offset` path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("offset {offset} is inside a character or past the body's {body_length} bytes")]
pub struct BodyReadOffsetRefused {
    /// The refused offset.
    pub offset: usize,
    /// The body's UTF-8 byte length.
    pub body_length: usize,
}

/// An event's stored body as `transcript.bodyRead` reports it, the part that starts at `offset`:
/// `absent` when none is stored, never an empty `available` body, which would claim the agent said
/// nothing. A part holds as much of the body as fits one page and names where the next part
/// starts, so a client reading from each `nextOffset` until it is `null` joins the whole body. The
/// length and truncation mark are the payload's own.
pub fn stored_body_content_of(
    payload: Option<&Map<String, Value>>,
    stored_body: Option<&StoredBodyText>,
    offset: usize,
) -> Result<TranscriptBodyReadResponse, BodyReadOffsetRefused> {
    let Some(stored_body) = stored_body else {
        return Ok(TranscriptBodyReadResponse::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        });
    };
    let body = stored_body.as_str();
    if !body.is_char_boundary(offset) {
        return Err(BodyReadOffsetRefused {
            offset,
            body_length: body.len(),
        });
    }
    let end = page_end(body, offset);
    let (content_length, content_truncated) = echoed_body_facts_of(payload);
    Ok(TranscriptBodyReadResponse::Available {
        body: StoredBodyText::new(body[offset..end].to_owned())
            .expect("a part of a stored body is within the stored body's cap"),
        offset: byte_offset(offset),
        next_offset: (end < body.len()).then(|| byte_offset(end)),
        content_length,
        content_truncated,
    })
}

/// A byte offset into a stored body, which its cap keeps far below 2^53.
fn byte_offset(offset: usize) -> SafeInt<0> {
    u64::try_from(offset)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored body's byte offsets lie far below 2^53")
}

/// Where the part of `body` that starts at `offset` ends: the furthest character boundary whose
/// stretch's JSON fits [`PAGE_MAX_BYTES`], measured as the reply's check measures it. One
/// character's JSON is at most eight bytes, so a part short of the end holds at least one.
fn page_end(body: &str, offset: usize) -> usize {
    let fits = |end: usize| {
        json_utf8_byte_length(&&body[offset..end]).is_ok_and(|length| length <= PAGE_MAX_BYTES)
    };
    if fits(body.len()) {
        return body.len();
    }
    // The fitting ends form a prefix of the boundaries, so the last one is found by halving the
    // byte range between a boundary that fits and one that does not.
    let (mut fitting, mut over) = (offset, body.len());
    loop {
        let middle = body.floor_char_boundary(fitting + (over - fitting) / 2);
        if middle == fitting {
            break;
        }
        if fits(middle) {
            fitting = middle;
        } else {
            over = middle;
        }
    }
    (fitting > offset)
        .then_some(fitting)
        .expect("one character's JSON fits a page")
}

/// A stored body as a row read finds it: its UTF-8 size, and its text when that size still lets it
/// travel with its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredRowBody<'body> {
    /// The body's UTF-8 byte length.
    pub byte_length: SafeInt<0>,
    /// The body's text, when it was read.
    pub body: Option<&'body str>,
}

/// The body a row carries, from what the read found stored: none is `absent`; a body whose JSON
/// takes more than [`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`] bytes, or whose text was not read, is
/// the `large` arm, sized by the payload's `contentLength`, else by its stored bytes.
pub fn transcript_row_content_of(
    payload: Option<&Map<String, Value>>,
    stored: Option<StoredRowBody<'_>>,
) -> TranscriptRowContent {
    let Some(stored) = stored else {
        return TranscriptRowContent::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        };
    };
    let (content_length, content_truncated) = echoed_body_facts_of(payload);
    if let Some(body) = stored
        .body
        .filter(|body| fits_budget(body, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES).is_ok())
        && let Some(body) = BoundedText::new(body.to_owned())
    {
        return TranscriptRowContent::Available {
            body,
            content_length,
            content_truncated,
        };
    }
    TranscriptRowContent::Large {
        content_length: content_length.unwrap_or(stored.byte_length),
        content_truncated,
    }
}

/// The one row whose large body or full output a client opens. `rowId` is the row's `id`, the id
/// of the event the row renders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptBodyReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// The row.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where the part starts: a UTF-8 byte offset into the body, on a character boundary and not
    /// past its end; the body's start when absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub offset: Option<SafeInt<0>>,
}

/// The row's body, one part at a time, or why it cannot be read. `contentLength` and
/// `contentTruncated` are echoed from the stored event, so a body kept as a prefix still says how
/// long the whole was. Each part fits one page; a body longer than one page comes back whole in
/// consecutive parts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TranscriptBodyReadResponse {
    /// The body.
    Available {
        /// This part of the body; the whole is a prefix when `contentTruncated` is `true`.
        #[garde(custom(fits_one_page))]
        #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
        body: StoredBodyText,
        /// Where this part starts, as a UTF-8 byte offset into the body.
        offset: SafeInt<0>,
        /// Where the next part starts, or `null` on the last part.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
        next_offset: Option<SafeInt<0>>,
        /// The whole body's UTF-8 byte length, echoed from the stored payload.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        content_length: Option<SafeInt<0>>,
        /// Present when the stored body is a prefix of a longer one the producer cut.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        content_truncated: Option<True>,
    },
    /// No body can be read.
    Unavailable {
        /// Why.
        reason: HydratedContentUnavailableReason,
    },
}

/// Where a part of a patch read starts: the left-out file's index in the call's `omittedPatches`
/// order, and a UTF-8 byte offset into its patch, on a character boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPatchCursor {
    /// The file's index.
    pub file_index: SafeInt<0>,
    /// The byte offset into its patch.
    pub offset: SafeInt<0>,
}

/// The tool call whose left-out patches a diff needs, from `cursor` on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// The tool call.
    pub tool_call_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where the part starts; the first file's start when absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptPatchCursor")]
    pub cursor: Option<TranscriptPatchCursor>,
}

/// One file's patch with the lines it adds and removes. The counts come from the provider's own
/// report where it sends them, else from the patch's lines.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchFileRead {
    /// The file's path.
    pub path: FilesystemPath,
    /// The patch.
    pub patch: BoundedText<0, CONTENT_PAYLOAD_PLAINTEXT_MAX>,
    /// The lines it adds.
    pub additions: SafeInt<0>,
    /// The lines it removes.
    pub deletions: SafeInt<0>,
}

/// One file whose patch cannot be read, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct TranscriptPatchFileUnavailable {
    /// The file's path.
    pub path: FilesystemPath,
    /// Why its patch cannot be read.
    pub unavailable: HydratedContentUnavailableReason,
}

/// One file's patch, or why it cannot be read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptPatchFile {
    /// The patch.
    Read(#[garde(dive)] TranscriptPatchFileRead),
    /// Why it cannot be read.
    Unavailable(#[garde(skip)] TranscriptPatchFileUnavailable),
}

/// The patches the call left out from the request's `cursor` on, as many as fit one page, so a
/// call with several missing files is drawn from few reads. The first entry's patch starts at the
/// cursor's offset and the last one's ends where `next` starts; the client joins the pieces of one
/// file in order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchReadResponse {
    /// The files.
    #[garde(dive, custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub files: Vec<TranscriptPatchFile>,
    /// Where the next part starts, or `null` on the last part.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<TranscriptPatchCursor>")]
    pub next: Option<TranscriptPatchCursor>,
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{Map, Value};

    use rstest::rstest;

    use super::{
        BodyReadOffsetRefused, StoredBodyText, StoredRowBody, TranscriptBodyReadResponse,
        TranscriptRowContent, stored_body_content_of, transcript_row_content_of,
    };
    use crate::wire::integer::SafeInt;

    /// The table the client's content readers' suite reads too.
    const CASES: &str = include_str!("../../tests/fixtures/transcript/stored-body.json");

    /// What a case finds stored: the body's UTF-8 size, and its text when it was read.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StoredCase {
        byte_length: SafeInt<0>,
        body: Option<String>,
    }

    /// One case: the stored event's payload and body, and what each read answers.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BodyCase {
        note: String,
        payload: Option<Map<String, Value>>,
        stored: Option<StoredCase>,
        body_read: TranscriptBodyReadResponse,
        row_content: TranscriptRowContent,
    }

    #[test]
    fn a_stored_body_reads_as_the_client_reads_it() {
        let cases: Vec<BodyCase> = serde_json::from_str(CASES).expect("the cases read");
        for case in cases {
            let payload = case.payload.as_ref();
            let body = case
                .stored
                .as_ref()
                .and_then(|stored| stored.body.clone())
                .map(|body| StoredBodyText::new(body).expect("a stored body within its cap"));
            assert_eq!(
                stored_body_content_of(payload, body.as_ref(), 0)
                    .expect("the body's start is an offset"),
                case.body_read,
                "{}",
                case.note
            );
            let stored = case.stored.as_ref().map(|stored| StoredRowBody {
                byte_length: stored.byte_length,
                body: stored.body.as_deref(),
            });
            assert_eq!(
                transcript_row_content_of(payload, stored),
                case.row_content,
                "{}",
                case.note
            );
        }
    }

    /// Reads `body` part by part from `offset` until a part names no next one, answering the parts
    /// joined and how many there were.
    fn read_from(body: &str, offset: usize) -> Result<(String, usize), BodyReadOffsetRefused> {
        let stored = StoredBodyText::new(body.to_owned()).expect("a body within its cap");
        let mut joined = String::new();
        let mut part_count = 0;
        let mut next = Some(offset);
        while let Some(offset) = next {
            let TranscriptBodyReadResponse::Available {
                body, next_offset, ..
            } = stored_body_content_of(None, Some(&stored), offset)?
            else {
                panic!("a stored body is available");
            };
            joined.push_str(body.as_str());
            part_count += 1;
            next = next_offset.map(|next_offset| {
                usize::try_from(next_offset.get()).expect("an offset fits usize")
            });
        }
        Ok((joined, part_count))
    }

    #[rstest]
    // Each control character takes six JSON bytes, so 200,000 of them span two pages.
    #[case::over_one_page("\u{1}".repeat(200_000), 0, Some(2))]
    #[case::from_a_later_offset("a\u{e9}b".to_owned(), 3, Some(1))]
    #[case::at_the_end("ab".to_owned(), 2, Some(1))]
    #[case::inside_a_character("a\u{e9}b".to_owned(), 2, None)]
    #[case::past_the_end("ab".to_owned(), 3, None)]
    fn a_body_read_in_parts_joins_back_whole_from_any_character_boundary(
        #[case] body: String,
        #[case] offset: usize,
        #[case] part_count: Option<usize>,
    ) {
        let read = read_from(&body, offset);
        match part_count {
            Some(part_count) => assert_eq!(read, Ok((body[offset..].to_owned(), part_count))),
            None => assert_eq!(
                read,
                Err(BodyReadOffsetRefused {
                    offset,
                    body_length: body.len()
                })
            ),
        }
    }
}
