//! The ordered pipeline every caller-supplied payload runs before anything of it is kept: the type
//! is read from the payload's own leading bytes, a picture's size from its header, then the payload
//! is moved into the content-addressed store under its SHA-256, which is the pipeline's last act. A
//! payload refused on the way never reaches the store and leaves no row. No file is refused for its
//! type and none is rewritten; the type read decides only what the manifest records and whether a
//! picture goes to a provider as one.
//!
//! - Bytes whose signature names no type are recorded as text when they are valid UTF-8: as the
//!   text type the caller declared, or as plain text when it declared none; anything else is
//!   recorded as an unknown binary. Whether the bytes are UTF-8 is checked as they are written, so
//!   the pipeline rereads nothing.
//! - The caller's file name is kept as metadata only, bounded in length and characters; the stored
//!   payload's path is derived from its digest, so no caller's string is ever part of a path.

use std::future::Future;
use std::path::PathBuf;

use file_format::FileFormat;
use serde_json::Value;
use sidekicks_contracts::artifacts::operations::ArtifactPictureSize;
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{BoundedText, is_ecmascript_whitespace};
use sidekicks_std::text_cut::cut_to_code_points;
use unicode_normalization::UnicodeNormalization as _;
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory as _};

use crate::detection::{DETECTION_PREFIX_BYTES, detect_media_type};
use crate::payload_store::{ContentHash, PayloadStore};
use crate::picture_size::{PictureFormat, read_picture_size};
use crate::refusals::ArtifactError;

// The media type recorded for bytes that are neither a known signature nor UTF-8 text.
const UNKNOWN_MEDIA_TYPE: &str = "application/octet-stream";

// The media type recorded for UTF-8 text the caller declared no text type for.
const PLAIN_TEXT_MEDIA_TYPE: &str = "text/plain";

// The declared types kept for UTF-8 text: every `text/` type, and two text formats filed elsewhere.
const TEXT_MEDIA_TYPE_PREFIX: &str = "text/";
const TEXT_MEDIA_TYPES_OUTSIDE_TEXT: [&str; 2] = ["application/json", "image/svg+xml"];

// The name kept when nothing of the caller's is left once its invisible characters are taken out.
const FALLBACK_FILE_NAME: &str = "attachment";

/// The metadata member that records a file's name, which an attachment's line to an agent shows.
pub const FILE_NAME_MEMBER: &str = "fileName";

/// A payload spooled to a file, with what was counted as it was written.
pub(crate) struct SpooledPayload {
    /// The spool file, on the store's volume.
    pub(crate) spool_path: PathBuf,
    /// The SHA-256 of the spooled bytes.
    pub(crate) content_hash: ContentHash,
    /// The payload's first bytes, at most [`DETECTION_PREFIX_BYTES`].
    pub(crate) leading_bytes: Vec<u8>,
    /// Whether the whole payload is valid UTF-8.
    pub(crate) is_utf8: bool,
    /// The type the caller declared, kept only for UTF-8 text whose signature names no type.
    pub(crate) declared_media_type: Option<String>,
}

/// What the pipeline read of a payload before it is stored: the media type the manifest records,
/// and a picture's size from its header.
pub(crate) struct PayloadReading {
    /// The media type the manifest records.
    pub(crate) media_type: String,
    /// A picture's size; `None` for anything else, or a picture whose header does not read.
    pub(crate) natural_size: Option<ArtifactPictureSize>,
}

/// What the pipeline settled for an admitted payload.
pub(crate) struct AdmittedPayload<Recorded> {
    /// The media type the manifest records.
    pub(crate) derived_media_type: String,
    /// What the reference recorded inside the store's exclusion answered.
    pub(crate) recorded: Recorded,
}

/// Runs the pipeline over `payload`: reads its type and a picture's size, then moves it into
/// `store` and awaits `record_reference` with that reading inside the store's exclusion. Fails as
/// the size's read of the spool does, with the store's failure or with the record's, as
/// [`PayloadStore::admit`] does.
pub(crate) async fn validate_and_store<Recorded, Recording>(
    store: &PayloadStore,
    payload: SpooledPayload,
    record_reference: impl FnOnce(PayloadReading) -> Recording,
) -> Result<AdmittedPayload<Recorded>, ArtifactError>
where
    Recording: Future<Output = Result<Recorded, ArtifactError>>,
{
    let format = detect_media_type(&payload.leading_bytes);
    let derived_media_type = media_type_of(
        format,
        payload.is_utf8,
        payload.declared_media_type.as_deref(),
    );
    let natural_size = match format.and_then(PictureFormat::from_file_format) {
        Some(picture) => {
            let spool_path = payload.spool_path.clone();
            tokio::task::spawn_blocking(move || read_picture_size(&spool_path, picture)).await??
        }
        None => None,
    };
    let recorded = store
        .admit(
            payload.spool_path,
            &payload.content_hash,
            record_reference(PayloadReading {
                media_type: derived_media_type.clone(),
                natural_size,
            }),
        )
        .await?;
    Ok(AdmittedPayload {
        derived_media_type,
        recorded,
    })
}

