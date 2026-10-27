//! The content partition of an append: machine-authored prose kept whole in
//! `session_events.content_payload` beside the event, with the description members it adds to
//! `payload` (its length, and its encoding once it is stored compressed), and the check that
//! refuses a payload seeding those members. A tool completion whose
//! body holds file patches is stored across rows: its own keeps the opening of the file list, and
//! each part of each file is a row that joins it, so a range of one file is read without the rest.
//! The log service writes the rows; this module touches no database.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{
    CONTENT_ENCODING_PAYLOAD_KEY, CONTENT_LENGTH_PAYLOAD_KEY,
};
use sidekicks_contracts::event::registry::SessionEventType;

use crate::events::content::codec::StoredBody;
use crate::transcript_whole_patch::{
    OMITTED_PATCHES_PAYLOAD_KEY, PATCH_FILES_OPENING, WholePatchFile, patch_file_parts,
};

/// The `payload` members only this module may set; `contentType` is the producer's.
const CONTENT_DESCRIPTION_PAYLOAD_KEYS: [&str; 2] =
    [CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_ENCODING_PAYLOAD_KEY];

/// A producer pre-seeded a content description member; it names the key only.
#[derive(Debug, thiserror::Error)]
#[error(
    "{refuser} refuses an event whose payload already carries {seeded_key}: the append path is \
     the only producer of {} and {}, each set from the body it actually stores. Pass the prose \
     as the content body; contentType is the producer's member and is unaffected.",
    CONTENT_LENGTH_PAYLOAD_KEY,
    CONTENT_ENCODING_PAYLOAD_KEY
)]
pub struct ContentDescriptionSeededError {
    /// Who refused, as the append path names itself.
    pub(crate) refuser: &'static str,
    /// The member the payload already carried.
    pub(crate) seeded_key: &'static str,
}

/// Refuses a payload that pre-seeds a content description member, so a false length or encoding
/// cannot be stored on either append path.
pub(crate) fn assert_no_seeded_content_description(
    payload: &Map<String, Value>,
    refuser: &'static str,
) -> Result<(), ContentDescriptionSeededError> {
    match CONTENT_DESCRIPTION_PAYLOAD_KEYS
        .into_iter()
        .find(|key| payload.contains_key(*key))
    {
        Some(seeded_key) => Err(ContentDescriptionSeededError {
            refuser,
            seeded_key,
        }),
        None => Ok(()),
    }
}

/// A content partition on an event type whose registered payload declares no content members,
/// which would be stored carrying members its own schema rejects.
#[derive(Debug, thiserror::Error)]
#[error(
    "refuses a content partition on event type {event_type}: machine-authored prose is kept only \
     for {}, the types whose registered payload declares the content members",
    body_bearing_type_names()
)]
pub struct ContentPartitionRefusedError {
    /// The envelope's type.
    pub(crate) event_type: String,
}

