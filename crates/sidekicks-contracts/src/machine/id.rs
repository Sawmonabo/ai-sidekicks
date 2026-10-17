//! The daemon-assigned id of the one machine a daemon runs on: minted at the daemon's first start
//! and read by everyone else as an opaque string.

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::branded_text;

/// The longest machine id, in code points.
pub const MACHINE_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The opaque, daemon-minted id of one machine's daemon.
    pub struct MachineId(1..=MACHINE_ID_MAX_LEN);
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "machine/id",
    doc: "The daemon-assigned id of the one machine a daemon runs on.",
    definitions: &[Definition::read::<MachineId>().checked()],
    constants: &[],
    method_tables: &[],
};
