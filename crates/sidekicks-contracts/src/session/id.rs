//! The ids a session's contracts carry: the session and the person. The daemon and the control
//! plane mint version 7, and every one accepts any RFC 9562 UUID in either case.

use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::session::event_cursor::{EventCursor, START_OF_LOG_POSITION};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};

branded_uuid_id! {
    /// Identifies one session.
    SessionId
}

branded_uuid_id! {
    /// Identifies one person.
    UserId
}

ts_constants! {
    /// The refusal for an event cursor that names no position in its session's log.
    SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE = RefusalCode::SessionEventCursorUnresolvable;
    /// The log position before a session's first event, where a read of the whole log starts.
    START_OF_LOG_POSITION = START_OF_LOG_POSITION;
}

/// The module's TypeScript face; the event cursor's codec is hand-written TypeScript, so the
/// cursor's type and constants are written here.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/id",
    doc: "The ids a session's contracts carry: the session, the person, and the event cursor, \
          with the cursor's refusal code and the position before a session's first event.",
    definitions: &[
        Definition::read::<SessionId>().checked(),
        Definition::read::<UserId>(),
        Definition::read::<EventCursor>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
