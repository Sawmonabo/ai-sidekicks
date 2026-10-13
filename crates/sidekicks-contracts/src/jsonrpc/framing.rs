//! The frame codec every hop shares, on the local socket and inside each channel message: a
//! 10-byte header and a chunk of one lane's message, with per-lane credit. A message is
//! `u32 jsonLength | JSON | (u32 length | bytes)*`, cut into chunks on its lane.

use bytes::{Buf, BufMut, Bytes, BytesMut};

use crate::typescript::{TypeScriptModule, ts_constants};

pub mod frame;
pub mod incoming;
pub mod outgoing;

ts_constants! {
    /// The bytes of a frame's header: kind, flags, lane and length.
    pub const FRAME_HEADER_BYTES: usize = 10;
    /// The most body bytes one DATA frame carries: the largest channel message, less its 16-byte
    /// seal tag and the header, so one frame always fits one sealed message.
    pub const MAX_CHUNK_BYTES: u32 = 65_509;
    /// The credit each lane starts with in each direction, in body bytes.
    pub const INITIAL_LANE_CREDIT: u32 = 262_144;
    /// The most bytes of JSON one message carries.
    pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
    /// The most bytes of attachments one message carries, each attachment's 4-byte length
    /// included.
    pub const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;
    /// The most bytes one attachment carries: a message's whole attachment budget less the one
    /// 4-byte length its bytes are written after.
    pub const MAX_ONE_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_BYTES - LENGTH_PREFIX_BYTES;
}

/// The bytes of each length prefix in a message: the JSON's and each attachment's.
const LENGTH_PREFIX_BYTES: usize = 4;

/// Which part of a message passed its cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessagePart {
    /// The JSON, capped by [`MAX_MESSAGE_BYTES`].
    Json,
    /// The attachments, capped by [`MAX_ATTACHMENT_BYTES`].
    Attachments,
}

/// A fault that desynchronizes the stream, so the connection, or the channel, closes. Only
/// [`FramingError::MessageTooLarge`] is answered first, as `transport.message_too_large`.
#[derive(Debug, thiserror::Error)]
pub enum FramingError {
    /// The socket failed under the codec.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A frame kind this layer does not know, the channel's own kinds among them.
    #[error("frame kind {kind:#04x} is unknown")]
    UnknownKind {
        /// The kind byte.
        kind: u8,
    },
    /// A flag bit the frame's kind does not define is set.
    #[error("flags {flags:#04x} are not defined for frame kind {kind:#04x}")]
    ReservedFlags {
        /// The kind byte.
        kind: u8,
        /// The flags byte.
        flags: u8,
    },
    /// A DATA frame's body is over [`MAX_CHUNK_BYTES`].
    #[error("a chunk of {length} bytes is over the {MAX_CHUNK_BYTES}-byte limit")]
    ChunkTooLong {
        /// The frame's length field.
        length: u32,
    },
    /// An ABORT frame's length is not 0.
    #[error("an ABORT frame carries length {length}")]
    AbortWithLength {
        /// The frame's length field.
        length: u32,
    },
    /// A DATA frame is past its lane's credit, or on a lane already closed.
    #[error("lane {lane} received data past its credit")]
    DataBeyondCredit {
        /// The lane.
        lane: u32,
    },
    /// A frame opens a lane while [`incoming::MAX_OPEN_LANES`] are open. Every lane a peer opens
    /// follows a call the receiver admitted, so a peer past the limit is misbehaving.
    #[error("lane {lane} opens past the {}-lane limit", incoming::MAX_OPEN_LANES)]
    TooManyLanes {
        /// The lane that would open.
        lane: u32,
    },
    /// A frame closes lane 0, which never closes.
    #[error("lane 0 never closes")]
    ControlLaneClosed,
    /// The JSON's or an attachment's length, or the length itself, runs past the message's end.
    #[error("a length in the message runs past its end")]
    LengthPastEnd,
    /// A message's JSON or attachments passed their cap.
    #[error("the message's {part:?} passed {limit} bytes ({observed})")]
    MessageTooLarge {
        /// The part over its cap.
        part: MessagePart,
        /// The cap.
        limit: usize,
        /// The part's size, or as much of it as arrived before the cap was passed.
        observed: usize,
    },
}

