//! The computer-wide base folders a provider's administrator-managed settings sit under, named so
//! no caller holds a system path.

/// A computer-wide folder a program keeps its administrator-managed settings under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemFolderBase {
    /// `/etc` on macOS and Linux.
    Etc,
    /// The computer-wide `/Library/Application Support` on macOS.
    ApplicationSupport,
    /// The `Program Files` folder on Windows.
    ProgramFiles,
    /// The `ProgramData` folder on Windows.
    ProgramData,
}
