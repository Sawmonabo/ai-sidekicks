//! A transcript row's body, and the reads for what a row does not carry: a row's large body or
//! full output (`transcript.body.read`), and every file patch a tool call left out
//! (`transcript.patch.list`). A body travels with its row unless it is large, when the row carries
//! its size alone. Both reads answer with the stored text, or why there is none.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::declared_variants::CONTENT_LENGTH_PAYLOAD_KEY;
use crate::event::envelope::HydratedContentUnavailableReason;
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::byte_length::{fits_budget, json_utf8_byte_length};
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::provider::tool_call::ToolCallId;
use crate::session::id::SessionId;
use crate::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;
use crate::wire::attachment::Bytes;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText};
use crate::wire::{Never, literal};

/// A part of a stored body as one read answers it: at most one page, so at most a page's bytes in
/// code points.
pub type StoredBodyText = BoundedText<0, PAGE_MAX_BYTES>;

/// A prose body's block starts: where each of its markdown blocks begins, as UTF-16 code unit
/// offsets into the whole body, ascending, each a little-endian `u32`. They travel as an
/// attachment and are charged against the page budget with the JSON.
pub type BlockStarts = Bytes<4, PAGE_MAX_BYTES>;

/// Why a prose body carries no block starts: its markdown cut failed, so the screen draws the row
/// with the failure rather than leaving it out. A failed cut fails that row alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BlockCutFailure {
    /// The cut stopped advancing through the text.
    Stalled,
    /// The starts one piece froze take more than one page.
    OverPage,
}

/// Where one block of a prose body starts: in the stored body, as a UTF-8 byte offset, which
/// decides the part of a body read that carries it, and in the text the screen draws, as the UTF-16
/// offset the wire carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyBlockStart {
    /// The block's first character in the stored body, as a UTF-8 byte offset.
    pub stored_offset: usize,
    /// The block's start in the drawn text, as a UTF-16 offset.
    pub drawn_offset: u32,
}

/// What a body read carries of its body's markdown cut: nothing for a body that is not prose, the
/// starts of the whole body, of which each part carries those that fall in it, or why the cut
/// failed, which every part says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyBlockCut<'starts> {
    /// The body is not cut into blocks.
    NotCut,
    /// Every start of the whole body, ascending.
    Starts(&'starts [BodyBlockStart]),
    /// The cut failed.
    Failed(BlockCutFailure),
}

/// What a row read from history carries of its body: the body itself, why there is none, or the
/// size alone of a large one. An `available` body serializes to at most 32,768 JSON bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TranscriptRowContent {
    /// The body travels with its row.
    Available {
        /// The whole body. A body whose JSON takes more than
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
        /// The body's block starts, on a prose body; on a row whose reply is still arriving, only
        /// those no later text can move.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "BlockStarts")]
        block_starts: Option<BlockStarts>,
        /// Why a prose body carries no block starts, when its cut failed; never beside them.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "BlockCutFailure")]
        block_cut_failure: Option<BlockCutFailure>,
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
    },
}

/// The length a stored event's payload states for its body, echoed rather than recomputed, so a
/// reader that loaded only part of the body still reports the whole body's length.
fn echoed_content_length_of(payload: Option<&Map<String, Value>>) -> Option<SafeInt<0>> {
    payload
        .and_then(|payload| payload.get(CONTENT_LENGTH_PAYLOAD_KEY))
        .and_then(Value::as_u64)
        .and_then(SafeInt::new)
}

/// A `transcript.body.read` offset that is no place to resume from: inside a character, or past
/// the body's end. It is refused `transcript.body.offsetInvalid`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("offset {offset} is inside a character or past the body's {body_length} bytes")]
pub struct BodyReadOffsetRefused {
    /// The refused offset, as the client sent it.
    pub offset: u64,
    /// The body's UTF-8 byte length.
    pub body_length: usize,
}

/// A stretch of a row's body that a part is cut from: the stretch's text, where it starts in the
/// whole body and the whole body's UTF-8 length, so a reader of a long body loads only the stored
/// pieces one part needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyWindow<'text> {
    /// The stretch's text.
    pub text: &'text str,
    /// Where the stretch starts in the whole body, as a UTF-8 byte offset.
    pub start: usize,
    /// The whole body's UTF-8 length.
    pub body_length: usize,
}

impl<'text> BodyWindow<'text> {
    /// The window that holds the whole of `body`.
    pub fn whole(body: &'text str) -> Self {
        Self {
            text: body,
            start: 0,
            body_length: body.len(),
        }
    }
}

