//! Bytes on the wire travel beside a message's JSON as attachments: the JSON holds the placeholder
//! `{"$bytes": <index>}` and the bytes ride after it. [`parse`] reads a message with its
//! attachments and [`write`] produces them; each attachment is referenced exactly once.

use std::borrow::Cow;
use std::cell::RefCell;

use bytes::Bytes as ByteBuffer;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{DeserializeOwned, Error as _};
use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Why a message's attachments do not match its JSON.
#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    /// The JSON does not parse as the type, a placeholder's own fault among the causes: an index
    /// past the attachments, an attachment referenced twice, or a size outside the member's bounds.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// An attachment no placeholder references.
    #[error("attachment {index} is not referenced")]
    Unreferenced {
        /// The unreferenced attachment's index.
        index: usize,
    },
}

/// The attachments of the message being parsed on this thread, and which ones a placeholder took.
struct Incoming {
    attachments: Vec<ByteBuffer>,
    is_taken: Vec<bool>,
}

thread_local! {
    static INCOMING: RefCell<Option<Incoming>> = const { RefCell::new(None) };
    static OUTGOING: RefCell<Option<Vec<ByteBuffer>>> = const { RefCell::new(None) };
}

/// Restores the thread's previous attachment context when a parse or a write ends, a panic among
/// the ways, so a nested or later call never reads another message's attachments.
struct ContextGuard<T: 'static> {
    cell: &'static std::thread::LocalKey<RefCell<Option<T>>>,
    previous: Option<Option<T>>,
}

impl<T> ContextGuard<T> {
    fn enter(cell: &'static std::thread::LocalKey<RefCell<Option<T>>>, context: T) -> Self {
        let previous = cell.with(|slot| slot.replace(Some(context)));
        Self {
            cell,
            previous: Some(previous),
        }
    }

    fn take(mut self) -> Option<T> {
        let previous = self.previous.take().flatten();
        self.cell.with(|slot| slot.replace(previous))
    }
}

impl<T> Drop for ContextGuard<T> {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            self.cell.with(|slot| slot.replace(previous));
        }
    }
}

/// Parses one message's JSON with its attachments. Refuses a JSON the type refuses, a placeholder
/// past the attachments or repeated, a size outside a member's bounds, and an attachment nothing
/// references.
pub fn parse<T: DeserializeOwned>(
    json: &[u8],
    attachments: Vec<ByteBuffer>,
) -> Result<T, AttachmentError> {
    let is_taken = vec![false; attachments.len()];
    let guard = ContextGuard::enter(
        &INCOMING,
        Incoming {
            attachments,
            is_taken,
        },
    );
    let parsed = serde_json::from_slice::<T>(json);
    let incoming = guard
        .take()
        .expect("the guard holds this parse's attachments");
    let value = parsed?;
    match incoming.is_taken.iter().position(|is_taken| !is_taken) {
        Some(index) => Err(AttachmentError::Unreferenced { index }),
        None => Ok(value),
    }
}

/// Writes one message: its JSON with a placeholder for each byte member, and the attachments in
/// placeholder order. Fails only where `value`'s own `Serialize` fails.
pub fn write<T: Serialize>(value: &T) -> Result<(Vec<u8>, Vec<ByteBuffer>), serde_json::Error> {
    let guard = ContextGuard::enter(&OUTGOING, Vec::new());
    let json = serde_json::to_vec(value);
    let attachments = guard
        .take()
        .expect("the guard holds this write's attachments");
    Ok((json?, attachments))
}

/// The placeholder every byte member is written as, `$defs/Bytes` in the schemas; TypeScript reads
/// the member as a `Uint8Array`.
pub struct BytesPlaceholder;

impl JsonSchema for BytesPlaceholder {
    fn schema_name() -> Cow<'static, str> {
        "Bytes".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "Bytes that travel beside the message's JSON, as the attachment the \
                            placeholder names.",
            "type": "object",
            "properties": { "$bytes": { "type": "integer", "minimum": 0, "maximum": u32::MAX } },
            "required": ["$bytes"],
            "additionalProperties": false,
            "tsType": "Uint8Array",
        })
    }
}

/// The placeholder as JSON holds it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Placeholder {
    #[serde(rename = "$bytes")]
    index: u32,
}

/// `MIN..=MAX` bytes, carried as an attachment of the message that holds them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bytes<const MIN: usize, const MAX: usize>(ByteBuffer);

impl<const MIN: usize, const MAX: usize> Bytes<MIN, MAX> {
    /// `bytes` when their length lies in `MIN..=MAX`, else `None`.
    pub fn new(bytes: ByteBuffer) -> Option<Self> {
        (MIN..=MAX).contains(&bytes.len()).then_some(Self(bytes))
    }

