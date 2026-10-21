//! The content partition of an append: machine-authored prose kept in
//! `session_events.content_payload` beside the event, with the description members it adds to
//! `payload`, and the check that refuses a payload seeding those members. A tool completion whose
//! body holds file patches is stored across rows: its own keeps the opening of the file list, and
//! each file a row of its own that joins it, so one file is read without the rest. The log
//! service writes the rows; this module touches no database.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{
    CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_PAYLOAD_PLAINTEXT_MAX, CONTENT_TRUNCATED_PAYLOAD_KEY,
};
use sidekicks_contracts::event::registry::SessionEventType;

use crate::text_cut::cut_to_code_points;
use crate::transcript::whole_patch::{
    OMITTED_PATCHES_PAYLOAD_KEY, PATCH_FILES_OPENING, patch_file_piece,
};

/// The `payload` members only this module may set; `contentType` is the producer's.
const CONTENT_DESCRIPTION_PAYLOAD_KEYS: [&str; 2] =
    [CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY];

/// The event types whose registered payload declares the content members, the only ones that may
/// carry a machine-authored content partition.
const BODY_BEARING_EVENT_TYPES: [SessionEventType; 5] = [
    SessionEventType::AgentMessageSent,
    SessionEventType::AgentThinkingUpdated,
    SessionEventType::AgentToolCallInvoked,
    SessionEventType::AgentToolCallCompleted,
    SessionEventType::AgentToolCallFailed,
];

/// A producer pre-seeded a content description member; it names the key only.
#[derive(Debug, thiserror::Error)]
#[error(
    "{refuser} refuses an event whose payload already carries {seeded_key}: the append path is \
     the only producer of {} and {}, each measured from the body it actually stores. Pass the \
     prose as the content body; contentType is the producer's member and is unaffected.",
    CONTENT_LENGTH_PAYLOAD_KEY,
    CONTENT_TRUNCATED_PAYLOAD_KEY
)]
pub(crate) struct ContentDescriptionSeededError {
    /// Who refused, as the append path names itself.
    pub(crate) refuser: &'static str,
    /// The member the payload already carried.
    pub(crate) seeded_key: &'static str,
}

/// Refuses a payload that pre-seeds a content description member, so a false length or truncation
/// claim cannot be stored on either append path.
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
pub(crate) struct ContentPartitionRefusedError {
    /// The envelope's type.
    pub(crate) event_type: String,
}

fn body_bearing_type_names() -> String {
    BODY_BEARING_EVENT_TYPES
        .map(SessionEventType::as_str)
        .join(", ")
}

/// Adds to `payload` the description of `body`, an event of `event_type`'s machine-authored prose,
/// and returns the bytes `content_payload` holds: the body's UTF-8, or its prefix when it is over
/// `CONTENT_PAYLOAD_PLAINTEXT_MAX` code points, the cap a stored body is read back under, cut at a
/// character boundary, not refused, since refusing would drop the turn; a patch-bearing completion
/// is stored by [`compose_patch_file_rows`] instead. Fails on a type that declares no content
/// members.
pub(crate) fn compose_content_payload(
    event_type: SessionEventType,
    payload: &mut Map<String, Value>,
    body: &str,
) -> Result<Vec<u8>, ContentPartitionRefusedError> {
    if !BODY_BEARING_EVENT_TYPES.contains(&event_type) {
        return Err(ContentPartitionRefusedError {
            event_type: event_type.as_str().to_owned(),
        });
    }
    // The length reported is the whole body's, so a cut row still says how much was dropped.
    let stored_body = cut_to_code_points(body, CONTENT_PAYLOAD_PLAINTEXT_MAX);
    payload.insert(
        CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
        Value::from(body.len()),
    );
    if stored_body.len() < body.len() {
        payload.insert(CONTENT_TRUNCATED_PAYLOAD_KEY.to_owned(), Value::Bool(true));
    }
    Ok(stored_body.as_bytes().to_vec())
}

/// Whether an event of `event_type` with `payload` is a tool completion naming the files its
/// body's patches cover, whose body is stored across rows, each file whole.
pub(crate) fn is_patch_bearing(event_type: SessionEventType, payload: &Map<String, Value>) -> bool {
    event_type == SessionEventType::AgentToolCallCompleted
        && payload.contains_key(OMITTED_PATCHES_PAYLOAD_KEY)
}

/// A patch-bearing completion whose body is not a list of the files its payload names, which only
/// a producer's mistake can send.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PatchFilesRefusedError {
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
}

/// A patch-bearing completion's body as its rows store it.
pub(crate) struct PatchFileRows {
    /// The completion's own stored body: the opening of the file list.
    pub(crate) opening: Vec<u8>,
    /// Each file's row in the body's order: its payload, the completion's naming that file alone,
    /// and its stored body.
    pub(crate) files: Vec<(Map<String, Value>, Vec<u8>)>,
}

/// The body of a patch-bearing completion as read for its cut.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchFilesBody<'body> {
    #[serde(borrow)]
    files: Vec<&'body RawValue>,
}

/// Cuts `body`, the `{"files": [...]}` body of a tool completion whose `payload` names each of its
/// files in `omittedPatches`, into the rows that store it, describing the completion's own body in
/// `payload`: the rows' bodies joined read as the file list again, each file whole. Fails when the
/// body is not a file list or holds another count of files than the payload names.
pub(crate) fn compose_patch_file_rows(
    payload: &mut Map<String, Value>,
    body: &str,
) -> Result<PatchFileRows, PatchFilesRefusedError> {
    let files = serde_json::from_str::<PatchFilesBody<'_>>(body)
        .map_err(PatchFilesRefusedError::Body)?
        .files;
    let named: Vec<Value> = payload
        .get(OMITTED_PATCHES_PAYLOAD_KEY)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if named.len() != files.len() {
        return Err(PatchFilesRefusedError::FileCount {
            named: named.len(),
            held: files.len(),
        });
    }
    let file_rows = files
        .iter()
        .zip(named)
        .enumerate()
        .map(|(index, (file, named_file))| {
            let mut file_payload = payload.clone();
            file_payload.insert(
                OMITTED_PATCHES_PAYLOAD_KEY.to_owned(),
                Value::Array(vec![named_file]),
            );
            let piece = patch_file_piece(file.get(), index, files.len());
            file_payload.insert(
                CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
                Value::from(piece.len()),
            );
            (file_payload, piece.into_bytes())
        })
        .collect();
    payload.insert(
        CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
        Value::from(PATCH_FILES_OPENING.len()),
    );
    Ok(PatchFileRows {
        opening: PATCH_FILES_OPENING.as_bytes().to_vec(),
        files: file_rows,
    })
}