// The media type recorded for a payload whose leading bytes name `format`, or none: that format's,
// else the declared text type or plain text for UTF-8 bytes, else an unknown binary.
fn media_type_of(
    format: Option<FileFormat>,
    is_utf8: bool,
    declared_media_type: Option<&str>,
) -> String {
    match format {
        Some(format) => format.media_type().to_owned(),
        None if is_utf8 => text_media_type_of(declared_media_type),
        None => UNKNOWN_MEDIA_TYPE.to_owned(),
    }
}

// The declared type's essence when it names text, otherwise plain text.
fn text_media_type_of(declared_media_type: Option<&str>) -> String {
    let essence = declared_media_type.map(|declared| {
        declared
            .split_once(';')
            .map_or(declared, |(essence, _parameters)| essence)
            .trim_matches(is_ecmascript_whitespace)
            .to_lowercase()
    });
    match essence {
        Some(essence)
            if essence.starts_with(TEXT_MEDIA_TYPE_PREFIX)
                || TEXT_MEDIA_TYPES_OUTSIDE_TEXT.contains(&essence.as_str()) =>
        {
            essence
        }
        Some(_) | None => PLAIN_TEXT_MEDIA_TYPE.to_owned(),
    }
}

/// The manifest metadata naming the file at `path`, by its name as [`normalize_file_name`] keeps
/// it.
pub(crate) fn file_name_metadata(path: &str) -> JsonRecord {
    JsonRecord::new(
        [(
            FILE_NAME_MEMBER.to_owned(),
            AnyValue(Value::String(normalize_file_name(path).into_string())),
        )]
        .into(),
    )
    .expect("a file name member is no __proto__")
}

/// A caller's file name as the manifest keeps it: its last path segment that is not blank, without
/// control or format characters, in Unicode NFC, trimmed and cut to the wire's path bound. A name
/// with nothing left is kept as `attachment`.
pub(crate) fn normalize_file_name(file_name: &str) -> BoundedText<1, FILE_PATH_MAX_LEN> {
    let last_segment = file_name
        .split(['/', '\\'])
        .rfind(|segment| !segment.trim_matches(is_ecmascript_whitespace).is_empty())
        .unwrap_or_default();
    let visible: String = last_segment
        .chars()
        .filter(|&character| {
            !matches!(
                character.general_category(),
                GeneralCategory::Control | GeneralCategory::Format
            )
        })
        .nfc()
        .collect();
    let normalized = cut_to_code_points(
        visible.trim_matches(is_ecmascript_whitespace),
        FILE_PATH_MAX_LEN,
    );
    let kept = if normalized.is_empty() {
        FALLBACK_FILE_NAME
    } else {
        normalized
    };
    BoundedText::new(kept.to_owned()).expect("a kept name is 1 to FILE_PATH_MAX_LEN code points")
}

/// A caller's `metadata` with its text [`FILE_NAME_MEMBER`] normalized as [`normalize_file_name`]
/// does, so no line break or invisible character of a name reaches storage or an agent's prompt.
pub(crate) fn normalize_metadata_file_name(metadata: JsonRecord) -> JsonRecord {
    let mut members = metadata.into_map();
    if let Some(AnyValue(serde_json::Value::String(file_name))) = members.get_mut(FILE_NAME_MEMBER)
    {
        *file_name = normalize_file_name(file_name).into_string();
    }
    JsonRecord::new(members)
        .expect("a record with no __proto__ gains none when a value is rewritten")
}

/// Whether a payload written in chunks is valid UTF-8, checked chunk by chunk: a character cut
/// across two chunks is carried, at most three bytes, into the next.
#[derive(Clone, Debug)]
pub(crate) struct Utf8Check {
    carry: [u8; 3],
    carry_len: usize,
    is_valid: bool,
}

impl Default for Utf8Check {
    fn default() -> Self {
        Self {
            carry: [0; 3],
            carry_len: 0,
            is_valid: true,
        }
    }
}

impl Utf8Check {
    /// Checks the next chunk of the payload.
    pub(crate) fn feed(&mut self, mut chunk: &[u8]) {
        if !self.is_valid {
            return;
        }
        if self.carry_len > 0 {
            // The carried bytes start one character; at most three more bytes finish it.
            let taken = chunk.len().min(3);
            let mut joined = [0_u8; 6];
            joined[..self.carry_len].copy_from_slice(&self.carry[..self.carry_len]);
            joined[self.carry_len..self.carry_len + taken].copy_from_slice(&chunk[..taken]);
            let joined = &joined[..self.carry_len + taken];
            let finished_at = match std::str::from_utf8(joined) {
                Ok(_) => joined.len(),
                Err(error) if error.valid_up_to() >= self.carry_len => error.valid_up_to(),
                Err(error) if error.error_len().is_none() && taken == chunk.len() => {
                    // The chunk ended inside the carried character too.
                    self.carry[..joined.len()].copy_from_slice(joined);
                    self.carry_len = joined.len();
                    return;
                }
                Err(_) => {
                    self.is_valid = false;
                    return;
                }
            };
            chunk = &chunk[finished_at - self.carry_len..];
            self.carry_len = 0;
        }
        match std::str::from_utf8(chunk) {
            Ok(_) => {}
            Err(error) if error.error_len().is_none() => {
                let cut = &chunk[error.valid_up_to()..];
                self.carry[..cut.len()].copy_from_slice(cut);
                self.carry_len = cut.len();
            }
            Err(_) => self.is_valid = false,
        }
    }

