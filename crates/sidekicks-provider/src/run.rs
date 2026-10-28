//! A driver's own reports and requests to the run engine: the deliveries it hands over, the turn
//! ends and run state changes it reports, a turn the daemon or its provider starts on a session,
//! and a run's execution posture with the credential deny list every provider process is handed.

pub mod delivery;
pub mod posture;
pub mod start_request;
pub mod state_entry;
pub mod turn_end;
