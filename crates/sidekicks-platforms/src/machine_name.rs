//! Why this machine's name, the one a person gave it, could not be read; each platform's module
//! reads the name the way that platform names the machine.

use std::io;

/// Why this machine's name could not be read.
#[derive(Debug, thiserror::Error)]
pub enum MachineNameError {
    /// The source could not be read: a file, a system call, or a program that failed to start or
    /// exited with a failure.
    #[error("this machine's name could not be read from {source_name}")]
    Read {
        /// What the name was read from.
        source_name: &'static str,
        /// The read's failure.
        #[source]
        source: io::Error,
    },
    /// The source answered an empty name; no other source is the name the person gave.
    #[error("this machine's name is empty in {source_name}")]
    Empty {
        /// What the name was read from.
        source_name: &'static str,
    },
}

/// `name`, read from `source_name`. Fails with [`MachineNameError::Empty`] when it is empty.
pub(crate) fn require_machine_name(
    name: String,
    source_name: &'static str,
) -> Result<String, MachineNameError> {
    if name.is_empty() {
        return Err(MachineNameError::Empty { source_name });
    }
    Ok(name)
}
