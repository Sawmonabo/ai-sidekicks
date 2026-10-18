//! The receiving side of a connection's lanes: it reassembles each lane's messages from their
//! chunks, holds every lane to the credit it granted, and returns credit as messages are taken or
//! as owed credit is released; a lane is credited only when its CREDIT frame goes out. Beside lane
//! 0 the peer opens only lanes its owner admitted, so what a peer can make a receiver hold is lane
//! 0's window plus each admitted lane's.

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

/// Credit to return to the sender on one lane, sent as a CREDIT frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneCredit {
    /// The lane the credit is for.
    pub lane: LaneId,
    /// The bytes it returns.
    pub granted: u32,
}

impl From<LaneCredit> for Frame {
    fn from(credit: LaneCredit) -> Self {
        Self::Credit {
            lane: credit.lane,
            granted: credit.granted,
        }
    }
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
    /// Credit owed back and not yet released: a partial message's grant, which leaves the lane at
    /// no credit until released, and the bytes of dropped partial messages, which add to the lane's
    /// credit only once released.
    owed: u32,
    /// Whether the lane closes once the current message ends.
    is_closing: bool,
}

impl IncomingLane {
    fn new() -> Self {
        Self {
            outstanding_credit: INITIAL_LANE_CREDIT,
            partial: BytesMut::new(),
            unreturned: 0,
            owed: 0,
            is_closing: false,
        }
    }

    /// Adds `granted` to the lane's owed credit; answers whether the lane owed nothing before.
    fn owe(&mut self, granted: u32) -> bool {
        let was_clear = self.owed == 0;
        self.owed = self.owed.saturating_add(granted);
        was_clear
    }
}

/// Every lane the peer sends on, for one connection. Beside lane 0 the peer opens only lanes its
/// owner admitted, one per call whose answer opens a lane.
#[derive(Debug)]
pub struct IncomingLanes {
    /// The open lanes; a lane at or below `highest_opened` that is absent here has closed.
    lanes: HashMap<LaneId, IncomingLane>,
    /// The highest lane number the peer has opened.
    highest_opened: u32,
    /// Lanes the owner admitted that the peer has not opened yet.
    admitted: usize,
    /// Each lane holding owed credit, once.
    owing: Vec<LaneId>,
}

impl Default for IncomingLanes {
    fn default() -> Self {
        Self {
            lanes: HashMap::from([(LaneId::CONTROL, IncomingLane::new())]),
            highest_opened: 0,
            admitted: 0,
            owing: Vec::new(),
        }
    }
}

impl IncomingLanes {
    /// Applies one frame from the peer and answers the message it completed. A CREDIT frame is the
    /// outgoing side's, so it changes nothing here. Refuses data past a lane's credit or on a
    /// closed lane, a frame on a lane the owner never admitted, and a message whose lengths or caps
    /// are wrong.
    pub fn receive(&mut self, frame: Frame) -> Result<Option<IncomingMessage>, FramingError> {
        match frame {
            Frame::Data {
                lane,
                is_end,
                closes_lane,
                body,
            } => self.receive_data(lane, is_end, closes_lane, &body),
            Frame::Abort { lane, closes_lane } => {
                self.receive_abort(lane, closes_lane)?;
                Ok(None)
            }
            Frame::Credit { .. } => Ok(None),
        }
    }

    /// Admits one more lane the peer may open, for a call whose answer opens one. The owner admits
    /// it before it receives the frame after that answer, since the peer may open the lane at once;
    /// a frame on a lane not yet admitted is `LaneNotAdmitted`, which closes the connection.
    pub fn admit_lane(&mut self) {
        self.admitted += 1;
    }

    /// Credits every lane its owed credit and answers the credit to send, one per lane for the sum.
    pub fn release_owed(&mut self) -> Vec<LaneCredit> {
        let owing = std::mem::take(&mut self.owing);
        owing
            .into_iter()
            .filter_map(|lane| {
                let state = self.lanes.get_mut(&lane)?;
                let granted = std::mem::take(&mut state.owed);
                state.outstanding_credit = state.outstanding_credit.saturating_add(granted);
                Some(LaneCredit { lane, granted })
            })
            .collect()
    }

    /// The credit returning a taken message's bytes, or `None` once its lane has closed.
    pub fn take(&mut self, lane: LaneId, credit_due: u32) -> Option<LaneCredit> {
        let state = self.lanes.get_mut(&lane)?;
        state.outstanding_credit = state.outstanding_credit.saturating_add(credit_due);
        Some(LaneCredit {
            lane,
            granted: credit_due,
        })
    }

    /// Opens `lane` above every lane opened so far, spending one admission.
    fn open(&mut self, lane: LaneId) -> Result<(), FramingError> {
        if self.admitted == 0 {
            return Err(FramingError::LaneNotAdmitted {
                lane: lane.number(),
            });
        }
        // Lane 0 is always in the map and never counts against the limit.
        if self.lanes.len() > MAX_OPEN_LANES {
            return Err(FramingError::TooManyLanes {
                lane: lane.number(),
            });
        }
        self.admitted -= 1;
        self.highest_opened = lane.number();
        Ok(())
    }

    fn receive_data(
        &mut self,
        lane: LaneId,
        is_end: bool,
        closes_lane: bool,
        body: &[u8],
    ) -> Result<Option<IncomingMessage>, FramingError> {
        if lane.number() > self.highest_opened {
            self.open(lane)?;
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
                if state.owe(granted) {
                    self.owing.push(lane);
                }
            }
            return Ok(None);
        }

        let message = std::mem::take(&mut state.partial).freeze();
        let credit_due = std::mem::take(&mut state.unreturned);
        if state.is_closing {
            self.lanes.remove(&lane);
        }
        let body = MessageBody::decode(message)?;
        Ok(Some(IncomingMessage {
            lane,
            body,
            credit_due,
        }))
    }

    fn receive_abort(&mut self, lane: LaneId, closes_lane: bool) -> Result<(), FramingError> {
        if lane.number() > self.highest_opened {
            // A lane closed before it carried anything never opens, though closing it spends its
            // admission; an ABORT that leaves it open checks the admission without spending it.
            if self.admitted == 0 {
                return Err(FramingError::LaneNotAdmitted {
                    lane: lane.number(),
                });
            }
            if closes_lane {
                self.open(lane)?;
            }
            return Ok(());
        }
        if closes_lane {
            self.lanes.remove(&lane);
            return Ok(());
        }
        let Some(state) = self.lanes.get_mut(&lane) else {
            return Ok(());
        };
        state.partial.clear();
        state.is_closing = false;
        let granted = std::mem::take(&mut state.unreturned);
        if granted > 0 && state.owe(granted) {
            self.owing.push(lane);
        }
        Ok(())
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
