//! The code signature a desktop client is admitted by. On macOS the desktop's client helper is
//! known by its signature, read from the connection; the other systems admit it by the session
//! token, so there no program meets the requirement.

#[cfg(not(target_os = "macos"))]
use std::convert::Infallible;
#[cfg(not(target_os = "macos"))]
use std::io;

#[cfg(not(target_os = "macos"))]
use crate::PinnedProcess;

/// Why the requirement a desktop client meets could not be built; the daemon does not start.
#[derive(Debug, thiserror::Error)]
pub enum CodeSignatureError {
    /// The system could not read this program's own signature.
    #[error("this program's own signature could not be read (status {status})")]
    OwnSignature {
        /// The Security framework's status code.
        status: i32,
    },
    /// The team in this program's signature holds characters a requirement cannot quote.
    #[error("the team in this program's signature is not one a requirement can name")]
    TeamIdentifier,
    /// A requirement's text did not compile.
    #[error("a code requirement did not compile (status {status})")]
    Compile {
        /// The Security framework's status code.
        status: i32,
    },
}

/// The signatures a desktop client meets: none on this system, which admits the desktop by the
/// session token, so no value of this type exists.
#[cfg(not(target_os = "macos"))]
pub struct DesktopClientRequirement {
    /// No value exists.
    never: Infallible,
}

#[cfg(not(target_os = "macos"))]
impl DesktopClientRequirement {
    /// No requirement: this system admits no program by its signature. Never fails.
    pub fn for_this_program(_app_identifier: &str) -> Result<Option<Self>, CodeSignatureError> {
        Ok(None)
    }

    /// Never answers, since no requirement exists on this system.
    pub fn admits(
        &self,
        _caller: &PinnedProcess,
        _responsible: &PinnedProcess,
    ) -> io::Result<bool> {
        match self.never {}
    }
}
