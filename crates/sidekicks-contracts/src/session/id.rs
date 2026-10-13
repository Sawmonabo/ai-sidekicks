//! The ids a session's contracts carry: the session and the person. Every one accepts any RFC 9562
//! UUID in either case, since the daemon mints version 7 and the control plane's rows take
//! version 4.

use crate::internal::branded::branded_uuid_id;
use crate::session::event_cursor::EventCursor;
use crate::typescript::{Definition, TypeScriptModule};

branded_uuid_id! {
    /// Identifies one session.
    SessionId
}

branded_uuid_id! {
    /// Identifies one person.
    UserId
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/id",
    doc: "The ids a session's contracts carry: the session, the person, and the event cursor.",
    definitions: &[
        Definition::read::<SessionId>().checked(),
        Definition::read::<UserId>(),
        Definition::read::<EventCursor>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
