//! The daemon-assigned id of the one machine a daemon runs on: minted at the daemon's first start
//! and read by everyone else as an opaque string.

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::branded_text;

/// The longest node id, in code points.
pub const NODE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The opaque, daemon-minted id of one machine's daemon.
    pub struct NodeId(1..=NODE_ID_MAX_LEN);
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "runtime-node/id",
    doc: "The daemon-assigned id of the one machine a daemon runs on.",
    definitions: &[Definition::read::<NodeId>().checked()],
    constants: &[],
    method_tables: &[],
};