/// A row's body as `transcript.body.read` reports it, the part that starts at `offset`: `absent`
/// when none is stored, never an empty `available` body, which would claim the agent said nothing.
/// The body is the row's whole body, its pieces joined when the provider sent it in several, read
/// through `window`, which must start at or before `offset`. A part holds as much of the window as
/// fits one page and names where the next part starts, so a client reading from each `nextOffset`
/// until it is `null` joins the whole body. The length is the payload's own. Each part carries the
/// block starts of `block_cut` whose stored offset falls in it, charged against its page, or the
/// cut's failure. Refuses an offset outside the window or inside a character.
pub fn stored_body_content_of(
    payload: Option<&Map<String, Value>>,
    window: Option<BodyWindow<'_>>,
    offset: u64,
    block_cut: BodyBlockCut<'_>,
) -> Result<TranscriptBodyReadResponse, BodyReadOffsetRefused> {
    let Some(window) = window else {
        return Ok(TranscriptBodyReadResponse::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        });
    };
    let text = window.text;
    let Some(start) = usize::try_from(offset)
        .ok()
        .and_then(|offset| offset.checked_sub(window.start))
        .filter(|start| text.is_char_boundary(*start))
    else {
        return Err(BodyReadOffsetRefused {
            offset,
            body_length: window.body_length,
        });
    };
    let (starts, block_cut_failure) = match block_cut {
        BodyBlockCut::NotCut => (&[][..], None),
        BodyBlockCut::Starts(starts) => (starts, None),
        BodyBlockCut::Failed(failure) => (&[][..], Some(failure)),
    };
    // The starts before a place in the window, by the stored offsets they are sorted on.
    let starts_before = |end: usize| {
        starts.partition_point(|block_start| block_start.stored_offset < window.start + end)
    };
    let first_start = starts_before(start);
    // A part's text and the four bytes of each start it carries share one page.
    let end = page_end(text, start, |end, text_bytes| {
        text_bytes + 4 * (starts_before(end) - first_start) <= PAGE_MAX_BYTES
    });
    let part_starts = &starts[first_start..starts_before(end)];
    let block_starts = (!part_starts.is_empty()).then(|| {
        let bytes: Vec<u8> = part_starts
            .iter()
            .flat_map(|block_start| block_start.drawn_offset.to_le_bytes())
            .collect();
        BlockStarts::new(bytes.into()).expect("a part's starts fit the page it was cut to fit")
    });
    let next = window.start + end;
    Ok(TranscriptBodyReadResponse::Available {
        body: StoredBodyText::new(text[start..end].to_owned())
            .expect("a part fits one page, so its code points do"),
        offset: byte_offset(window.start + start),
        next_offset: (next < window.body_length).then(|| byte_offset(next)),
        content_length: echoed_content_length_of(payload),
        block_starts,
        block_cut_failure,
    })
}

/// A byte offset into a body, which the memory holding it keeps far below 2^53.
fn byte_offset(offset: usize) -> SafeInt<0> {
    u64::try_from(offset)
        .ok()
        .and_then(SafeInt::new)
        .expect("a body's byte offsets lie far below 2^53")
}

/// Where the part of `body` that starts at `offset` ends: the furthest character boundary for
/// which `fits` holds of the end and the stretch's JSON bytes, measured as the reply's check
/// measures them; `fits` grows stricter as the end moves on. One character's JSON and its one start
/// fit a page, so a part short of the end holds at least one character.
fn page_end(body: &str, offset: usize, fits: impl Fn(usize, usize) -> bool) -> usize {
    let fits = |end: usize| {
        json_utf8_byte_length(&&body[offset..end]).is_ok_and(|length| fits(end, length))
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

/// A stored body as a row read finds it: its UTF-8 length, and its text when that length still
/// lets it travel with its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredRowBody<'body> {
    /// The body's UTF-8 byte length.
    pub byte_length: SafeInt<0>,
    /// The body's text, when it was read.
    pub body: Option<&'body str>,
}

/// The body a row carries, from what the read found stored: none is `absent`; a body whose JSON
/// takes more than [`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`] bytes, or whose text was not read, is
/// the `large` arm, sized by the payload's `contentLength`, else by `byte_length`.
pub fn transcript_row_content_of(
    payload: Option<&Map<String, Value>>,
    stored: Option<StoredRowBody<'_>>,
) -> TranscriptRowContent {
    let Some(stored) = stored else {
        return TranscriptRowContent::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        };
    };
    let content_length = echoed_content_length_of(payload);
    if let Some(body) = stored
        .body
        .filter(|body| fits_budget(body, TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES).is_ok())
        && let Some(body) = BoundedText::new(body.to_owned())
    {
        return TranscriptRowContent::Available {
            body,
            content_length,
            block_starts: None,
            block_cut_failure: None,
        };
    }
    TranscriptRowContent::Large {
        content_length: content_length.unwrap_or(stored.byte_length),
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

/// The row's body, one part at a time, or why it cannot be read. `contentLength` is echoed from the
/// stored event, so each part says how long the whole is. Each part fits one page; a body longer
/// than one page comes back whole in consecutive parts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum TranscriptBodyReadResponse {
    /// The body.
    Available {
        /// This part of the body.
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
        /// The block starts of a prose body that fall in this part, as UTF-16 offsets into the
        /// whole drawn body; on a body whose reply is still arriving, only those no later text
        /// can move.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "BlockStarts")]
        block_starts: Option<BlockStarts>,
        /// Why a prose body carries no block starts, when its cut failed; never beside them.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "BlockCutFailure")]
        block_cut_failure: Option<BlockCutFailure>,
    },
    /// No body can be read.
    Unavailable {
        /// Why.
        reason: HydratedContentUnavailableReason,
    },
}

/// Where a part of a patch read starts: the left-out file's index in the call's `omittedPatches`
/// order, and a UTF-8 byte offset into its patch or raw text, on a character boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPatchCursor {
    /// The file's index.
    pub file_index: SafeInt<0>,
    /// The byte offset into its patch or raw text.
    pub offset: SafeInt<0>,
}