/// One message's JSON and attachments, split out of its lane's chunks or ready to be cut into them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageBody {
    /// The JSON-RPC message, UTF-8.
    pub json: Bytes,
    /// The attachments, in the order their placeholders index them.
    pub attachments: Vec<Bytes>,
}

impl MessageBody {
    /// Splits a whole message into its JSON and attachments; refuses a length past the end or a
    /// part over its cap.
    pub fn decode(mut message: Bytes) -> Result<Self, FramingError> {
        let json_length = read_length(&mut message)?;
        check_cap(MessagePart::Json, json_length)?;
        check_cap(MessagePart::Attachments, message.len() - json_length)?;
        let json = message.split_to(json_length);
        let mut attachments = Vec::new();
        while !message.is_empty() {
            let length = read_length(&mut message)?;
            attachments.push(message.split_to(length));
        }
        Ok(Self { json, attachments })
    }

    /// Joins the JSON and attachments into one message; refuses a part over its cap.
    pub fn encode(&self) -> Result<Bytes, FramingError> {
        check_cap(MessagePart::Json, self.json.len())?;
        let attachments_length: usize = self
            .attachments
            .iter()
            .map(|attachment| LENGTH_PREFIX_BYTES + attachment.len())
            .sum();
        check_cap(MessagePart::Attachments, attachments_length)?;
        let mut message =
            BytesMut::with_capacity(LENGTH_PREFIX_BYTES + self.json.len() + attachments_length);
        for part in std::iter::once(&self.json).chain(&self.attachments) {
            message.put_u32(u32::try_from(part.len()).expect("a part within its cap fits a u32"));
            message.put_slice(part);
        }
        Ok(message.freeze())
    }
}

/// Reads one length prefix; refuses one that is missing or runs past the message's end.
fn read_length(message: &mut Bytes) -> Result<usize, FramingError> {
    if message.len() < LENGTH_PREFIX_BYTES {
        return Err(FramingError::LengthPastEnd);
    }
    let length = usize::try_from(message.get_u32()).expect("a u32 fits a usize");
    if length > message.len() {
        return Err(FramingError::LengthPastEnd);
    }
    Ok(length)
}

/// Refuses `observed` bytes of `part` past its cap.
fn check_cap(part: MessagePart, observed: usize) -> Result<(), FramingError> {
    let limit = match part {
        MessagePart::Json => MAX_MESSAGE_BYTES,
        MessagePart::Attachments => MAX_ATTACHMENT_BYTES,
    };
    if observed > limit {
        return Err(FramingError::MessageTooLarge {
            part,
            limit,
            observed,
        });
    }
    Ok(())
}

