//! One frame: `kind u8 | flags u8 | lane u32 | length u32 | body`, big-endian. DATA carries a
//! chunk of a lane's message, CREDIT grants a lane more body bytes, ABORT drops a lane's partial
//! message.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use tokio_util::codec::{Decoder, Encoder};

use super::{FRAME_HEADER_BYTES, FramingError, MAX_CHUNK_BYTES};

/// DATA's kind byte.
const DATA_KIND: u8 = 0x01;
/// CREDIT's kind byte.
const CREDIT_KIND: u8 = 0x02;
/// ABORT's kind byte.
const ABORT_KIND: u8 = 0x03;
/// DATA's flag for a message's last chunk.
const END_FLAG: u8 = 0b01;
/// The flag that closes the lane after this message (DATA) or now (ABORT).
const CLOSE_FLAG: u8 = 0b10;

/// A lane number in its sender's direction; lanes are never reused within a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LaneId(u32);

impl LaneId {
    /// Lane 0, which carries requests, responses and cancels, and never closes.
    pub const CONTROL: Self = Self(0);

    /// The lane numbered `number`.
    pub const fn new(number: u32) -> Self {
        Self(number)
    }

    /// The lane's number.
    pub const fn number(self) -> u32 {
        self.0
    }

    /// Whether this is lane 0.
    pub const fn is_control(self) -> bool {
        self.0 == 0
    }
}

/// One frame of the codec.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    /// A chunk of the lane's current message.
    Data {
        /// The lane.
        lane: LaneId,
        /// Whether this chunk ends the message.
        is_end: bool,
        /// Whether the lane closes once the message ends.
        closes_lane: bool,
        /// The chunk, at most [`MAX_CHUNK_BYTES`].
        body: Bytes,
    },
    /// More body bytes the receiver lets the sender send on the lane.
    Credit {
        /// The lane.
        lane: LaneId,
        /// The bytes granted.
        granted: u32,
    },
    /// Drops the lane's partial message.
    Abort {
        /// The lane.
        lane: LaneId,
        /// Whether the lane closes now.
        closes_lane: bool,
    },
}

impl Frame {
    /// The frame's lane.
    pub const fn lane(&self) -> LaneId {
        match self {
            Self::Data { lane, .. } | Self::Credit { lane, .. } | Self::Abort { lane, .. } => *lane,
        }
    }

    /// Cuts `message` into DATA frames of at most `chunk_bytes` (itself at most
    /// [`MAX_CHUNK_BYTES`]), the last one flagged as the end; an empty message is one empty frame.
    pub fn data_chunks(
        lane: LaneId,
        mut message: Bytes,
        chunk_bytes: u32,
        closes_lane: bool,
    ) -> impl Iterator<Item = Self> {
        let chunk_bytes = usize::try_from(chunk_bytes.clamp(1, MAX_CHUNK_BYTES))
            .expect("a chunk size fits a usize");
        let mut is_done = false;
        std::iter::from_fn(move || {
            if is_done {
                return None;
            }
            let body = message.split_to(chunk_bytes.min(message.len()));
            is_done = message.is_empty();
            Some(Self::Data {
                lane,
                is_end: is_done,
                closes_lane: closes_lane && is_done,
                body,
            })
        })
    }
}

/// Reads and writes frames on a byte stream; a fault in either direction is a [`FramingError`].
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameCodec;

impl Decoder for FrameCodec {
    type Item = Frame;
    type Error = FramingError;

    fn decode(&mut self, source: &mut BytesMut) -> Result<Option<Frame>, FramingError> {
        let Some(mut header) = source.get(..FRAME_HEADER_BYTES) else {
            return Ok(None);
        };
        let kind = header.get_u8();
        let flags = header.get_u8();
        let lane = LaneId(header.get_u32());
        let length = header.get_u32();
        let defined_flags = match kind {
            DATA_KIND => END_FLAG | CLOSE_FLAG,
            CREDIT_KIND => 0,
            ABORT_KIND => CLOSE_FLAG,
            _ => return Err(FramingError::UnknownKind { kind }),
        };
        if flags & !defined_flags != 0 {
            return Err(FramingError::ReservedFlags { kind, flags });
        }
        let closes_lane = flags & CLOSE_FLAG != 0;
        if closes_lane && lane.is_control() {
            return Err(FramingError::ControlLaneClosed);
        }
        match kind {
            DATA_KIND => {
                if length > MAX_CHUNK_BYTES {
                    return Err(FramingError::ChunkTooLong { length });
                }
                let body_length = usize::try_from(length).expect("a chunk length fits a usize");
                if source.len() < FRAME_HEADER_BYTES + body_length {
                    source.reserve(FRAME_HEADER_BYTES + body_length - source.len());
                    return Ok(None);
                }
                source.advance(FRAME_HEADER_BYTES);
                let body = source.split_to(body_length).freeze();
                Ok(Some(Frame::Data {
                    lane,
                    is_end: flags & END_FLAG != 0,
                    closes_lane,
                    body,
                }))
            }
            CREDIT_KIND => {
                source.advance(FRAME_HEADER_BYTES);
                Ok(Some(Frame::Credit {
                    lane,
                    granted: length,
                }))
            }
            _ => {
                if length != 0 {
                    return Err(FramingError::AbortWithLength { length });
                }
                source.advance(FRAME_HEADER_BYTES);
                Ok(Some(Frame::Abort { lane, closes_lane }))
            }
        }
    }
}

impl Encoder<Frame> for FrameCodec {
    type Error = FramingError;

    fn encode(&mut self, frame: Frame, destination: &mut BytesMut) -> Result<(), FramingError> {
        let lane = frame.lane();
        let (kind, flags, length, body) = match frame {
            Frame::Data {
                is_end,
                closes_lane,
                body,
                ..
            } => {
                let length = u32::try_from(body.len()).unwrap_or(u32::MAX);
                if length > MAX_CHUNK_BYTES {
                    return Err(FramingError::ChunkTooLong { length });
                }
                let end_flag = if is_end { END_FLAG } else { 0 };
                (
                    DATA_KIND,
                    end_flag | close_flag(lane, closes_lane)?,
                    length,
                    body,
                )
            }
            Frame::Credit { granted, .. } => (CREDIT_KIND, 0, granted, Bytes::new()),
            Frame::Abort { closes_lane, .. } => {
                (ABORT_KIND, close_flag(lane, closes_lane)?, 0, Bytes::new())
            }
        };
        destination.reserve(FRAME_HEADER_BYTES + body.len());
        destination.put_u8(kind);
        destination.put_u8(flags);
        destination.put_u32(lane.number());
        destination.put_u32(length);
        destination.put_slice(&body);
        Ok(())
    }
}

/// The CLOSE flag's bits for a frame on `lane`; refuses closing lane 0.
fn close_flag(lane: LaneId, closes_lane: bool) -> Result<u8, FramingError> {
    match (closes_lane, lane.is_control()) {
        (false, _) => Ok(0),
        (true, false) => Ok(CLOSE_FLAG),
        (true, true) => Err(FramingError::ControlLaneClosed),
    }
}