fn body_bearing_type_names() -> String {
    SessionEventType::ALL
        .iter()
        .filter(|event_type| event_type.carries_content())
        .map(|event_type| event_type.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Adds to `payload` the description of `body`, an event of `event_type`'s machine-authored prose,
/// and returns the body `content_payload` stores whole, however long; a patch-bearing completion is
/// stored by [`compose_patch_file_rows`] instead. Fails on a type that declares no content members.
pub(crate) fn compose_content_payload(
    event_type: SessionEventType,
    payload: &mut Map<String, Value>,
    body: String,
) -> Result<StoredBody, ContentPartitionRefusedError> {
    if !event_type.carries_content() {
        return Err(ContentPartitionRefusedError {
            event_type: event_type.as_str().to_owned(),
        });
    }
    Ok(describe_stored_body(payload, StoredBody::new(body)))
}

/// Writes into `payload` the length of `body` and, when it is stored compressed, its encoding, and
/// hands the body back.
fn describe_stored_body(payload: &mut Map<String, Value>, body: StoredBody) -> StoredBody {
    payload.insert(
        CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
        Value::from(body.len()),
    );
    if let Some(encoding) = body.encoding() {
        payload.insert(
            CONTENT_ENCODING_PAYLOAD_KEY.to_owned(),
            serde_json::to_value(encoding).expect("an encoding writes as its word"),
        );
    }
    body
}

/// Whether an event of `event_type` with `payload` is a tool completion naming one or more files
/// its body's patches cover, whose body is stored in parts of each file; an empty list names none.
pub(crate) fn is_patch_bearing(event_type: SessionEventType, payload: &Map<String, Value>) -> bool {
    event_type == SessionEventType::AgentToolCallCompleted
        && payload
            .get(OMITTED_PATCHES_PAYLOAD_KEY)
            .and_then(Value::as_array)
            .is_some_and(|named| !named.is_empty())
}

/// A patch-bearing completion whose body is not a list of the files its payload names, which only
/// a producer's mistake can send.
#[derive(Debug, thiserror::Error)]
pub enum PatchFilesRefusedError {
    /// The body does not read as `{"files": [...]}`.
    #[error("a tool completion naming patches carries a body that is not its file list")]
    Body(#[source] serde_json::Error),
    /// The body holds another count of files than the payload names.
    #[error("a tool completion names {named} patched files and its body holds {held}")]
    FileCount {
        /// How many files `omittedPatches` names.
        named: usize,
        /// How many the body holds.
        held: usize,
    },
    /// A file of the body reads as no file's shape.
    #[error("file {file_index} of a tool completion's file list is not a file's patch")]
    File {
        /// The file's place in the list.
        file_index: usize,
        /// Why it does not read.
        #[source]
        cause: serde_json::Error,
    },
}

/// Where one stored part of a patch-bearing completion sits in its file list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PatchPartPlace {
    /// The file it stores part of, by its place in the list.
    pub(crate) file_index: usize,
    /// On a part of the file's text, the UTF-8 offset in the text of its first byte.
    pub(crate) text_offset: Option<usize>,
}

/// A file's place or a text offset of a `PatchPartPlace` as its column stores it; panics only on
/// a value past `i64`, which no stored file list or text reaches.
pub fn stored_index(index: usize) -> i64 {
    i64::try_from(index).expect("a file's place or a text offset lies far below 2^63")
}

/// One stored part of a patch-bearing completion: its payload, its place and its body.
pub(crate) struct PatchPartRow {
    /// The completion's payload without the files it names, describing this part's body alone.
    pub(crate) payload: Map<String, Value>,
    /// Where it sits.
    pub(crate) place: PatchPartPlace,
    /// Its stored body.
    pub(crate) body: StoredBody,
}

/// A patch-bearing completion's body as its rows store it.
pub(crate) struct PatchFileRows {
    /// The completion's own stored body: the opening of the file list.
    pub(crate) opening: StoredBody,
    /// Every part of every file, in the body's order.
    pub(crate) parts: Vec<PatchPartRow>,
}

/// The body of a patch-bearing completion as read for its cut.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchFilesBody<'body> {
    #[serde(borrow)]
    files: Vec<&'body RawValue>,
}

/// Cuts `body`, the `{"files": [...]}` body of a tool completion whose `payload` names each of its
/// files in `omittedPatches`, into the parts that store it, describing the completion's own body in
/// `payload`: the parts' bodies joined read as the file list again, every file whole, and each
/// part holds at most a page of UTF-8. Fails when the body is not a
/// file list, holds another count of files than the payload names, or holds a file of no shape.
pub(crate) fn compose_patch_file_rows(
    payload: &mut Map<String, Value>,
    body: &str,
) -> Result<PatchFileRows, PatchFilesRefusedError> {
    let files = serde_json::from_str::<PatchFilesBody<'_>>(body)
        .map_err(PatchFilesRefusedError::Body)?
        .files;
    let named = payload
        .get(OMITTED_PATCHES_PAYLOAD_KEY)
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if named != files.len() {
        return Err(PatchFilesRefusedError::FileCount {
            named,
            held: files.len(),
        });
    }
    let mut part_payload = payload.clone();
    part_payload.remove(OMITTED_PATCHES_PAYLOAD_KEY);
    let mut parts = Vec::new();
    for (file_index, file) in files.iter().enumerate() {
        let file = serde_json::from_str::<WholePatchFile>(file.get())
            .map_err(|cause| PatchFilesRefusedError::File { file_index, cause })?;
        for part in patch_file_parts(&file, file_index, files.len()) {
            let mut payload = part_payload.clone();
            let body = describe_stored_body(&mut payload, StoredBody::new(part.body));
            parts.push(PatchPartRow {
                payload,
                place: PatchPartPlace {
                    file_index,
                    text_offset: part.text_offset,
                },
                body,
            });
        }
    }
    let opening = describe_stored_body(payload, StoredBody::new(PATCH_FILES_OPENING.to_owned()));
    Ok(PatchFileRows { opening, parts })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{PatchFilesRefusedError, compose_patch_file_rows};

    // Killed by a file no arm reads stored as given, which a later patch read would answer as
    // another arm or fail on.
    #[rstest]
    #[case::a_patch_of_the_wrong_type(json!({ "path": "/repo/a.rs", "patch": 5 }))]
    #[case::an_unreadable_file_with_no_raw_text(
        json!({ "path": "/repo/a.rs", "unavailable": "unreadable" })
    )]
    #[case::an_absent_file_with_a_member_no_arm_takes(
        json!({ "path": "/repo/a.rs", "unavailable": "absent", "patch": "@@" })
    )]
    #[case::a_file_with_no_reason(json!({ "path": "/repo/a.rs" }))]
    fn a_completion_holding_a_file_no_arm_reads_is_refused(#[case] file: Value) {
        let mut payload = json!({ "omittedPatches": [{ "path": "/repo/a.rs", "size": 0 }] })
            .as_object()
            .cloned()
            .expect("the test's payload is an object");
        let body = json!({ "files": [file] }).to_string();

        let refused = compose_patch_file_rows(&mut payload, &body);
        assert!(
            matches!(
                refused,
                Err(PatchFilesRefusedError::File { file_index: 0, .. })
            ),
            "{:?}",
            refused.err()
        );
    }
}
