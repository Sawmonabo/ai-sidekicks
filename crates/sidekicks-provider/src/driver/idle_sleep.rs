//! What a driver tells the daemon's idle sleep about one session: the holds only the provider
//! keeps, which keep the session's process up, and where a sleep or a wake left the session.

use jiff::Timestamp;

/// The holds a session's provider keeps on it, read where the provider keeps them: the requests it
/// holds open on the person, a side question it runs, and the timed fires it keeps.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdleSleepHolds {
    /// The approvals and questions the provider holds open, each waiting on the person.
    pub open_requests: u32,
    /// Whether a side question runs on the session.
    pub is_side_question_running: bool,
    /// The timed fires the provider keeps for the session.
    pub schedules: Vec<KeptSchedule>,
}

/// One timed fire a provider keeps for a session: a fire it keeps only while its process lives,
/// which holds the session awake until it fires, or a recurring job a resume restores, which lets
/// the session sleep between its matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeptSchedule {
    /// A single fire the provider loses when its process stops.
    Once {
        /// When it fires.
        fires_at: Timestamp,
    },
    /// A job that fires on every match of its schedule until it is deleted or expires, restored
    /// when the session's conversation resumes.
    Recurring {
        /// The job's schedule, a five-field cron expression in the computer's local time.
        cron: String,
        /// When it fires next, where the provider said.
        next_fire_at: Option<Timestamp>,
    },
}

/// Where a sleep or a wake left a session: its provider's process up, or stopped with its
/// conversation kept for the next wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionSleepState {
    /// The session's process is up; a provider whose sessions never sleep always answers this.
    Awake,
    /// The session's process stopped, its conversation, account and inbox kept for its wake.
    Asleep,
}
