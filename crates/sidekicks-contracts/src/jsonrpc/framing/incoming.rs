//! The receiving side of a connection's lanes: it reassembles each lane's messages from their
//! chunks, holds every lane to the credit it granted, and returns credit as messages are taken or
//! as owed credit is released; a lane is credited only when its CREDIT frame goes out.

use std::collections::HashMap;

use bytes::BytesMut;

use super::frame::{Frame, LaneId};
use super::{
    FramingError, INITIAL_LANE_CREDIT, LENGTH_PREFIX_BYTES, MessageBody, MessagePart, check_cap,
};

/// The most lanes a peer holds open at once, lane 0 aside.
pub const MAX_OPEN_LANES: usize = 10_000;

/// A whole message off one lane, waiting for its consumer.
#[derive(Debug)]
pub struct IncomingMessage {
    /// The lane it arrived on.
    pub lane: LaneId,
    /// Its JSON and attachments.
    pub body: MessageBody,
    /// The credit owed back to the sender once the consumer takes it; pass it to
    /// [`IncomingLanes::take`].
    pub credit_due: u32,
}

/// Credit owed back to the sender: a partial message's bytes when its lane's credit ran out before
/// its end, or a dropped partial message's bytes. The lane takes no more until
/// [`IncomingLanes::release`] credits it and answers the CREDIT frame to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwedCredit {
    /// The lane the credit belongs to.
    pub lane: LaneId,
    /// The bytes owed.
    pub granted: u32,
}

/// What one frame produced.
#[derive(Debug, Default)]
pub struct Received {
    /// The message the frame completed.
    pub message: Option<IncomingMessage>,
    /// Credit owed back, released when the consumer chooses to send it.
    pub credit: Option<OwedCredit>,
}

/// One open lane's receive state.
#[derive(Debug)]
struct IncomingLane {
    /// Body bytes the sender may still send before it hears from us.
    outstanding_credit: u32,
    /// The chunks of the message being received.
    partial: BytesMut,
    /// The partial message's bytes no CREDIT has returned yet.
    unreturned: u32,
    /// Whether the lane closes once the current message ends.
    is_closing: bool,
}

impl IncomingLane {
    fn new() -> Self {
        Self {
            outstanding_credit: INITIAL_LANE_CREDIT,
            partial: BytesMut::new(),
            unreturned: 0,
            is_closing: false,
        }
    }
}

/// Every lane the peer sends on, for one connection.
#[derive(Debug)]
pub struct IncomingLanes {
    /// The open lanes; a lane at or below `highest_opened` that is absent here has closed.
    lanes: HashMap<LaneId, IncomingLane>,
    /// The highest lane number the peer has opened.
    highest_opened: u32,
}

impl Default for IncomingLanes {
    fn default() -> Self {
        Self {
            lanes: HashMap::from([(LaneId::CONTROL, IncomingLane::new())]),
            highest_opened: 0,
        }
    }
}

impl IncomingLanes {
    /// Applies one frame from the peer. A CREDIT frame is the outgoing side's, so it changes
    /// nothing here. Refuses data past a lane's credit or on a closed lane, and a message whose
    /// lengths or caps are wrong.
    pub fn receive(&mut self, frame: Frame) -> Result<Received, FramingError> {
        match frame {
            Frame::Data {
                lane,
                is_end,
                closes_lane,
                body,
            } => self.receive_data(lane, is_end, closes_lane, &body),
            Frame::Abort { lane, closes_lane } => Ok(self.receive_abort(lane, closes_lane)),
            Frame::Credit { .. } => Ok(Received::default()),
        }
    }

    /// Credits `owed`'s lane and answers the CREDIT frame returning it, or `None` once its lane
    /// has closed.
    pub fn release(&mut self, owed: OwedCredit) -> Option<Frame> {
        self.take(owed.lane, owed.granted)
    }

    /// The CREDIT frame returning a taken message's bytes, or `None` once its lane has closed.
    pub fn take(&mut self, lane: LaneId, credit_due: u32) -> Option<Frame> {
        let state = self.lanes.get_mut(&lane)?;
        state.outstanding_credit = state.outstanding_credit.saturating_add(credit_due);
        Some(Frame::Credit {
            lane,
            granted: credit_due,
        })
    }

    fn receive_data(
        &mut self,
        lane: LaneId,
        is_end: bool,
        closes_lane: bool,
        body: &[u8],
    ) -> Result<Received, FramingError> {
        if lane.number() > self.highest_opened {
            // Lane 0 is always in the map and never counts against the limit.
            if self.lanes.len() > MAX_OPEN_LANES {
                return Err(FramingError::TooManyLanes {
                    lane: lane.number(),
                });
            }
            self.highest_opened = lane.number();
            self.lanes.insert(lane, IncomingLane::new());
        }
        let length = u32::try_from(body.len()).expect("a decoded chunk fits a u32");
        let state = self
            .lanes
            .get_mut(&lane)
            .filter(|state| state.outstanding_credit >= length)
            .ok_or(FramingError::DataBeyondCredit {
                lane: lane.number(),
            })?;
        state.outstanding_credit -= length;
        state.partial.extend_from_slice(body);
        state.unreturned += length;
        state.is_closing |= closes_lane;
        check_partial_caps(&state.partial)?;

        if !is_end {
            // A message larger than the window would stall with no credit left: owe back what
            // has arrived of it, so the sender can send the rest once it is released.
            if state.outstanding_credit == 0 && state.unreturned > 0 {
                let granted = std::mem::take(&mut state.unreturned);
                return Ok(Received {
                    message: None,
                    credit: Some(OwedCredit { lane, granted }),
                });
            }
            return Ok(Received::default());
        }

        let message = std::mem::take(&mut state.partial).freeze();
        let credit_due = std::mem::take(&mut state.unreturned);
        if state.is_closing {
            self.lanes.remove(&lane);
        }
        let body = MessageBody::decode(message)?;
        Ok(Received {
            message: Some(IncomingMessage {
                lane,
                body,
                credit_due,
            }),
            credit: None,
        })
    }

    fn receive_abort(&mut self, lane: LaneId, closes_lane: bool) -> Received {
        if lane.number() > self.highest_opened {
            // A lane closed before it carried anything never opens.
            if closes_lane {
                self.highest_opened = lane.number();
            }
            return Received::default();
        }
        if closes_lane {
            self.lanes.remove(&lane);
            return Received::default();
        }
        let Some(state) = self.lanes.get_mut(&lane) else {
            return Received::default();
        };
        state.partial.clear();
        state.is_closing = false;
        let granted = std::mem::take(&mut state.unreturned);
        if granted == 0 {
            return Received::default();
        }
        Received {
            message: None,
            credit: Some(OwedCredit { lane, granted }),
        }
    }
}

/// Refuses a partial message whose JSON, or whose attachments so far, passed their cap, before
/// the rest of it is buffered.
fn check_partial_caps(partial: &[u8]) -> Result<(), FramingError> {
    let Some(prefix) = partial.first_chunk::<LENGTH_PREFIX_BYTES>() else {
        return Ok(());
    };
    let json_length = usize::try_from(u32::from_be_bytes(*prefix)).expect("a u32 fits a usize");
    check_cap(MessagePart::Json, json_length)?;
    let attachments_so_far = partial
        .len()
        .saturating_sub(LENGTH_PREFIX_BYTES + json_length);
    check_cap(MessagePart::Attachments, attachments_so_far)
}
