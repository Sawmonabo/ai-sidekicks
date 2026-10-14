//! Bytes on the wire travel beside a message's JSON as attachments: the JSON holds the placeholder
//! `{"$bytes": <index>}` and the bytes ride after it. [`parse_received`] reads a message a server
//! received, checked against its schema first, [`parse`] one a client reads, and [`write`] produces
//! them; each attachment is referenced exactly once.

use std::borrow::Cow;
use std::cell::RefCell;

use bytes::Bytes as ByteBuffer;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{DeserializeOwned, Error as _};
use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::schema::{ReceivedCheckError, received_check};

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
    previous: PreviousContext<T>,
}

/// The context a guard puts back: still owed, or already put back by [`ContextGuard::take`].
enum PreviousContext<T> {
    Owed(Option<T>),
    Restored,
}

impl<T> ContextGuard<T> {
    fn enter(cell: &'static std::thread::LocalKey<RefCell<Option<T>>>, context: T) -> Self {
        let previous = cell.with(|slot| slot.replace(Some(context)));
        Self {
            cell,
            previous: PreviousContext::Owed(previous),
        }
    }

    fn take(mut self) -> Option<T> {
        let previous = match std::mem::replace(&mut self.previous, PreviousContext::Restored) {
            PreviousContext::Owed(previous) => previous,
            PreviousContext::Restored => None,
        };
        self.cell.with(|slot| slot.replace(previous))
    }
}

impl<T> Drop for ContextGuard<T> {
    fn drop(&mut self) {
        if let PreviousContext::Owed(previous) =
            std::mem::replace(&mut self.previous, PreviousContext::Restored)
        {
            self.cell.with(|slot| slot.replace(previous));
        }
    }
}

/// Parses one message's JSON with its attachments, as a client reads what a typed writer sent.
/// Refuses a JSON the type refuses, a placeholder past the attachments or repeated, a size outside
/// a member's bounds, and an attachment nothing references.
pub fn parse<T: DeserializeOwned>(
    json: &[u8],
    attachments: Vec<ByteBuffer>,
) -> Result<T, AttachmentError> {
    read_with_attachments(attachments, || serde_json::from_slice::<T>(json))
}

