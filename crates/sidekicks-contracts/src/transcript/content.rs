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
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::jsonrpc::byte_length::json_utf8_byte_length;
use crate::jsonrpc::page::fits_one_page;
use crate::session::id::SessionId;
use crate::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::BoolLiteral;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText};

/// Refuses a body whose JSON takes more than [`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`] bytes: it
/// belongs on the `large` arm.
fn fits_with_its_row(
    body: &BoundedText<0, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES>,
    (): &(),
) -> garde::Result {
    let byte_length = json_utf8_byte_length(&body.as_str())
        .map_err(|error| garde::Error::new(format!("the body does not serialize: {error}")))?;
    if byte_length > TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES {
        Err(garde::Error::new(format!(
            "a body that travels with its row takes at most {TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES} \
             JSON bytes; this one takes {byte_length}, so it belongs on the large arm"
        )))
    } else {
        Ok(())
    }
}

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
        /// The body; a prefix when `contentTruncated` is `true`.
        #[garde(custom(fits_with_its_row))]
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
        #[schemars(with = "BoolLiteral<true>")]
        content_truncated: Option<BoolLiteral<true>>,
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
        #[schemars(with = "BoolLiteral<true>")]
        content_truncated: Option<BoolLiteral<true>>,
    },
}

/// The length and truncation mark a stored event's payload states for its body, echoed rather
/// than recomputed: a length measured from a cut body would hide that anything was cut.
fn echoed_body_facts_of(
    payload: Option<&Map<String, Value>>,
) -> (Option<SafeInt<0>>, Option<BoolLiteral<true>>) {
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

/// An event's stored body as `transcript.bodyRead` reports it: `absent` when none is stored, never
/// an empty `available` body, which would claim the agent said nothing. The length and truncation
/// mark are the payload's own.
pub fn stored_body_content_of(
    payload: Option<&Map<String, Value>>,
    stored_body: Option<&str>,
) -> TranscriptBodyReadResponse {
    let Some(stored_body) = stored_body else {
        return TranscriptBodyReadResponse::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        };
    };
    let (content_length, content_truncated) = echoed_body_facts_of(payload);
    TranscriptBodyReadResponse::Available {
        body: stored_body.to_owned(),
        content_length,
        content_truncated,
    }
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
    if let Some(body) = stored.body.filter(|body| {
        json_utf8_byte_length(body)
            .is_ok_and(|length| length <= TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES)
    }) && let Some(body) = BoundedText::new(body.to_owned())
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptBodyReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// The row.
    pub row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// The row's body, or why it cannot be read. `contentLength` and `contentTruncated` are echoed
/// from the stored event, so a body kept as a prefix still says how long the whole was. The body
/// fits one page.
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
        /// The body; a prefix when `contentTruncated` is `true`.
        #[garde(length(chars, max = CONTENT_PAYLOAD_PLAINTEXT_MAX), custom(fits_one_page))]
        #[schemars(length(max = 262_144))]
        body: String,
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
        #[schemars(with = "BoolLiteral<true>")]
        content_truncated: Option<BoolLiteral<true>>,
    },
    /// No body can be read.
    Unavailable {
        /// Why.
        reason: HydratedContentUnavailableReason,
    },
}

/// The tool call whose left-out patches a diff needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPatchReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// The tool call.
    pub tool_call_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// One file's patch with the lines it adds and removes. The counts come from the provider's own
/// report where it sends them, else from the patch's lines.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchFileRead {
    /// The file's path.
    pub path: FreeFormText<FILE_PATH_MAX_LEN>,
    /// The patch.
    #[garde(length(chars, max = CONTENT_PAYLOAD_PLAINTEXT_MAX))]
    #[schemars(length(max = 262_144))]
    pub patch: String,
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
    pub path: FreeFormText<FILE_PATH_MAX_LEN>,
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

/// Every patch the call left out, in one reply that fits one page, so a call with several missing
/// files is drawn from one read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPatchReadResponse {
    /// The files.
    #[garde(dive, custom(fits_one_page))]
    pub files: Vec<TranscriptPatchFile>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/content",
    doc: "A transcript row's body, and the reads for what a row does not carry: a row's large \
          body or full output, and every file patch a tool call left out.",
    definitions: &[
        Definition::read::<TranscriptRowContent>().checked(),
        Definition::read::<TranscriptBodyReadRequest>().checked(),
        Definition::read::<TranscriptBodyReadResponse>().checked(),
        Definition::read::<TranscriptPatchReadRequest>().checked(),
        Definition::read::<TranscriptPatchFile>(),
        Definition::read::<TranscriptPatchReadResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{Map, Value};

    use super::{
        StoredRowBody, TranscriptBodyReadResponse, TranscriptRowContent, stored_body_content_of,
        transcript_row_content_of,
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
                .and_then(|stored| stored.body.as_deref());
            assert_eq!(
                stored_body_content_of(payload, body),
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
}