    /// The bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// The bytes, consuming the value.
    pub fn into_bytes(self) -> ByteBuffer {
        self.0
    }
}

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Bytes<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Placeholder { index } = Placeholder::deserialize(deserializer)?;
        let index = usize::try_from(index).map_err(D::Error::custom)?;
        INCOMING.with(|slot| {
            let mut slot = slot.borrow_mut();
            let incoming = slot
                .as_mut()
                .ok_or_else(|| D::Error::custom("bytes read outside a message"))?;
            let bytes = incoming.attachments.get(index).ok_or_else(|| {
                D::Error::custom(format!("the message has no attachment {index}"))
            })?;
            if incoming.is_taken[index] {
                return Err(D::Error::custom(format!(
                    "attachment {index} is referenced twice"
                )));
            }
            let length = bytes.len();
            let bytes = Self::new(bytes.clone()).ok_or_else(|| {
                D::Error::custom(format!("{length} bytes is outside {MIN}..={MAX}"))
            })?;
            incoming.is_taken[index] = true;
            Ok(bytes)
        })
    }
}

impl<const MIN: usize, const MAX: usize> Serialize for Bytes<MIN, MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let index = OUTGOING.with(|slot| {
            let mut slot = slot.borrow_mut();
            let outgoing = slot
                .as_mut()
                .ok_or_else(|| S::Error::custom("bytes written outside a message"))?;
            outgoing.push(self.0.clone());
            Ok(outgoing.len() - 1)
        })?;
        let mut placeholder = serde_json::Map::new();
        placeholder.insert("$bytes".into(), index.into());
        placeholder.serialize(serializer)
    }
}

impl<const MIN: usize, const MAX: usize> JsonSchema for Bytes<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Bytes{MIN}To{MAX}").into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = generator.subschema_for::<BytesPlaceholder>();
        if MIN > 0 {
            schema.insert("minBytes".into(), MIN.into());
        }
        schema.insert("maxBytes".into(), MAX.into());
        schema.insert("tsType".into(), "Uint8Array".into());
        schema
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes as ByteBuffer;
    use proptest::prelude::*;
    use serde::{Deserialize, Serialize};

    use super::{AttachmentError, Bytes, parse, write};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Frame {
        audio: Bytes<1, 8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marker: Option<Bytes<0, 2>>,
    }

    fn buffers(attachments: &[&[u8]]) -> Vec<ByteBuffer> {
        attachments
            .iter()
            .map(|bytes| ByteBuffer::copy_from_slice(bytes))
            .collect()
    }

    #[test]
    fn each_attachment_is_referenced_exactly_once_and_within_its_bounds() {
        let accepted: Frame = parse(
            br#"{"audio":{"$bytes":1},"marker":{"$bytes":0}}"#,
            buffers(&[b"m", b"abc"]),
        )
        .expect("both attachments are referenced once");
        assert_eq!(accepted.audio.as_bytes(), b"abc");

        for (json, attachments) in [
            (
                r#"{"audio":{"$bytes":0},"marker":{"$bytes":0}}"#,
                vec![&b"ab"[..]],
            ),
            (r#"{"audio":{"$bytes":2}}"#, vec![&b"a"[..], &b"b"[..]]),
            (r#"{"audio":{"$bytes":0}}"#, vec![&b""[..]]),
            (r#"{"audio":{"$bytes":0}}"#, vec![&b"123456789"[..]]),
            (r#"{"audio":{"$bytes":0,"x":1}}"#, vec![&b"a"[..]]),
            (r#"{"audio":"YQ=="}"#, vec![&b"a"[..]]),
        ] {
            assert!(
                matches!(
                    parse::<Frame>(json.as_bytes(), buffers(&attachments)),
                    Err(AttachmentError::Json(_))
                ),
                "{json} is refused"
            );
        }
        assert!(matches!(
            parse::<Frame>(br#"{"audio":{"$bytes":0}}"#, buffers(&[b"a", b"b"])),
            Err(AttachmentError::Unreferenced { index: 1 })
        ));
    }

    proptest! {
        #[test]
        fn a_written_message_parses_back(
            audio in proptest::collection::vec(any::<u8>(), 1..=8),
            marker in proptest::option::of(proptest::collection::vec(any::<u8>(), 0..=2)),
        ) {
            let frame = Frame {
                audio: Bytes::new(audio.into()).expect("within bounds"),
                marker: marker.map(|marker| Bytes::new(marker.into()).expect("within bounds")),
            };
            let (json, attachments) = write(&frame).expect("a frame serializes");
            prop_assert_eq!(parse::<Frame>(&json, attachments).expect("it parses back"), frame);
        }
    }
}
