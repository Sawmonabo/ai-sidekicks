//! The session rows other tables' tests build on: a session stored as the directory stores one.

use rusqlite::Connection;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};

/// When every test session was made and last active.
const SESSION_ROW_AT: &str = "2026-10-18T09:00:00.000Z";

/// Stores the session `session_id`, an active chat named `name` running in `place` (the place's
/// wire JSON), each `None` left unset.
pub fn insert_session_row(
    connection: &Connection,
    session_id: &str,
    name: Option<&str>,
    place: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO sessions (id, shape, state, name, place, created_at, updated_at, \
             last_activity_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)",
            rusqlite::params![
                session_id,
                <&'static str>::from(SessionShape::Chat),
                <&'static str>::from(SessionState::Active),
                name,
                place,
                SESSION_ROW_AT
            ],
        )
        .expect("the test stores a session");
}