/// The tool call whose left-out patches a diff needs, from `cursor` on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchListRequest {
    /// The session.
    pub session_id: SessionId,
    /// The tool call.
    pub tool_call_id: ToolCallId,
    /// Where the part starts; the first file's start when absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TranscriptPatchCursor")]
    pub cursor: Option<TranscriptPatchCursor>,
}

literal! {
    /// The `unavailable` word of a file whose provider sent no patch.
    pub enum TranscriptPatchAbsentReason = "absent";

    /// The `unavailable` word of a file whose patch came in a form this version cannot read.
    pub enum TranscriptPatchUnreadableReason = "unreadable";

    /// The `unavailable` word of a file the log cannot read whole.
    pub enum TranscriptPatchDamagedReason = "damaged";
}

/// Declares one arm of [`TranscriptPatchFile`]: the file's path and, for a file the call moved,
/// its old path, then the arm's own members.
macro_rules! transcript_patch_file_arm {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($arm:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The file's path; a file the call moved is named by its new path.
            pub path: FilesystemPath,
            /// The old path of a file the call moved.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FilesystemPath")]
            pub old_path: Option<FilesystemPath>,
            $($arm)*
        }
    };
}

transcript_patch_file_arm! {
    /// One file's patch with the lines it adds and removes. The counts come from the provider's
    /// own report where it sends them, else from the patch's lines.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct TranscriptPatchFileRead {
        /// The patch.
        pub patch: BoundedText<0, PAGE_MAX_BYTES>,
        /// The lines it adds.
        pub additions: SafeInt<0>,
        /// The lines it removes.
        pub deletions: SafeInt<0>,
        /// Never present: the patch was read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub unavailable: Option<Never>,
        /// Never present: the patch was read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub raw_patch: Option<Never>,
    }
}

transcript_patch_file_arm! {
    /// One file whose provider sent no patch.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    pub struct TranscriptPatchFileAbsent {
        /// Always `absent`.
        pub unavailable: TranscriptPatchAbsentReason,
        /// Never present: no patch came.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub patch: Option<Never>,
        /// Never present: no patch came.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub additions: Option<Never>,
        /// Never present: no patch came.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub deletions: Option<Never>,
        /// Never present: no patch came.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub raw_patch: Option<Never>,
    }
}

transcript_patch_file_arm! {
    /// One file whose patch came in a form this version cannot read, with the text as sent.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct TranscriptPatchFileUnreadable {
        /// Always `unreadable`.
        pub unavailable: TranscriptPatchUnreadableReason,
        /// The patch as the provider sent it.
        pub raw_patch: BoundedText<0, PAGE_MAX_BYTES>,
        /// Never present: the patch could not be read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub patch: Option<Never>,
        /// Never present: the patch could not be read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub additions: Option<Never>,
        /// Never present: the patch could not be read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub deletions: Option<Never>,
    }
}

transcript_patch_file_arm! {
    /// One file the log cannot read whole, so its patch cannot be read back.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    pub struct TranscriptPatchFileDamaged {
        /// Always `damaged`.
        pub unavailable: TranscriptPatchDamagedReason,
        /// Never present: the patch cannot be read back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub patch: Option<Never>,
        /// Never present: the patch cannot be read back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub additions: Option<Never>,
        /// Never present: the patch cannot be read back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub deletions: Option<Never>,
        /// Never present: the patch cannot be read back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub raw_patch: Option<Never>,
    }
}