/// Why a received message was refused.
#[derive(Debug, thiserror::Error)]
pub enum ReceivedError {
    /// The JSON does not parse.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The message breaks its contract's schema, an array where an object belongs among the ways.
    /// It keeps only where and which keyword failed, never the value, which may be a secret.
    #[error("the message breaks its contract's schema at `{instance_path}` ({keyword})")]
    Shape {
        /// The failing value's JSON Pointer, empty for the whole message.
        instance_path: String,
        /// The schema keyword the value failed.
        keyword: String,
    },
    /// The contract's check could not be built.
    #[error(transparent)]
    Check(#[from] ReceivedCheckError),
    /// The message passed its schema but its type refused a value in it: a malformed id, say, or
    /// an attachment placeholder naming no attachment sent with it.
    #[error("the message passed its schema but does not read as its type")]
    Read(#[source] serde_json::Error),
    /// The message was read but an attachment sent with it is referenced by no placeholder.
    #[error("attachment {index} is not referenced")]
    Unreferenced {
        /// The unreferenced attachment's index.
        index: usize,
    },
    /// The message was read but breaks a rule no schema shape holds, a repeated list key among
    /// them.
    #[error(transparent)]
    Rule(#[from] garde::Report),
}

/// Parses a message a server received, a request's or a notification's params or an attachment
/// message's body: the JSON is checked against `T`'s schema, then read by serde, then held to
/// `T`'s garde rules, since serde alone reads a JSON array where an object belongs. Refuses what
/// [`parse`] refuses, any JSON the schema refuses, and a value a garde rule refuses.
pub fn parse_received<T>(json: &[u8], attachments: Vec<ByteBuffer>) -> Result<T, ReceivedError>
where
    T: DeserializeOwned + JsonSchema + garde::Validate<Context = ()> + 'static,
{
    let check = received_check::<T>()?;
    let value: serde_json::Value = serde_json::from_slice(json)?;
    check
        .validate(&value)
        .map_err(|error| ReceivedError::Shape {
            instance_path: error.instance_path().as_str().to_owned(),
            keyword: error.kind().keyword().to_owned(),
        })?;
    let received = read_with_attachments(attachments, || T::deserialize(value)).map_err(
        |error| match error {
            AttachmentError::Json(error) => ReceivedError::Read(error),
            AttachmentError::Unreferenced { index } => ReceivedError::Unreferenced { index },
        },
    )?;
    received.validate()?;
    Ok(received)
}

/// Runs `read` with `attachments` as the thread's attachment context, then refuses an attachment
/// no placeholder took.
fn read_with_attachments<T>(
    attachments: Vec<ByteBuffer>,
    read: impl FnOnce() -> serde_json::Result<T>,
) -> Result<T, AttachmentError> {
    let is_taken = vec![false; attachments.len()];
    let guard = ContextGuard::enter(
        &INCOMING,
        Incoming {
            attachments,
            is_taken,
        },
    );
    let parsed = read();
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
    use rstest::rstest;
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};

    use super::{AttachmentError, Bytes, ReceivedError, parse, parse_received, write};
    use crate::artifacts::ingest::AttachmentIngestChunkRequest;
    use crate::preview::page::{PreviewPageOpenRequest, PreviewPageTarget};
    use crate::session::links::SessionLinkRequest;
    use crate::tag::TagList;
    use crate::workflow::secret::WorkflowSecretReplaceRequest;

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

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(deny_unknown_fields)]
    struct Leaf {
        #[garde(skip)]
        x: u8,
    }

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(tag = "kind", deny_unknown_fields)]
    enum Arm {
        Holder {
            #[garde(dive)]
            leaf: Leaf,
        },
    }

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(deny_unknown_fields)]
    struct Received {
        #[garde(dive)]
        leaf: Leaf,
        #[garde(dive)]
        arm: Arm,
    }

    #[rstest]
    #[case::at_the_top(r#"[{"x":1},{"kind":"Holder","leaf":{"x":2}}]"#)]
    #[case::inside_a_struct(r#"{"leaf":[1],"arm":{"kind":"Holder","leaf":{"x":2}}}"#)]
    #[case::as_a_tagged_arm(r#"{"leaf":{"x":1},"arm":["Holder",{"x":2}]}"#)]
    #[case::inside_a_tagged_arm(r#"{"leaf":{"x":1},"arm":{"kind":"Holder","leaf":[2]}}"#)]
    fn a_received_message_refuses_an_array_where_an_object_belongs(#[case] json: &str) {
        serde_json::from_str::<Received>(json).expect("serde alone reads the array by position");
        assert!(
            matches!(
                parse_received::<Received>(json.as_bytes(), Vec::new()),
                Err(ReceivedError::Shape { .. })
            ),
            "{json} is refused"
        );
        let Received {
            leaf: Leaf { x: outer },
            arm: Arm::Holder {
                leaf: Leaf { x: inner },
            },
        } = parse_received(
            br#"{"leaf":{"x":1},"arm":{"kind":"Holder","leaf":{"x":2}}}"#,
            Vec::new(),
        )
        .expect("the object form is read");
        assert_eq!((outer, inner), (1, 2));
    }

    #[test]
    fn a_received_message_passes_its_schema_then_its_garde_rules() {
        const SESSION: &str = "0192f0a0-0000-7000-8000-000000000001";
        const OTHER: &str = "0192f0a0-0000-7000-8000-000000000002";
        let link = format!(r#"{{"sessionId":"{SESSION}","targetSessionId":"{OTHER}"}}"#);
        parse_received::<SessionLinkRequest>(link.as_bytes(), Vec::new())
            .expect("a link between two sessions is read");
        let self_link = format!(r#"{{"sessionId":"{SESSION}","targetSessionId":"{SESSION}"}}"#);
        assert!(matches!(
            parse_received::<SessionLinkRequest>(self_link.as_bytes(), Vec::new()),
            Err(ReceivedError::Rule(_))
        ));

        let open =
            format!(r#"{{"sessionId":"{SESSION}","target":{{"kind":"devServer","port":5173}}}}"#);
        let open = parse_received::<PreviewPageOpenRequest>(open.as_bytes(), Vec::new())
            .expect("a tagged arm is read");
        assert!(matches!(open.target, PreviewPageTarget::DevServer { .. }));

        let chunk = parse_received::<AttachmentIngestChunkRequest>(
            br#"{"ingestId":"ingest","sequenceNumber":0,"chunk":{"$bytes":0}}"#,
            vec![ByteBuffer::from_static(b"abc")],
        )
        .expect("a byte member is read from its attachment");
        assert_eq!(chunk.chunk.as_bytes(), b"abc");

        parse_received::<TagList>(br#"["Ops","dev"]"#, Vec::new()).expect("distinct tags are read");
        assert!(
            matches!(
                parse_received::<TagList>(br#"["Ops","ops"]"#, Vec::new()),
                Err(ReceivedError::Rule(_))
            ),
            "the schema passes a repeat in another case, and garde refuses it"
        );
    }

    // A value the schema refuses is never quoted, so a secret typed in the wrong JSON type reaches
    // neither the reply nor a log through the refusal.
    #[test]
    fn a_shape_refusal_never_carries_the_refused_value() {
        let message =
            br#"{"secretId":"0192f0a0-0000-7000-8000-000000000001","secretValue":48213377}"#;
        let error = parse_received::<WorkflowSecretReplaceRequest>(message, Vec::new())
            .expect_err("a number where the secret's text belongs is refused");
        assert!(matches!(error, ReceivedError::Shape { .. }), "{error:?}");
        let mut source: Option<&dyn std::error::Error> = Some(&error);
        while let Some(error) = source {
            let text = error.to_string();
            assert!(
                !text.contains(|character: char| "48213377".contains(character)),
                "{text}"
            );
            source = error.source();
        }
    }
}