/// The TypeScript module of the frame codec's limits.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/framing",
    doc: "The frame codec's limits: the header, the largest chunk, a lane's first credit and a \
          message's caps.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use bytes::{BufMut, Bytes, BytesMut};
    use proptest::prelude::*;
    use rstest::rstest;
    use tokio_util::codec::{Decoder, Encoder};

    use super::frame::{Frame, FrameCodec, LaneId};
    use super::incoming::{IncomingLanes, MAX_OPEN_LANES};
    use super::{
        FramingError, INITIAL_LANE_CREDIT, MAX_ATTACHMENT_BYTES, MAX_CHUNK_BYTES,
        MAX_MESSAGE_BYTES, MessageBody, MessagePart,
    };

    fn header(kind: u8, flags: u8, lane: u32, length: u32) -> BytesMut {
        let mut bytes = BytesMut::new();
        bytes.put_u8(kind);
        bytes.put_u8(flags);
        bytes.put_u32(lane);
        bytes.put_u32(length);
        bytes
    }

    fn data(lane: u32, is_end: bool, body: &[u8]) -> Frame {
        Frame::Data {
            lane: LaneId::new(lane),
            is_end,
            closes_lane: false,
            body: Bytes::copy_from_slice(body),
        }
    }

    fn arbitrary_frame() -> impl Strategy<Value = Frame> {
        let lane = any::<u32>().prop_map(LaneId::new);
        prop_oneof![
            (
                lane.clone(),
                any::<bool>(),
                any::<bool>(),
                proptest::collection::vec(any::<u8>(), 0..64)
            )
                .prop_map(|(lane, is_end, closes_lane, body)| Frame::Data {
                    lane,
                    is_end,
                    closes_lane: closes_lane && !lane.is_control(),
                    body: body.into(),
                }),
            (lane.clone(), any::<u32>())
                .prop_map(|(lane, granted)| Frame::Credit { lane, granted }),
            (lane, any::<bool>()).prop_map(|(lane, closes_lane)| Frame::Abort {
                lane,
                closes_lane: closes_lane && !lane.is_control(),
            }),
        ]
    }

    fn arbitrary_body() -> impl Strategy<Value = MessageBody> {
        (
            proptest::collection::vec(any::<u8>(), 0..512),
            proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..256), 0..4),
        )
            .prop_map(|(json, attachments)| MessageBody {
                json: json.into(),
                attachments: attachments.into_iter().map(Bytes::from).collect(),
            })
    }

    proptest! {
        #[test]
        fn a_frame_decodes_as_written_however_the_stream_splits(
            frame in arbitrary_frame(),
            split in any::<prop::sample::Index>(),
        ) {
            let mut encoded = BytesMut::new();
            FrameCodec.encode(frame.clone(), &mut encoded).expect("a valid frame encodes");
            let mut tail = encoded.split_off(split.index(encoded.len() + 1));
            let first = FrameCodec.decode(&mut encoded).expect("a prefix is no fault");
            let decoded = match first {
                Some(decoded) => decoded,
                None => {
                    encoded.unsplit(std::mem::take(&mut tail));
                    FrameCodec
                        .decode(&mut encoded)
                        .expect("the whole frame decodes")
                        .expect("whole")
                }
            };
            prop_assert_eq!(decoded, frame);
            prop_assert!(encoded.is_empty() && tail.is_empty());
        }

        #[test]
        fn a_message_crosses_its_lane_in_chunks_and_returns_its_credit(
            body in arbitrary_body(),
            chunk_bytes in 1..=64_u32,
        ) {
            let encoded = body.encode().expect("a small message is within its caps");
            let mut lanes = IncomingLanes::default();
            let mut received = None;
            for frame in Frame::data_chunks(LaneId::new(3), encoded.clone(), chunk_bytes, false) {
                let outcome = lanes.receive(frame).expect("an ordered message is no fault");
                prop_assert!(
                    outcome.credit.is_none(),
                    "a message under the window owes no early credit"
                );
                received = received.or(outcome.message);
            }
            let message = received.expect("the last chunk completes the message");
            prop_assert_eq!(&message.body, &body);
            prop_assert_eq!(message.credit_due as usize, encoded.len());
            prop_assert_eq!(
                lanes.take(message.lane, message.credit_due),
                Some(Frame::Credit { lane: LaneId::new(3), granted: message.credit_due })
            );
        }

        #[test]
        fn any_bytes_decode_without_a_panic(
            bytes in proptest::collection::vec(any::<u8>(), 0..256),
        ) {
            let mut stream = BytesMut::from(&bytes[..]);
            let mut lanes = IncomingLanes::default();
            while let Ok(Some(frame)) = FrameCodec.decode(&mut stream) {
                if lanes.receive(frame).is_err() {
                    break;
                }
            }
            drop(MessageBody::decode(Bytes::from(bytes)));
        }
    }

    #[rstest]
    #[case::channel_kind(header(0x00, 0, 1, 0), "UnknownKind")]
    #[case::undefined_kind(header(0x04, 0, 1, 0), "UnknownKind")]
    #[case::rekey_kind(header(0x80, 0, 1, 0), "UnknownKind")]
    #[case::data_flag(header(0x01, 0b100, 1, 0), "ReservedFlags")]
    #[case::credit_flag(header(0x02, 0b01, 1, 0), "ReservedFlags")]
    #[case::abort_end_flag(header(0x03, 0b01, 1, 0), "ReservedFlags")]
    #[case::long_chunk(header(0x01, 0, 1, MAX_CHUNK_BYTES + 1), "ChunkTooLong")]
    #[case::abort_length(header(0x03, 0, 1, 1), "AbortWithLength")]
    #[case::data_closes_lane_0(header(0x01, 0b11, 0, 0), "ControlLaneClosed")]
    #[case::abort_closes_lane_0(header(0x03, 0b10, 0, 0), "ControlLaneClosed")]
    fn a_malformed_header_is_a_framing_error(#[case] mut stream: BytesMut, #[case] fault: &str) {
        let error = FrameCodec
            .decode(&mut stream)
            .expect_err("the header is refused");
        assert!(
            format!("{error:?}").starts_with(fault),
            "{error:?} is {fault}"
        );
    }

    #[test]
    fn a_lane_holds_its_sender_to_credit_and_its_lengths_and_caps() {
        let window = vec![0; usize::try_from(INITIAL_LANE_CREDIT).expect("fits")];
        let mut lanes = IncomingLanes::default();
        let early = lanes
            .receive(data(1, false, &window))
            .expect("the window is the credit");
        assert_eq!(
            early.credit,
            Some(Frame::Credit {
                lane: LaneId::new(1),
                granted: INITIAL_LANE_CREDIT
            }),
            "a message past the window gets its partial bytes back before it stalls"
        );
        lanes
            .receive(data(1, false, &window))
            .expect("the returned credit is spent again");
        assert!(matches!(
            lanes.receive(data(1, false, &[0])),
            Err(FramingError::DataBeyondCredit { lane: 1 })
        ));

        let mut lanes = IncomingLanes::default();
        let closing = Frame::Data {
            lane: LaneId::new(2),
            is_end: true,
            closes_lane: true,
            body: MessageBody {
                json: Bytes::from_static(b"{}"),
                attachments: Vec::new(),
            }
            .encode()
            .expect("a small message is within its caps"),
        };
        lanes
            .receive(closing)
            .expect("a closing message is received");
        assert!(
            matches!(
                lanes.receive(data(2, false, b"")),
                Err(FramingError::DataBeyondCredit { lane: 2 })
            ),
            "a closed lane takes no data"
        );

        for (message, expected) in [
            (&[0, 0, 0][..], "LengthPastEnd"),
            (&[0, 0, 0, 2, b'{'][..], "LengthPastEnd"),
            (&[0, 0, 0, 2, b'{', b'}', 0, 0, 0, 1][..], "LengthPastEnd"),
        ] {
            let error = IncomingLanes::default()
                .receive(data(0, true, message))
                .expect_err("the lengths are refused");
            assert!(format!("{error:?}").starts_with(expected), "{error:?}");
        }

        let mut over_json = BytesMut::new();
        over_json.put_u32(u32::try_from(MAX_MESSAGE_BYTES + 1).expect("fits"));
        assert!(
            matches!(
                IncomingLanes::default().receive(data(0, false, &over_json)),
                Err(FramingError::MessageTooLarge {
                    part: MessagePart::Json,
                    ..
                })
            ),
            "a JSON length past the cap is refused before its bytes arrive"
        );

        // A JSON length of 0, then zeros as one attachment section that keeps growing.
        let chunk = vec![0; usize::try_from(MAX_CHUNK_BYTES).expect("fits")];
        let mut lanes = IncomingLanes::default();
        let chunks_past_the_cap = MAX_ATTACHMENT_BYTES / chunk.len() + 2;
        let outcome = (0..chunks_past_the_cap)
            .map(|_| lanes.receive(data(0, false, &chunk)))
            .find(Result::is_err);
        assert!(
            matches!(
                outcome,
                Some(Err(FramingError::MessageTooLarge {
                    part: MessagePart::Attachments,
                    ..
                }))
            ),
            "attachments past the cap are refused before the rest is buffered"
        );
    }

    #[rstest]
    #[case::at_the_limit(MAX_OPEN_LANES, true)]
    #[case::past_the_limit(MAX_OPEN_LANES + 1, false)]
    fn a_peer_opens_lanes_up_to_the_limit(#[case] opened: usize, #[case] is_accepted: bool) {
        let mut lanes = IncomingLanes::default();
        let last = u32::try_from(opened).expect("fits");
        for lane in 1..last {
            lanes
                .receive(data(lane, false, b""))
                .expect("a lane within the limit opens");
        }
        let outcome = lanes.receive(data(last, false, b""));
        if is_accepted {
            outcome.expect("the last lane within the limit opens");
        } else {
            assert!(
                matches!(outcome, Err(FramingError::TooManyLanes { lane }) if lane == last),
                "{outcome:?}"
            );
        }
    }
}
