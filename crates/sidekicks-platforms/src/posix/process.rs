//! A process on macOS and Linux: its id as the system's calls take it, its exit awaited without
//! reaping it, a signal to its whole group, and its stop.

pub(crate) mod exit;
pub(crate) mod group;
pub(crate) mod id;
pub(crate) mod stop;
