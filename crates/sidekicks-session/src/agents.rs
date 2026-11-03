//! A session's agents: its lead and every agent a run brought in, as a projection of
//! `session.created`, `agent.run.queued` and the provider-binding events, written in each event's
//! own write and rebuilt from the log; and the one switch each agent has pending, the daemon's own
//! column, which a rebuild keeps.

pub mod projection;
pub mod schema;