/// One file's patch, or why there is none: no patch came, one came that this version cannot read,
/// or the log cannot read the file whole.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TranscriptPatchFile {
    /// The patch.
    Read(#[garde(dive)] TranscriptPatchFileRead),
    /// No patch came.
    Absent(#[garde(skip)] TranscriptPatchFileAbsent),
    /// The patch as sent, which this version cannot read.
    Unreadable(#[garde(dive)] TranscriptPatchFileUnreadable),
    /// The stored patch cannot be read back.
    Damaged(#[garde(skip)] TranscriptPatchFileDamaged),
}

/// The patches the call left out from the request's `cursor` on, as many as fit one page, so a
/// call with several missing files is drawn from few reads. The first entry's patch or raw text
/// starts at the cursor's offset and the last one's ends where `next` starts; the client joins the
/// pieces of one file in order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptPatchListResponse {
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
    use serde_json::{Map, Value, json};

    use rstest::rstest;

    use super::{
        BodyBlockCut, BodyReadOffsetRefused, BodyWindow, StoredRowBody, TranscriptBodyReadResponse,
        TranscriptPatchFile, TranscriptRowContent, stored_body_content_of,
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
                stored_body_content_of(
                    payload,
                    body.map(BodyWindow::whole),
                    0,
                    BodyBlockCut::NotCut
                )
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
    fn read_from(body: &str, offset: u64) -> Result<(String, usize), BodyReadOffsetRefused> {
        let mut joined = String::new();
        let mut part_count = 0;
        let mut next = Some(offset);
        while let Some(offset) = next {
            let TranscriptBodyReadResponse::Available {
                body, next_offset, ..
            } = stored_body_content_of(
                None,
                Some(BodyWindow::whole(body)),
                offset,
                BodyBlockCut::NotCut,
            )?
            else {
                panic!("a stored body is available");
            };
            joined.push_str(body.as_str());
            part_count += 1;
            next = next_offset.map(SafeInt::get);
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
        #[case] offset: u64,
        #[case] part_count: Option<usize>,
    ) {
        let read = read_from(&body, offset);
        match part_count {
            Some(part_count) => {
                let start = usize::try_from(offset).expect("a test offset fits usize");
                assert_eq!(read, Ok((body[start..].to_owned(), part_count)));
            }
            None => assert_eq!(
                read,
                Err(BodyReadOffsetRefused {
                    offset,
                    body_length: body.len()
                })
            ),
        }
    }

    #[rstest]
    #[case::read_with_its_old_path(
        json!({
            "path": "/w/new.rs",
            "oldPath": "/w/old.rs",
            "patch": "@@ -1 +1 @@\n-a\n+b",
            "additions": 1,
            "deletions": 1
        }),
        Some("read")
    )]
    #[case::absent(json!({"path": "/w/a.rs", "unavailable": "absent"}), Some("absent"))]
    #[case::unreadable(
        json!({"path": "/w/a.rs", "unavailable": "unreadable", "rawPatch": "5"}),
        Some("unreadable")
    )]
    #[case::absent_with_raw_text(
        json!({"path": "/w/a.rs", "unavailable": "absent", "rawPatch": "5"}),
        None
    )]
    #[case::unreadable_without_raw_text(
        json!({"path": "/w/a.rs", "unavailable": "unreadable"}),
        None
    )]
    #[case::null_old_path(
        json!({"path": "/w/a.rs", "oldPath": null, "unavailable": "absent"}),
        None
    )]
    #[case::damaged(
        json!({"path": "/w/a.rs", "oldPath": "/w/b.rs", "unavailable": "damaged"}),
        Some("damaged")
    )]
    #[case::damaged_with_raw_text(
        json!({"path": "/w/a.rs", "unavailable": "damaged", "rawPatch": "5"}),
        None
    )]
    fn a_patch_file_reads_as_its_own_arm(#[case] file: Value, #[case] arm: Option<&str>) {
        let read = serde_json::from_value::<TranscriptPatchFile>(file.clone());

        let Some(arm) = arm else {
            assert!(read.is_err(), "refused, got {read:?}");
            return;
        };
        let read = read.expect("the file reads");
        let read_arm = match &read {
            TranscriptPatchFile::Read(_) => "read",
            TranscriptPatchFile::Absent(_) => "absent",
            TranscriptPatchFile::Unreadable(_) => "unreadable",
            TranscriptPatchFile::Damaged(_) => "damaged",
        };
        assert_eq!(read_arm, arm);
        assert_eq!(serde_json::to_value(&read).expect("the file writes"), file);
    }
}
