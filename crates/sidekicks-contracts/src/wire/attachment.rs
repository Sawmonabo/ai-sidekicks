//! Bytes on the wire travel beside a message's JSON as attachments: the JSON holds the placeholder
//! `{"$bytes": <index>}` and the bytes ride after it. [`parse_received`] reads a message a server
//! received, checked against its schema first, [`parse`] one a client reads, and [`write()`]
//! produces them; each attachment is referenced exactly once.

use std::borrow::Cow;
use std::cell::RefCell;

use bytes::Bytes as ByteBuffer;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{DeserializeOwned, Error as _};
use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::jsonrpc::issue::{IssuePathSegment, ShapeFault, reader_issue_path, shape_faults};
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
    read_with_attachments(attachments, || serde_json::from_slice::<T>(json)).map_err(|error| {
        match error {
            AttachmentReadError::Read(error) => AttachmentError::Json(error),
            AttachmentReadError::Unreferenced { index } => AttachmentError::Unreferenced { index },
        }
    })
}

/// Why a received message was refused. No arm's `Display` quotes the message; a source may.
#[derive(Debug, thiserror::Error)]
pub enum ReceivedError {
    /// The JSON does not parse.
    #[error("the message is not JSON")]
    Json(#[source] serde_json::Error),
    /// The message breaks its contract's schema, an array where an object belongs among the ways:
    /// the first place it does, by path and keyword, or each member an object closed by
    /// `unevaluatedProperties` does not allow, never the value, which may be a secret.
    #[error("the message breaks its contract's schema")]
    Shape {
        /// The fault, or each unknown member up to the issue cap.
        faults: Vec<ShapeFault>,
    },
    /// The contract's check could not be built.
    #[error(transparent)]
    Check(#[from] ReceivedCheckError),
    /// The message passed its schema but its type refused a value in it: a malformed id, say, or
    /// an attachment placeholder naming no attachment sent with it.
    #[error("the message passed its schema but does not read as its type")]
    Read {
        /// Where the reader stopped, in the message's own names, as far as it could name it.
        path: Vec<IssuePathSegment>,
        /// serde's refusal, which can quote the value.
        #[source]
        source: serde_json::Error,
    },
    /// The message was read but an attachment sent with it is referenced by no placeholder.
    #[error("attachment {index} is not referenced")]
    Unreferenced {
        /// The unreferenced attachment's index.
        index: usize,
    },
    /// The message was read but breaks a rule no schema shape holds, a repeated list key among
    /// them.
    #[error("the message breaks a rule of its contract")]
    Rule {
        /// Each broken rule at its path in the type's own names.
        #[source]
        report: garde::Report,
        /// The JSON the value was read from, which those paths resolve against to the wire's
        /// names.
        received: serde_json::Value,
    },
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
    let received: serde_json::Value = serde_json::from_slice(json).map_err(ReceivedError::Json)?;
    // The check stops at its first fault, so a large malformed message costs no more than its read.
    if let Err(error) = check.validate(&received) {
        let faults = shape_faults(&error, &received);
        return Err(ReceivedError::Shape { faults });
    }
    let value = read_with_attachments(attachments, || {
        serde_path_to_error::deserialize::<_, T>(received)
    })
    .map_err(|error| match error {
        AttachmentReadError::Read(error) => ReceivedError::Read {
            path: reader_issue_path(error.path()),
            source: error.into_inner(),
        },
        AttachmentReadError::Unreferenced { index } => ReceivedError::Unreferenced { index },
    })?;
    match value.validate() {
        Ok(()) => Ok(value),
        Err(report) => {
            // The read took the JSON; it is read again only for a refusal, after the value goes.
            drop(value);
            let received = serde_json::from_slice(json).expect("these bytes parsed above");
            Err(ReceivedError::Rule { report, received })
        }
    }
}

/// Holds a received message to `T`'s contract as [`parse_received`] does, keeping nothing: the
/// check a method descriptor holds for a caller that has the params only as JSON.
pub fn check_received<T>(json: &[u8], attachments: Vec<ByteBuffer>) -> Result<(), ReceivedError>
where
    T: DeserializeOwned + JsonSchema + garde::Validate<Context = ()> + 'static,
{
    parse_received::<T>(json, attachments).map(drop)
}

/// Why a read inside an attachment context failed: the reader's own refusal, or an attachment no
/// placeholder took.
enum AttachmentReadError<Read> {
    Read(Read),
    Unreferenced { index: usize },
}

/// Runs `read` with `attachments` as the thread's attachment context, then refuses an attachment
/// no placeholder took.
fn read_with_attachments<T, Read>(
    attachments: Vec<ByteBuffer>,
    read: impl FnOnce() -> Result<T, Read>,
) -> Result<T, AttachmentReadError<Read>> {
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
    let value = parsed.map_err(AttachmentReadError::Read)?;
    match incoming.is_taken.iter().position(|is_taken| !is_taken) {
        Some(index) => Err(AttachmentReadError::Unreferenced { index }),
        None => Ok(value),
    }
}

/// Writes one message: its JSON with a placeholder for each byte member, and the attachments in
/// placeholder order. Fails only where `value`'s own `Serialize` fails.
pub fn write<T: Serialize>(value: &T) -> Result<(Vec<u8>, Vec<ByteBuffer>), serde_json::Error> {
    let (json, attachments) = collect_attachments(|| serde_json::to_vec(value));
    Ok((json?, attachments))
}

/// Runs `serialize` as one message's write, so every byte member it serializes writes its
/// placeholder, and returns its result with the attachments those members wrote, in order.
pub(crate) fn collect_attachments<R>(serialize: impl FnOnce() -> R) -> (R, Vec<ByteBuffer>) {
    let guard = ContextGuard::enter(&OUTGOING, Vec::new());
    let written = serialize();
    let attachments = guard
        .take()
        .expect("the guard holds this write's attachments");
    (written, attachments)
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
    use serde::de::DeserializeOwned;
    use serde::{Deserialize, Serialize};

    use super::{AttachmentError, Bytes, ReceivedError, parse, parse_received, write};
    use crate::artifacts::ingest::ArtifactIngestWriteRequest;
    use crate::jsonrpc::issue::IssuePathSegment;
    use crate::session::goal::SessionGoalUpdatedPayload;
    use crate::session::links::SessionLinkRequest;
    use crate::tag::TagList;
    use crate::workflow::secret::WorkflowSecretUpdateRequest;

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

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(untagged, deny_unknown_fields)]
    #[expect(
        dead_code,
        reason = "the read is the subject; no test reads a member back"
    )]
    enum Either {
        Count {
            #[garde(skip)]
            count: u8,
        },
        Label {
            #[garde(skip)]
            label: String,
        },
    }

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(deny_unknown_fields)]
    struct Choice {
        #[garde(dive)]
        either: Either,
    }

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(deny_unknown_fields)]
    struct Nullable {
        #[serde(default)]
        #[garde(dive)]
        leaf: Option<Leaf>,
        #[serde(default)]
        #[garde(dive)]
        arm: Option<Arm>,
    }

    /// An untagged union inlined into its tagged arm, which the closing pass closes with
    /// `unevaluatedProperties`, so the arm's members come from the inner union.
    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(untagged)]
    #[schemars(inline)]
    #[expect(
        dead_code,
        reason = "the read is the subject; no test reads a member back"
    )]
    enum Figure {
        Circle {
            #[garde(skip)]
            radius: u8,
        },
        Square {
            #[garde(skip)]
            side: u8,
        },
    }

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(tag = "kind")]
    enum Drawing {
        Figure(#[garde(dive)] Figure),
        Blank {},
    }

    /// Where `json` breaks `T`'s shape: each fault's path and keyword; `None` when `T` reads it.
    fn shape_refusal<T>(json: &str) -> Option<Vec<(Vec<String>, String)>>
    where
        T: DeserializeOwned + JsonSchema + garde::Validate<Context = ()> + 'static,
    {
        match parse_received::<T>(json.as_bytes(), Vec::new()) {
            Ok(_) => None,
            Err(ReceivedError::Shape { faults }) => Some(
                faults
                    .into_iter()
                    .map(|fault| {
                        let path = fault.path.iter().map(|segment| match segment {
                            IssuePathSegment::Member(name) => name.clone(),
                            IssuePathSegment::Index(index) => index.get().to_string(),
                        });
                        (path.collect(), fault.keyword)
                    })
                    .collect(),
            ),
            Err(error) => panic!("{json} is refused past its shape: {error:?}"),
        }
    }

    type ShapeRead = fn(&str) -> Option<Vec<(Vec<String>, String)>>;

    // Each union kind reads its valid messages, and a refusal names one fault: inside the arm a
    // tag selects, at an untagged union as `anyOf`, or each unknown member.
    #[rstest]
    #[case::tagged(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1},"arm":{"kind":"Holder","leaf":{"x":2}}}"#,
        None
    )]
    #[case::tagged_arm_malformed(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1},"arm":{"kind":"Holder","leaf":[2]}}"#,
        Some(&[(&["arm", "leaf"][..], "type")][..])
    )]
    #[case::tagged_arm_as_an_array(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1},"arm":["Holder",{"x":2}]}"#,
        Some(&[(&["arm"][..], "type")][..])
    )]
    #[case::tag_unknown(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1},"arm":{"kind":"Other","leaf":{"x":2}}}"#,
        Some(&[(&["arm", "kind"][..], "enum")][..])
    )]
    #[case::tag_missing(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1},"arm":{"leaf":{"x":2}}}"#,
        Some(&[(&["arm"][..], "required")][..])
    )]
    #[case::two_faults_name_one(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":"a"},"arm":{"kind":"Holder","leaf":{"x":"b"}}}"#,
        Some(&[(&["leaf", "x"][..], "type")][..])
    )]
    #[case::unknown_member(
        shape_refusal::<Received>,
        r#"{"leaf":{"x":1,"note":"a"},"arm":{"kind":"Holder","leaf":{"x":2}}}"#,
        Some(&[(&["leaf", "note"][..], "additionalProperties")][..])
    )]
    #[case::untagged(shape_refusal::<Choice>, r#"{"either":{"label":"a"}}"#, None)]
    #[case::untagged_malformed(
        shape_refusal::<Choice>,
        r#"{"either":{"count":"a"}}"#,
        Some(&[(&["either"][..], "anyOf")][..])
    )]
    #[case::nullable(shape_refusal::<Nullable>, r#"{"leaf":null,"arm":null}"#, None)]
    #[case::nullable_malformed(
        shape_refusal::<Nullable>,
        r#"{"leaf":{"x":"a"}}"#,
        Some(&[(&["leaf", "x"][..], "type")][..])
    )]
    #[case::nullable_tagged(
        shape_refusal::<Nullable>,
        r#"{"arm":{"kind":"Holder","leaf":{"x":2}}}"#,
        None
    )]
    #[case::nullable_tagged_malformed(
        shape_refusal::<Nullable>,
        r#"{"arm":{"kind":"Holder","leaf":[2]}}"#,
        Some(&[(&["arm", "leaf"][..], "type")][..])
    )]
    #[case::closed_by_unevaluated(shape_refusal::<Drawing>, r#"{"kind":"Figure","side":3}"#, None)]
    #[case::closed_by_unevaluated_unknown(
        shape_refusal::<Drawing>,
        r#"{"kind":"Figure","side":3,"note":"a","tone":"b"}"#,
        Some(&[
            (&["note"][..], "unevaluatedProperties"),
            (&["tone"][..], "unevaluatedProperties"),
        ][..])
    )]
    #[case::hand_written_if_then_else(
        shape_refusal::<SessionGoalUpdatedPayload>,
        r#"{"sessionId":"0192f0a0-0000-7000-8000-000000000001",
            "agentId":"0192f0a0-0000-7000-8000-000000000002",
            "goal":{"text":"ship it"},"status":"impossible","reason":"no time"}"#,
        None
    )]
    fn a_received_message_names_its_first_shape_fault(
        #[case] read: ShapeRead,
        #[case] json: &str,
        #[case] expected: Option<&[(&[&str], &str)]>,
    ) {
        let expected = expected.map(|faults| {
            faults
                .iter()
                .map(|(path, keyword)| {
                    let path = path.iter().map(|name| (*name).to_owned()).collect();
                    (path, (*keyword).to_owned())
                })
                .collect::<Vec<_>>()
        });
        assert_eq!(read(json), expected, "{json}");
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
            Err(ReceivedError::Rule { .. })
        ));

        let chunk = parse_received::<ArtifactIngestWriteRequest>(
            br#"{"ingestId":"ingest","sequenceNumber":0,"chunk":{"$bytes":0}}"#,
            vec![ByteBuffer::from_static(b"abc")],
        )
        .expect("a byte member is read from its attachment");
        assert_eq!(chunk.chunk.as_bytes(), b"abc");

        parse_received::<TagList>(br#"["Ops","dev"]"#, Vec::new()).expect("distinct tags are read");
        assert!(
            matches!(
                parse_received::<TagList>(br#"["Ops","ops"]"#, Vec::new()),
                Err(ReceivedError::Rule { .. })
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
        let error = parse_received::<WorkflowSecretUpdateRequest>(message, Vec::new())
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
