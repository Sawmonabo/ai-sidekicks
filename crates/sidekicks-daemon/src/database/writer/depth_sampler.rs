//! The write queue's depth sampler: while the queue holds anything it samples the queue's depth
//! once a second, and at the alert depth it warns in the service log, naming the latest event
//! queued.

use std::time::Duration;

use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::session::id::SessionId;
use tokio::time::{Instant, Interval, MissedTickBehavior};

use crate::database::writer::WRITE_QUEUE_CAPACITY;
use crate::events::session::insert::SessionEventRow;

/// The queue's depth is sampled this often while it holds anything; at [`ALERT_DEPTH`] a warning
/// goes to the service log.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const ALERT_DEPTH: usize = 8_000;

/// Samples the write queue's depth while it holds anything; idle, it arms no timer.
#[derive(Default)]
pub(super) struct DepthSampler {
    interval: Option<Interval>,
    /// The session and category a warning names: the latest event queued.
    latest_event_tags: Option<EventTags>,
}

struct EventTags {
    session_id: SessionId,
    category: EventCategory,
}

impl DepthSampler {
    /// Keeps `event`, the latest queued, for a warning to name.
    pub(super) fn note_event(&mut self, event: &SessionEventRow) {
        self.latest_event_tags = Some(EventTags {
            session_id: event.session_id,
            category: event.category,
        });
    }

    /// Forgets the latest event once the queue has emptied.
    pub(super) fn forget_event(&mut self) {
        self.latest_event_tags = None;
    }

    /// Arms the sampling timer unless it runs already.
    pub(super) fn start(&mut self) {
        if self.interval.is_none() {
            let mut interval =
                tokio::time::interval_at(Instant::now() + SAMPLE_INTERVAL, SAMPLE_INTERVAL);
            interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
            self.interval = Some(interval);
        }
    }

    /// Disarms the sampling timer.
    pub(super) fn stop(&mut self) {
        self.interval = None;
    }

    /// Resolves at the next sample; never while the timer is disarmed.
    pub(super) async fn next_sample(&mut self) {
        match &mut self.interval {
            Some(interval) => {
                interval.tick().await;
            }
            None => std::future::pending().await,
        }
    }

    /// Warns when `depth`, the writes queued, in flight and waiting past the cap, is at the alert
    /// depth, and disarms the timer once it is 0.
    pub(super) fn sample(&mut self, depth: usize) {
        if depth >= ALERT_DEPTH {
            let tags = self.latest_event_tags.as_ref();
            tracing::warn!(
                session_id = tags.map(|tags| tracing::field::display(tags.session_id)),
                event_category = tags.map(|tags| tags.category.as_str()),
                depth,
                capacity = WRITE_QUEUE_CAPACITY,
                "persistence_backpressure: the write queue is nearly full"
            );
        }
        if depth == 0 {
            self.stop();
        }
    }
}
