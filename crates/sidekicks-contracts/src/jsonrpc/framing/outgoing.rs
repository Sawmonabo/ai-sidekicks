//! The sending side of a connection's lanes: it numbers the lanes this side opens and keeps the
//! credit the peer has granted on each, so no DATA passes it.

use std::collections::HashMap;

use super::INITIAL_LANE_CREDIT;
use super::frame::LaneId;

/// This side's lanes ran out of numbers, so the connection must be replaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("every lane number of this connection has been used")]
pub struct LanesExhausted;

/// Every lane this side sends on, for one connection.
#[derive(Debug)]
pub struct OutgoingLanes {
    /// The credit left on each open lane, in body bytes.
    credit: HashMap<LaneId, u32>,
    /// The number the next opened lane takes; `None` once every number is used.
    next_lane: Option<u32>,
}

impl Default for OutgoingLanes {
    fn default() -> Self {
        Self {
            credit: HashMap::from([(LaneId::CONTROL, INITIAL_LANE_CREDIT)]),
            next_lane: Some(1),
        }
    }
}

impl OutgoingLanes {
    /// Opens the next lane with its initial credit; numbers only increase, so none is reused.
    pub fn open(&mut self) -> Result<LaneId, LanesExhausted> {
        let number = self.next_lane.ok_or(LanesExhausted)?;
        self.next_lane = number.checked_add(1);
        let lane = LaneId::new(number);
        self.credit.insert(lane, INITIAL_LANE_CREDIT);
        Ok(lane)
    }

    /// The body bytes `lane` may still send; 0 for a lane that is not open.
    pub fn available(&self, lane: LaneId) -> u32 {
        self.credit.get(&lane).copied().unwrap_or(0)
    }

    /// Spends `length` body bytes of `lane`'s credit for a DATA frame; returns whether the credit
    /// covered it, spending nothing when it did not.
    pub fn spend(&mut self, lane: LaneId, length: u32) -> bool {
        match self.credit.get_mut(&lane) {
            Some(credit) if *credit >= length => {
                *credit -= length;
                true
            }
            Some(_) | None => false,
        }
    }

    /// Adds the peer's grant to `lane`; a grant for a lane not open is a race and is ignored.
    pub fn grant(&mut self, lane: LaneId, granted: u32) {
        if let Some(credit) = self.credit.get_mut(&lane) {
            *credit = credit.saturating_add(granted);
        }
    }

    /// Forgets `lane` once it closed; lane 0 never closes.
    pub fn close(&mut self, lane: LaneId) {
        if !lane.is_control() {
            self.credit.remove(&lane);
        }
    }
}
