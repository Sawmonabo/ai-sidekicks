//! Why the machine's wakes from sleep cannot be heard; each platform's module hears them the way
//! that platform announces them.

use std::error::Error;

/// Why the machine's wakes from sleep cannot be heard, or stopped being heard.
#[derive(Debug, thiserror::Error)]
#[error("the machine's wakes from sleep cannot be heard through {source_name}")]
pub struct WakeWatchError {
    /// What announces the wakes on this platform.
    pub source_name: &'static str,
    /// The failure.
    #[source]
    pub source: Box<dyn Error + Send + Sync>,
}
