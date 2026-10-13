//! Each session event type's category, as the record a TypeScript reader looks a type up in. Rust
//! reads a type's category from [`SessionEventType::category`].

use std::collections::BTreeMap;

use crate::event::registry::SessionEventType;
use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// Each registered session event type's category, keyed by the type's wire name.
    SESSION_EVENT_CATEGORY_RECORD = SessionEventType::ALL
        .iter()
        .map(|event_type| (*event_type, event_type.category()))
        .collect::<BTreeMap<_, _>>();
}

/// The TypeScript module of each session event type's category.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/type-categories",
    doc: "Each session event type's category, keyed by the type's wire name.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
