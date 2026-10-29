//! Whether a failure opens a run of failures or repeats one, so a retry loop logs the first failure
//! since its last success at warn and the rest at debug, and a failure that keeps recurring grows
//! the log once.

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether a failure came since the last success; starts with none.
#[derive(Debug, Default)]
pub struct FailureEpisode {
    has_failed: AtomicBool,
}

impl FailureEpisode {
    /// Records a failure and answers whether it is the first since the last success.
    pub fn is_first_failure(&self) -> bool {
        !self.has_failed.swap(true, Ordering::Relaxed)
    }

    /// Records a success, so the next failure is a first again.
    pub fn mark_succeeded(&self) {
        self.has_failed.store(false, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::FailureEpisode;

    #[test]
    fn only_the_first_failure_since_a_success_is_first() {
        let episode = FailureEpisode::default();
        assert!(episode.is_first_failure());
        assert!(!episode.is_first_failure(), "a repeat is no first");
        episode.mark_succeeded();
        assert!(episode.is_first_failure(), "a success opens a new episode");
    }
}
