//! A running process as the system knows it: its id, the boot it runs in, and the system's own
//! record of when it started. The system hands a freed id to a new process with a new start, and a
//! reboot changes the boot (on Windows, whose boot is one fixed word, the start is an instant no
//! later boot repeats), so two readings of one process are equal and a reading of any other
//! process is not, short of its id being reused within the start record's resolution (a
//! microsecond on macOS, a clock tick on Linux, 100 nanoseconds on Windows). The service reports
//! its own; a client that ends a service it found running reads that id again before each signal
//! and signals only on a match.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::BoundedText;

/// The longest boot id or start record a reply carries.
const PROCESS_IDENTITY_TEXT_MAX_LEN: usize = 128;

/// A process as the system knows it; two readings are of the same process exactly when equal.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    /// The operating-system process id.
    pub process_id: SafeInt<1>,
    /// The id of the boot the process runs in: Linux's boot id, macOS's boot session id; on Windows
    /// one fixed word, since Windows keeps no boot mark a change of the clock leaves alone.
    pub boot_id: BoundedText<1, PROCESS_IDENTITY_TEXT_MAX_LEN>,
    /// The system's own record of when the process started, as the system writes it: Linux's
    /// clock ticks since boot, macOS's start instant, Windows' creation time. Compared only for
    /// equality, never read as a time, so a change of the clock does not change it.
    pub process_start_time: BoundedText<1, PROCESS_IDENTITY_TEXT_MAX_LEN>,
}

/// The TypeScript module of a process's identity.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "process-identity",
    doc: "A running process as the system knows it: its id, the boot it runs in, and the system's \
          own record of when it started.",
    definitions: &[Definition::read::<ProcessIdentity>().checked()],
    constants: &[],
    method_tables: &[],
};