    /// Whether the whole payload was valid UTF-8; a character still cut at its end is not.
    pub(crate) fn is_utf8(&self) -> bool {
        self.is_valid && self.carry_len == 0
    }
}

/// Keeps a payload's first [`DETECTION_PREFIX_BYTES`] as its chunks are written.
pub(crate) fn keep_leading_bytes(leading_bytes: &mut Vec<u8>, chunk: &[u8]) {
    let room = DETECTION_PREFIX_BYTES.saturating_sub(leading_bytes.len());
    leading_bytes.extend_from_slice(&chunk[..room.min(chunk.len())]);
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{Utf8Check, media_type_of, normalize_file_name};
    use crate::detection::detect_media_type;

    #[rstest]
    #[case::a_signature_wins_over_the_declaration(
        b"%PDF-1.7\n".as_slice(),
        Some("text/plain"),
        "application/pdf"
    )]
    #[case::declared_text_is_kept_for_utf8(
        b"a,b\n1,2\n".as_slice(),
        Some("Text/CSV; charset=utf-8"),
        "text/csv"
    )]
    #[case::utf8_with_no_text_declaration_is_plain_text(
        b"{}".as_slice(),
        Some("application/zip"),
        "text/plain"
    )]
    #[case::utf8_declared_as_json_keeps_it(
        b"{}".as_slice(),
        Some("application/json"),
        "application/json"
    )]
    #[case::invalid_utf8_is_an_unknown_binary(
        b"\xC3\x28 plain".as_slice(),
        Some("text/plain"),
        "application/octet-stream"
    )]
    fn the_recorded_type_is_read_from_the_bytes(
        #[case] bytes: &[u8],
        #[case] declared: Option<&str>,
        #[case] expected: &str,
    ) {
        let mut check = Utf8Check::default();
        check.feed(bytes);
        assert_eq!(
            media_type_of(detect_media_type(bytes), check.is_utf8(), declared),
            expected
        );
    }

    #[rstest]
    #[case::split_across_chunks(&["a\u{e9}\u{20ac}\u{1f600}".as_bytes()], true)]
    #[case::two_byte_cut(&[b"a\xC3".as_slice(), b"\xA9b"], true)]
    #[case::four_byte_cut_in_three(&[b"\xF0".as_slice(), b"\x9F\x98", b"\x80"], true)]
    #[case::cut_at_the_end(&[b"ok\xE2\x82".as_slice()], false)]
    #[case::bad_continuation_across_chunks(&[b"\xE2".as_slice(), b"\x28\xA1"], false)]
    #[case::bad_byte(&[b"ok".as_slice(), b"\xFF"], false)]
    fn a_payload_is_utf8_only_when_every_character_is_whole(
        #[case] chunks: &[&[u8]],
        #[case] expected: bool,
    ) {
        let mut check = Utf8Check::default();
        for chunk in chunks {
            check.feed(chunk);
        }
        assert_eq!(check.is_utf8(), expected);
        // The same bytes cut at every place into two chunks.
        let whole: Vec<u8> = chunks.concat();
        for cut in 0..=whole.len() {
            let mut check = Utf8Check::default();
            check.feed(&whole[..cut]);
            check.feed(&whole[cut..]);
            assert_eq!(check.is_utf8(), expected, "cut at {cut}");
        }
    }

    #[rstest]
    #[case::last_segment(r"C:\Users\me\report.pdf", "report.pdf")]
    #[case::posix_path("../../etc/passwd", "passwd")]
    #[case::trailing_separator("notes/", "notes")]
    #[case::blank_last_segment("a/b/ ", "b")]
    #[case::nul_and_bidi_override("evil\u{0}\u{202e}fdp.exe", "evilfdp.exe")]
    #[case::nfc("e\u{301}t\u{e9}.txt", "\u{e9}t\u{e9}.txt")]
    #[case::nothing_left("\u{200b}\u{0}", "attachment")]
    #[case::empty("", "attachment")]
    fn a_file_name_keeps_its_last_visible_segment(#[case] given: &str, #[case] expected: &str) {
        assert_eq!(normalize_file_name(given).as_str(), expected);
    }
}
